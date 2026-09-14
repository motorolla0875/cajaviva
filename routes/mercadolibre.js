const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const SECRETO = process.env.JWT_SECRET || 'cajaviva-cambiar-esto-en-produccion';
const ML_CLIENT_ID = process.env.MELI_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.MELI_CLIENT_SECRET;
const ML_REDIRECT_URI = 'https://cajaviva.app/mercadolibre/callback';

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
