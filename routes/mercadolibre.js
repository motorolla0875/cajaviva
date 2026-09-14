const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const SECRETO = process.env.JWT_SECRET || 'cajaviva-cambiar-esto-en-produccion';
const ML_CLIENT_ID = process.env.MELI_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const ML_REDIRECT_URI = 'https://cajaviva.app/mercadolibre/callback';

// ── consigue un access_token valido para este usuario, renovandolo con el
//    refresh_token si esta vencido o le queda poco (asi no hace falta acordarse
//    de esto en cada lugar que hable con la API de MercadoLibre) ──
async function obtenerTokenValido(userId) {
  const c = db.prepare('SELECT * FROM mercadolibre_conexion WHERE user_id = ?').get(userId);
  if (!c) return null;

  const faltaPoco = new Date(c.expira_en).getTime() - Date.now() < 5 * 60 * 1000; // menos de 5 min
  if (!faltaPoco) return c.access_token;

  const r = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: c.refresh_token
    })
  });
  const datos = await r.json();
  if (!r.ok) {
    // si el refresh token ya no sirve, se borra la conexion para que el comerciante
    // se de cuenta (en "estado" va a ver que no esta mas conectado) y vuelva a autorizar
    if (r.status === 400 || r.status === 401) db.prepare('DELETE FROM mercadolibre_conexion WHERE user_id = ?').run(userId);
    throw new Error(datos.message || 'No se pudo renovar la conexion con MercadoLibre.');
  }

  const expiraEn = new Date(Date.now() + datos.expires_in * 1000).toISOString();
  db.prepare('UPDATE mercadolibre_conexion SET access_token = ?, refresh_token = ?, expira_en = ? WHERE user_id = ?')
    .run(datos.access_token, datos.refresh_token, expiraEn, userId);

  return datos.access_token;
}

