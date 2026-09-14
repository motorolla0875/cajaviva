const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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

// ── resumen de ventas de MercadoLibre, agrupado por producto ──
router.get('/ventas', (req, res) => {
  const filas = db.prepare(`
    SELECT vi.nombre, SUM(vi.cantidad) AS cantidad, COUNT(DISTINCT v.id) AS pedidos, SUM(vi.cantidad * vi.precio_unitario) AS total
    FROM venta_items vi
    JOIN ventas v ON v.id = vi.venta_id
    WHERE v.user_id = ? AND v.medio_pago = 'mercadolibre'
    GROUP BY vi.nombre
    ORDER BY cantidad DESC
  `).all(req.userId);

  const resumen = db.prepare(`
    SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS total
    FROM ventas WHERE user_id = ? AND medio_pago = 'mercadolibre'
  `).get(req.userId);

  // el detalle de cada pedido, para poder tocarlo y ver el mismo detalle que en Caja
  const ventas = db.prepare(`
    SELECT id, fecha, created_at, total FROM ventas
    WHERE user_id = ? AND medio_pago = 'mercadolibre'
    ORDER BY created_at DESC LIMIT 200
  `).all(req.userId);
  ventas.forEach((v) => {
    v.items = db.prepare('SELECT nombre, cantidad FROM venta_items WHERE venta_id = ?').all(v.id);
  });

  res.json({
    porProducto: filas.map((f) => ({ nombre: f.nombre, cantidad: f.cantidad, pedidos: f.pedidos, total: f.total })),
    totalPedidos: resumen.pedidos,
    totalVendido: resumen.total,
    ventas
  });
});