// ── el comerciante toca "Conectar MercadoLibre": lo mandamos a autorizar ──
router.get('/conectar', (req, res) => {
  if (!ML_CLIENT_ID) return res.status(500).json({ error: 'Falta configurar MELI_CLIENT_ID en el servidor.' });

  // un "state" firmado y de corta duracion, para saber a que usuario de CajaViva
  // corresponde la autorizacion cuando MercadoLibre nos redirija de vuelta
  const state = jwt.sign({ uid: req.userId }, SECRETO, { expiresIn: '10m' });

  const url = 'https://auth.mercadolibre.com.ar/authorization'
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(ML_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(ML_REDIRECT_URI)
    + '&state=' + encodeURIComponent(state);

  res.json({ url });
});

// ── estado de la conexion, para mostrar en la pantalla de configuracion ──
router.get('/estado', (req, res) => {
  const c = db.prepare('SELECT ml_nickname, conectado_en FROM mercadolibre_conexion WHERE user_id = ?').get(req.userId);
  res.json({
    conectado: !!c,
    nickname: c ? c.ml_nickname : null,
    conectadoEn: c ? c.conectado_en : null
  });
});

// ── trae las publicaciones activas del vendedor, para elegir cual vincular a que producto ──
router.get('/publicaciones', async (req, res) => {
  try {
    const c = db.prepare('SELECT ml_user_id FROM mercadolibre_conexion WHERE user_id = ?').get(req.userId);
    if (!c) return res.status(400).json({ error: 'Todavia no conectaste tu cuenta de MercadoLibre.' });

    const token = await obtenerTokenValido(req.userId);

    // 1) los IDs de todas las publicaciones activas (hasta 100 por pagina)
    const rBusqueda = await fetch(
      `https://api.mercadolibre.com/users/${c.ml_user_id}/items/search?status=active&limit=100`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const busqueda = await rBusqueda.json();
    if (!rBusqueda.ok) throw new Error(busqueda.message || 'MercadoLibre no devolvio las publicaciones.');
    const ids = busqueda.results || [];
    if (ids.length === 0) return res.json({ publicaciones: [] });

    // 2) el detalle de cada una, de a 20 por pedido (limite de la API)
    const publicaciones = [];
    for (let i = 0; i < ids.length; i += 20) {
      const tanda = ids.slice(i, i + 20);
      const rDet = await fetch(
        `https://api.mercadolibre.com/items?ids=${tanda.join(',')}&attributes=id,title,price,available_quantity,thumbnail,variations`,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      const det = await rDet.json();
      det.forEach((it) => {
        if (it.code === 200) publicaciones.push(it.body);
      });
    }

    // ya vinculados, para que el frontend los marque
    const vinculados = db.prepare('SELECT id, ml_item_id FROM productos WHERE user_id = ? AND ml_item_id IS NOT NULL').all(req.userId);
    const vinculadosPorItem = {};
    vinculados.forEach((p) => { vinculadosPorItem[p.ml_item_id] = p.id; });

    res.json({
      publicaciones: publicaciones.map((p) => ({
        id: p.id,
        titulo: p.title,
        precio: p.price,
        stock: p.available_quantity,
        foto: p.thumbnail,
        tieneVariantes: (p.variations || []).length > 0,
        productoVinculado: vinculadosPorItem[p.id] || null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── desconectar la cuenta ──
router.post('/desconectar', (req, res) => {
  db.prepare('DELETE FROM mercadolibre_conexion WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

// ── MercadoLibre nos avisa cosas aca (venta nueva, cambio en una publicacion, etc.) ──
router.post('/webhook', (req, res) => {
  console.log('Aviso de MercadoLibre:', JSON.stringify(req.body));
  res.sendStatus(200);
});

// ── vincular un producto de CajaViva con una publicacion de MercadoLibre ──
router.post('/vincular', (req, res) => {
  const { productoId, mlItemId } = req.body || {};
  if (!productoId || !mlItemId) return res.status(400).json({ error: 'Falta el producto o la publicacion.' });

  const p = db.prepare('SELECT id FROM productos WHERE id = ? AND user_id = ?').get(productoId, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  db.prepare('UPDATE productos SET ml_item_id = ? WHERE id = ?').run(mlItemId, productoId);
  res.json({ ok: true });
});

// ── desvincular ──
router.post('/desvincular', (req, res) => {
  const { productoId } = req.body || {};
  db.prepare('UPDATE productos SET ml_item_id = NULL WHERE id = ? AND user_id = ?').run(productoId, req.userId);
  res.json({ ok: true });
});

module.exports = router;


// ── funciones que se usan desde server.js, sin pasar por requiereAuth ──
// (el callback lo visita el navegador del comerciante directo desde MercadoLibre,
// sin el token de sesion de CajaViva; y el webhook lo llama MercadoLibre, no una persona)

async function manejarCallback(req, res) {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Falta el codigo de autorizacion.');

  let userId;
  try {
    userId = jwt.verify(state, SECRETO).uid;
  } catch (e) {
    return res.status(400).send('El enlace de autorizacion vencio o no es valido. Volve a intentar conectar desde CajaViva.');
  }

  try {
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        code: code,
        redirect_uri: ML_REDIRECT_URI
      })
    });
    const datos = await r.json();
    if (!r.ok) throw new Error(datos.message || 'MercadoLibre rechazo la conexion.');

    const expiraEn = new Date(Date.now() + datos.expires_in * 1000).toISOString();

    const existente = db.prepare('SELECT id FROM mercadolibre_conexion WHERE user_id = ?').get(userId);
    if (existente) {
      db.prepare(`
        UPDATE mercadolibre_conexion SET
          ml_user_id = ?, access_token = ?, refresh_token = ?, expira_en = ?, conectado_en = datetime('now')
        WHERE user_id = ?
      `).run(String(datos.user_id), datos.access_token, datos.refresh_token, expiraEn, userId);
    } else {
      db.prepare(`
        INSERT INTO mercadolibre_conexion (id, user_id, ml_user_id, access_token, refresh_token, expira_en)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), userId, String(datos.user_id), datos.access_token, datos.refresh_token, expiraEn);
    }

    // traemos el nickname para mostrarlo lindo en la pantalla de configuracion
    try {
      const ru = await fetch('https://api.mercadolibre.com/users/' + datos.user_id, {
        headers: { Authorization: 'Bearer ' + datos.access_token }
      });
      const du = await ru.json();
      if (du && du.nickname) {
        db.prepare('UPDATE mercadolibre_conexion SET ml_nickname = ? WHERE user_id = ?').run(du.nickname, userId);
      }
    } catch (e) {}

    res.redirect('https://cajaviva.app/?ml=conectado');
  } catch (e) {
    res.status(500).send('No se pudo completar la conexion: ' + e.message);
  }
}

module.exports.manejarCallback = manejarCallback;