// ── reportes: tendencia, lo mas vendido, que comprar, que no se vende - todo solo de MercadoLibre ──
router.get('/reportes', (req, res) => {
  const dias = parseInt(req.query.dias) || 30;
  const hastaISO = new Date().toISOString().slice(0, 10);
  const desdeISO = new Date(Date.now() - (dias - 1) * 86400000).toISOString().slice(0, 10);
  const hastaAntISO = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const desdeAntISO = new Date(Date.now() - (dias * 2 - 1) * 86400000).toISOString().slice(0, 10);

  function resumenPeriodo(d, h) {
    const r = db.prepare(`
      SELECT COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS facturado, COALESCE(SUM(total - costo_total), 0) AS ganancia
      FROM ventas WHERE user_id = ? AND medio_pago = 'mercadolibre' AND fecha >= ? AND fecha <= ?
    `).get(req.userId, d, h);
    return { ventas: r.ventas, facturado: r.facturado, ganancia: r.ganancia, ticketProm: r.ventas > 0 ? r.facturado / r.ventas : 0 };
  }
  function variacion(a, b) {
    if (b === 0) return a > 0 ? 100 : 0;
    return Math.round(((a - b) / b) * 100);
  }
  const actual = resumenPeriodo(desdeISO, hastaISO);
  const anterior = resumenPeriodo(desdeAntISO, hastaAntISO);

  const porDiaFacturado = db.prepare(`
    SELECT fecha, COALESCE(SUM(total), 0) AS facturado FROM ventas
    WHERE user_id = ? AND medio_pago = 'mercadolibre' AND fecha >= ? AND fecha <= ?
    ORDER BY facturado DESC
  `).all(req.userId, desdeISO, hastaISO);
  const mejorDia = porDiaFacturado.length > 0 && porDiaFacturado[0].facturado > 0 ? porDiaFacturado[0] : null;

  const NOMBRES_DIA = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
  const porDiaSemana = [0, 0, 0, 0, 0, 0, 0];
  db.prepare(`
    SELECT fecha, total FROM ventas WHERE user_id = ? AND medio_pago = 'mercadolibre' AND fecha >= ? AND fecha <= ?
  `).all(req.userId, desdeISO, hastaISO).forEach((f) => { porDiaSemana[new Date(f.fecha + 'T12:00:00').getDay()] += f.total; });
  const diaSemanaTop = porDiaSemana.indexOf(Math.max.apply(null, porDiaSemana));
  const totalSemana = porDiaSemana.reduce((a, b) => a + b, 0);

  // serie completa dia por dia (con ceros en los dias sin venta), para el grafico de barras
  const porDiaRaw = db.prepare(`
    SELECT fecha, COUNT(*) AS pedidos, SUM(total) AS total
    FROM ventas
    WHERE user_id = ? AND medio_pago = 'mercadolibre' AND fecha >= date('now', '-' || ? || ' days')
    GROUP BY fecha
  `).all(req.userId, dias);
  const porFecha = {};
  porDiaRaw.forEach((f) => { porFecha[f.fecha] = f; });
  const porDia = [];
  for (let i = dias - 1; i >= 0; i--) {
    const fecha = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    porDia.push({ fecha, pedidos: (porFecha[fecha] && porFecha[fecha].pedidos) || 0, total: (porFecha[fecha] && porFecha[fecha].total) || 0 });
  }
  const totalPeriodo = porDia.reduce((s, d) => s + d.total, 0);

  const masVendido = db.prepare(`
    SELECT vi.nombre, SUM(vi.cantidad) AS unidades, COUNT(DISTINCT v.id) AS veces,
      SUM(vi.cantidad * vi.precio_unitario) AS facturado,
      SUM(vi.cantidad * (vi.precio_unitario - vi.costo_unitario)) AS ganancia
    FROM venta_items vi
    JOIN ventas v ON v.id = vi.venta_id
    WHERE v.user_id = ? AND v.medio_pago = 'mercadolibre' AND v.fecha >= date('now', '-' || ? || ' days')
    GROUP BY vi.nombre ORDER BY unidades DESC LIMIT 15
  `).all(req.userId, dias);

  // vinculados a MercadoLibre, con ventas en el periodo elegido y poco stock
  const queComprar = db.prepare(`
    SELECT p.nombre, p.stock, p.precio_costo,
      COALESCE((
        SELECT SUM(vi.cantidad) FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
        WHERE v.medio_pago = 'mercadolibre' AND vi.producto_id = p.id AND v.fecha >= date('now', '-' || ? || ' days')
      ), 0) AS vendidas
    FROM productos p
    WHERE p.user_id = ? AND p.ml_item_id IS NOT NULL AND p.activo = 1
    ORDER BY vendidas DESC, p.stock ASC
  `).all(dias, req.userId).filter((p) => p.vendidas > 0 && p.stock <= Math.max(3, p.vendidas))
    .map((p) => ({ nombre: p.nombre, stock: p.stock, vendidas: p.vendidas, sugerido: Math.max(1, p.vendidas * 2 - p.stock), costoEstimado: Math.max(1, p.vendidas * 2 - p.stock) * (p.precio_costo || 0) }));

  // vinculados a MercadoLibre que nunca tuvieron ninguna venta por ese canal
  const noSeVende = db.prepare(`
    SELECT p.nombre, p.stock, p.precio_venta FROM productos p
    WHERE p.user_id = ? AND p.ml_item_id IS NOT NULL AND p.activo = 1
      AND p.id NOT IN (
        SELECT vi.producto_id FROM venta_items vi
        JOIN ventas v ON v.id = vi.venta_id
        WHERE v.medio_pago = 'mercadolibre' AND vi.producto_id IS NOT NULL
      )
  `).all(req.userId);

  res.json({
    porDia, totalPeriodo, masVendido, queComprar, noSeVende,
    actual, variacion: { facturado: variacion(actual.facturado, anterior.facturado), ganancia: variacion(actual.ganancia, anterior.ganancia), ventas: variacion(actual.ventas, anterior.ventas) },
    mejorDia,
    diaSemanaTop: totalSemana > 0 ? { nombre: NOMBRES_DIA[diaSemanaTop], facturado: porDiaSemana[diaSemanaTop] } : null
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
  // hay que responder rapido (MercadoLibre reintenta si tardamos), el procesamiento real sigue despues
  res.sendStatus(200);
  procesarNotificacion(req.body).catch((e) => console.error('Error procesando aviso de MercadoLibre:', e.message));
});

async function procesarNotificacion(payload) {
  if (!payload || payload.topic !== 'orders_v2') return; // por ahora solo nos interesan las ventas

  const conexion = db.prepare('SELECT user_id FROM mercadolibre_conexion WHERE ml_user_id = ?').get(String(payload.user_id));
  if (!conexion) return; // no es de ningun comerciante nuestro
  const userId = conexion.user_id;

  const token = await obtenerTokenValido(userId);
  if (!token) return;

  const orderId = String(payload.resource || '').split('/').pop();
  if (!orderId) return;

  const rOrden = await fetch('https://api.mercadolibre.com/orders/' + orderId, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const orden = await rOrden.json();
  if (!rOrden.ok) { console.error('No se pudo traer la orden', orderId, orden); return; }

  if (orden.status !== 'paid') return; // solo procesamos ordenes ya pagas

  // evitar procesar la misma orden dos veces (MercadoLibre puede reenviar el aviso)
  const yaExiste = db.prepare('SELECT id FROM ventas WHERE ml_order_id = ?').get(String(orden.id));
  if (yaExiste) return;

  const lineas = [];
  let total = 0;
  let costoTotal = 0;
  let huboSinVincular = false;

  for (const oi of (orden.order_items || [])) {
    const prod = db.prepare('SELECT * FROM productos WHERE user_id = ? AND ml_item_id = ?').get(userId, oi.item.id);
    if (!prod) { huboSinVincular = true; continue; }
    const cantidad = oi.quantity;
    const precio = oi.unit_price;
    lineas.push({ prod, cantidad, precio, costo: prod.precio_costo || 0 });
    total += precio * cantidad;
    costoTotal += (prod.precio_costo || 0) * cantidad;
  }

  if (lineas.length === 0) {
    console.log('Orden de MercadoLibre', orden.id, 'no tenia ningun producto vinculado, se ignoro.');
    return;
  }

  const ventaId = uuidv4();
  const fechaVenta = new Date().toISOString().slice(0, 10);

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, ml_order_id)
    VALUES (?, ?, NULL, 'mostrador', ?, 'cobrada', ?, ?, 'mercadolibre', ?, 0, ?, ?)
  `).run(ventaId, userId, fechaVenta, total, costoTotal, total, 'Venta MercadoLibre #' + orden.id, String(orden.id));

  for (const l of lineas) {
    db.prepare(`
      INSERT INTO venta_items (id, venta_id, producto_id, variante_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(uuidv4(), ventaId, l.prod.id, l.prod.nombre, l.cantidad, l.precio, l.costo);

    if (!l.prod.es_servicio) {
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(l.cantidad, l.prod.id);
    }
  }

  if (db.avisar) {
    db.avisar(userId, 'productos');
    db.avisar(userId, 'venta_mercadolibre', {
      items: lineas.map(function (l) { return { nombre: l.prod.nombre, cantidad: l.cantidad }; }),
      total: total,
      ordenId: String(orden.id)
    });
  }
  console.log('Venta creada desde MercadoLibre:', ventaId, '- orden', orden.id);
  if (huboSinVincular) console.log('Aviso: la orden', orden.id, 'tenia productos sin vincular, se omitieron de la venta.');
}

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

// ── actualiza el stock de una publicacion en MercadoLibre, si el producto esta vinculado ──
// se llama sola cada vez que el stock de CajaViva cambia por una venta, reposicion, etc.
async function actualizarStockMl(userId, productoId, nuevoStock) {
  try {
    const conexion = db.prepare('SELECT id FROM mercadolibre_conexion WHERE user_id = ?').get(userId);
    if (!conexion) return; // este comerciante no tiene MercadoLibre conectado

    const prod = db.prepare('SELECT ml_item_id FROM productos WHERE id = ?').get(productoId);
    if (!prod || !prod.ml_item_id) return; // este producto no esta vinculado a ninguna publicacion

    const token = await obtenerTokenValido(userId);
    if (!token) return;

    const r = await fetch('https://api.mercadolibre.com/items/' + prod.ml_item_id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ available_quantity: Math.max(0, Math.round(nuevoStock)) })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      console.error('MercadoLibre rechazo la actualizacion de stock:', JSON.stringify(d));
    }
  } catch (e) {
    console.error('No se pudo actualizar el stock en MercadoLibre:', e.message);
  }
}

module.exports.manejarCallback = manejarCallback;
module.exports.actualizarStockMl = actualizarStockMl;
