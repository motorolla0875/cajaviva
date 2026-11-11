// Suscripción paga de CajaViva, cobrada por Google Play (y más adelante App Store) a través de RevenueCat.
//
// - La app (Android/iPhone) hace la compra con el plugin de RevenueCat, usando el id del usuario de CajaViva.
// - RevenueCat avisa a /api/pagos/revenuecat cada vez que algo cambia (compra, renovación, vencimiento).
// - Después de comprar, la app llama a /api/pagos/sincronizar para no esperar el aviso.
// En los dos casos le preguntamos a RevenueCat el estado real y completo, no confiamos en datos sueltos.
//
// Variables del .env: REVENUECAT_SECRET_KEY (clave secreta del proyecto de RevenueCat) y
// REVENUECAT_WEBHOOK_SECRET (el texto que se pone en el "Authorization header" del webhook).
const express = require('express');
const db = require('../db');

const router = express.Router();
const ENTITLEMENT = 'pro';

try { db.exec('ALTER TABLE users ADD COLUMN plan_base TEXT'); } catch (e) {}   // el plan que tenía antes de suscribirse

async function suscripcionActiva(userId) {
  const clave = process.env.REVENUECAT_SECRET_KEY;
  if (!clave) throw new Error('Falta REVENUECAT_SECRET_KEY en el servidor.');
  const r = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + clave }
  });
  if (!r.ok) throw new Error('RevenueCat respondió ' + r.status);
  const data = await r.json();
  const e = data && data.subscriber && data.subscriber.entitlements && data.subscriber.entitlements[ENTITLEMENT];
  if (!e) return false;
  return !e.expires_date || new Date(e.expires_date) > new Date();
}

/* ══ Mercado Pago: pago desde la web (cajaviva.app en el navegador) ══
   Solo se ofrece fuera de la app: dentro de Android/iPhone se paga con la tienda.
   Pago con link directo (Checkout Pro): no pide mail, vuelve solo a CajaViva y Mercado Pago avisa a /api/pagos/mp/webhook.
   Cada pago aprobado suma un mes o un año (mp_hasta). Unos días antes de vencer se avisa para renovar.
   (Quedó también el débito automático por si alguna cuenta lo usó.) */
for (const col of ['mp_preapproval TEXT', 'mp_estado TEXT', 'mp_ciclo TEXT', 'mp_hasta TEXT', 'mp_pagos TEXT', 'mp_email TEXT', 'mp_aviso TEXT']) {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) {}
}
const fs = require('fs');
function tokenMP() {
  if (process.env.MP_ACCESS_TOKEN) return process.env.MP_ACCESS_TOKEN;
  try { const m = fs.readFileSync('/root/tujuego.env', 'utf8').match(/^MP_ACCESS_TOKEN=(\S+)/m); return m ? m[1] : ''; } catch (e) { return ''; }
}
const MP = tokenMP();
const APP_URL = process.env.APP_URL || 'https://cajaviva.app';
const PLANES_MP = {
  mensual: { monto: +(process.env.MP_PRECIO_MENSUAL || 12000), meses: 1, nombre: 'CajaViva Pro mensual' },
  anual:   { monto: +(process.env.MP_PRECIO_ANUAL || 99990), meses: 12, nombre: 'CajaViva Pro anual' }
};
async function mp(ruta, metodo, cuerpo) {
  const r = await fetch((process.env.MP_API || 'https://api.mercadopago.com') + ruta, { method: metodo || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + MP, 'Content-Type': 'application/json' }, metodo === 'POST' ? { 'X-Idempotency-Key': require('crypto').randomUUID() } : {}),
    body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) { console.error('[mp]', metodo || 'GET', ruta, r.status, JSON.stringify(j).slice(0, 300)); const e = new Error('mp'); e.mp = j; throw e; }
  return j;
}
function mpVigente(u) { return !!(u && u.mp_hasta && new Date(u.mp_hasta) > new Date()); }

// vuelve a mirar en Mercado Pago la suscripción del usuario y ajusta el plan
async function verificarMP(userId) {
  if (MP) await buscarPagosMP(userId);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u || !u.mp_preapproval || !MP) { aplicar(userId, null); return u; }
  const pre = await mp('/preapproval/' + encodeURIComponent(u.mp_preapproval));
  if (String(pre.external_reference || '') !== 'cv:' + userId) return u;
  const ciclo = PLANES_MP[u.mp_ciclo] ? u.mp_ciclo : 'mensual';
  const pagos = JSON.parse(u.mp_pagos || '[]');
  let hasta = u.mp_hasta ? new Date(u.mp_hasta) : null;
  const cobros = await mp('/authorized_payments/search?preapproval_id=' + encodeURIComponent(u.mp_preapproval)).catch(function () { return { results: [] }; });
  const lista = (cobros.results || []).slice().sort(function (a, b) { return new Date(a.date_created || 0) - new Date(b.date_created || 0); });
  for (const c of lista) {
    const pago = c.payment || {};
    const ok = pago.status === 'approved' || (c.status === 'processed' && !pago.status);
    if (!ok || pagos.indexOf(String(c.id)) >= 0) continue;
    if (+c.transaction_amount && +c.transaction_amount < PLANES_MP[ciclo].monto * 0.9) { console.error('[mp] monto bajo', c.id); continue; }
    const desde = hasta && hasta > new Date() ? hasta : new Date();
    hasta = new Date(desde); hasta.setMonth(hasta.getMonth() + PLANES_MP[ciclo].meses); hasta.setDate(hasta.getDate() + 2); // 2 días de margen para el próximo cobro
    pagos.push(String(c.id));
    console.log('[mp] cobro aprobado ' + c.id + ' → usuario ' + userId + ' activo hasta ' + hasta.toISOString());
  }
  db.prepare('UPDATE users SET mp_estado = ?, mp_hasta = ?, mp_pagos = ? WHERE id = ?')
    .run(pre.status || u.mp_estado, hasta ? hasta.toISOString() : null, JSON.stringify(pagos.slice(-60)), userId);
  aplicar(userId, null);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

// un pago único aprobado: suma el período al usuario (una sola vez por pago)
function aplicarPagoMP(pago) {
  const m = String(pago.external_reference || '').match(/^cv:([^:]+):(mensual|anual)$/);
  if (!m || pago.status !== 'approved') return false;
  const userId = m[1], ciclo = m[2];
  const u = db.prepare('SELECT mp_hasta, mp_pagos, mp_email FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  const pagos = JSON.parse(u.mp_pagos || '[]');
  if (pagos.indexOf(String(pago.id)) >= 0) return false;
  if (+pago.transaction_amount < PLANES_MP[ciclo].monto * 0.9) { console.error('[mp] monto bajo', pago.id); return false; }
  const ahora = new Date(), antes = u.mp_hasta ? new Date(u.mp_hasta) : null;
  const hasta = new Date(antes && antes > ahora ? antes : ahora);
  hasta.setMonth(hasta.getMonth() + PLANES_MP[ciclo].meses);
  pagos.push(String(pago.id));
  const email = (pago.payer && pago.payer.email) || u.mp_email || null;
  db.prepare('UPDATE users SET mp_hasta = ?, mp_pagos = ?, mp_ciclo = ?, mp_email = ?, mp_aviso = NULL WHERE id = ?')
    .run(hasta.toISOString(), JSON.stringify(pagos.slice(-60)), ciclo, email, userId);
  aplicar(userId, null);
  console.log('[mp] pago ' + pago.id + ' aprobado → usuario ' + userId + ' activo hasta ' + hasta.toISOString());
  return true;
}
// busca en Mercado Pago los pagos del usuario (por si el aviso no llegó)
async function buscarPagosMP(userId) {
  for (const ciclo of ['mensual', 'anual']) {
    const r = await mp('/v1/payments/search?sort=date_created&criteria=desc&limit=20&external_reference=' + encodeURIComponent('cv:' + userId + ':' + ciclo)).catch(function () { return { results: [] }; });
    for (const p of (r.results || [])) aplicarPagoMP(p);
  }
}

// pone el plan según la tienda (activa = true/false) y Mercado Pago; activa = null: solo recalcula con Mercado Pago
function aplicar(userId, activaTienda) {
  const u = db.prepare('SELECT plan, plan_base, mp_hasta FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const activa = activaTienda === true || mpVigente(u);
  if (activaTienda === null && !mpVigente(u) && u.plan === 'pro') {
    // venció lo de Mercado Pago: solo se baja si la tienda tampoco lo tiene activo (se revisa en /sincronizar)
    suscripcionActiva(userId).then(function (rc) { aplicar(userId, rc); }).catch(function () {});
    return u.plan;
  }
  if (activa && u.plan !== 'pro') {
    db.prepare("UPDATE users SET plan_base = ?, plan = 'pro' WHERE id = ?").run(u.plan || 'prueba', userId);
    return 'pro';
  }
  if (!activa && u.plan === 'pro') {
    const vuelve = u.plan_base && u.plan_base !== 'pro' ? u.plan_base : 'prueba';
    db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(vuelve, userId);
    return vuelve;
  }
  return u.plan;
}

// aviso de RevenueCat
router.post('/revenuecat', async (req, res) => {
  const secreto = process.env.REVENUECAT_WEBHOOK_SECRET;
  const recibido = String(req.headers.authorization || '').trim().replace(/^Bearer\s+/i, '');
  if (!secreto || recibido !== secreto) return res.status(401).json({ error: 'No autorizado.' });
  const ev = req.body && req.body.event;
  const ids = [ev && ev.app_user_id].concat((ev && ev.aliases) || []).filter(Boolean);
  try {
    for (const id of new Set(ids)) {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
      const plan = aplicar(id, await suscripcionActiva(id));
      console.log('[pagos] ' + (ev.type || 'aviso') + ' → usuario ' + id + ' queda en plan ' + plan);
    }
  } catch (e) { console.error('[pagos] Error en aviso de RevenueCat:', e.message); }
  res.json({ ok: true });   // siempre OK, para que RevenueCat no reintente sin fin
});

// después de comprar o restaurar desde la app (necesita sesión del dueño)
router.post('/sincronizar', async (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  try {
    const plan = aplicar(req.userId, await suscripcionActiva(req.userId));
    res.json({ ok: true, plan: plan, plan_info: db.estadoPlan(req.userId) });
  } catch (e) {
    console.error('[pagos] No se pudo sincronizar:', e.message);
    res.status(502).json({ error: 'No pudimos confirmar la suscripción. Probá de nuevo en un ratito.' });
  }
});

// ── rutas de Mercado Pago (solo web) ──
function estadoMP(userId) {
  const u = db.prepare('SELECT mp_preapproval, mp_estado, mp_ciclo, mp_hasta, mp_email FROM users WHERE id = ?').get(userId) || {};
  return { disponible: !!MP, precios: { mensual: PLANES_MP.mensual.monto, anual: PLANES_MP.anual.monto },
    activo: mpVigente(u), debito: u.mp_estado === 'authorized', ciclo: u.mp_ciclo || null, hasta: u.mp_hasta || null, email: u.mp_email || null };
}
router.get('/mp', function (req, res) {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  res.json(estadoMP(req.userId));
});
router.post('/mp/pagar', async function (req, res) {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  if (!MP) return res.status(503).json({ error: 'El pago con Mercado Pago todavía no está disponible.' });
  const ciclo = PLANES_MP[req.body && req.body.ciclo] ? req.body.ciclo : 'mensual', pl = PLANES_MP[ciclo];
  try {
    const pref = await mp('/checkout/preferences', 'POST', {
      items: [{ id: 'cajaviva-' + ciclo, title: pl.nombre, quantity: 1, unit_price: pl.monto, currency_id: 'ARS' }],
      external_reference: 'cv:' + req.userId + ':' + ciclo,
      back_urls: { success: APP_URL + '/?mp=volvio', pending: APP_URL + '/?mp=volvio', failure: APP_URL + '/?mp=fallo' },
      auto_return: 'approved',
      notification_url: APP_URL + '/api/pagos/mp/webhook',
      statement_descriptor: 'CAJAVIVA'
    });
    res.json({ init_point: pref.init_point });
  } catch (e) { res.status(400).json({ error: 'No pudimos abrir Mercado Pago. Probá de nuevo en un ratito.' }); }
});
// aviso de Mercado Pago (sin sesión): se vuelve a pedir el pago a Mercado Pago, no se confía en lo que llega
router.post('/mp/webhook', async function (req, res) {
  res.json({ ok: true });
  const tipo = (req.body && (req.body.type || req.body.topic)) || req.query.type || req.query.topic;
  const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'] || req.query.id;
  if (!MP || !id || (tipo !== 'payment' && tipo !== 'merchant_order')) return;
  try {
    if (tipo === 'payment') aplicarPagoMP(await mp('/v1/payments/' + encodeURIComponent(id)));
  } catch (e) {}
});
router.post('/mp/crear', async function (req, res) {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  if (!MP) return res.status(503).json({ error: 'El pago con Mercado Pago todavía no está disponible.' });
  const ciclo = PLANES_MP[req.body && req.body.ciclo] ? req.body.ciclo : 'mensual';
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Escribí el mail de tu cuenta de Mercado Pago.' });
  const u = db.prepare('SELECT mp_estado, mp_hasta, mp_preapproval FROM users WHERE id = ?').get(req.userId) || {};
  if (u.mp_estado === 'authorized' && mpVigente(u)) return res.status(400).json({ error: 'Ya tenés el débito automático activo.' });
  try {
    if (u.mp_preapproval && u.mp_estado === 'pending') { try { await mp('/preapproval/' + u.mp_preapproval, 'PUT', { status: 'cancelled' }); } catch (e) {} }
    const pl = PLANES_MP[ciclo];
    const pre = await mp('/preapproval', 'POST', { reason: pl.nombre, external_reference: 'cv:' + req.userId, payer_email: email,
      auto_recurring: { frequency: pl.meses, frequency_type: 'months', transaction_amount: pl.monto, currency_id: 'ARS' },
      back_url: APP_URL + '/?mp=volvio', status: 'pending' });
    db.prepare('UPDATE users SET mp_preapproval = ?, mp_estado = ?, mp_ciclo = ?, mp_email = ? WHERE id = ?').run(pre.id, pre.status, ciclo, email, req.userId);
    res.json({ init_point: pre.init_point });
  } catch (e) { res.status(400).json({ error: 'Mercado Pago no aceptó el pedido. Revisá que el mail sea el de tu cuenta de Mercado Pago.' }); }
});
router.post('/mp/verificar', async function (req, res) {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  try { await verificarMP(req.userId); } catch (e) {}
  res.json({ mp: estadoMP(req.userId), plan_info: db.estadoPlan(req.userId) });
});
router.post('/mp/baja', async function (req, res) {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño de la cuenta puede manejar la suscripción.' });
  const u = db.prepare('SELECT mp_preapproval, mp_estado FROM users WHERE id = ?').get(req.userId) || {};
  if (!u.mp_preapproval) return res.status(400).json({ error: 'No tenés débito automático con Mercado Pago.' });
  try { if (u.mp_estado !== 'cancelled') await mp('/preapproval/' + u.mp_preapproval, 'PUT', { status: 'cancelled' }); }
  catch (e) { return res.status(400).json({ error: 'No pudimos dar de baja en Mercado Pago. Probá en un rato.' }); }
  db.prepare("UPDATE users SET mp_estado = 'cancelled' WHERE id = ?").run(req.userId);
  res.json({ mp: estadoMP(req.userId), plan_info: db.estadoPlan(req.userId) });
});

// cada 6 horas: revisa a quienes pagan con Mercado Pago (cobros nuevos o vencimientos)
const { mandar, envolver } = require('../mail');
async function revisarTodos() {
  const lista = db.prepare("SELECT id FROM users WHERE mp_hasta IS NOT NULL OR (mp_preapproval IS NOT NULL AND (mp_estado = 'authorized' OR plan = 'pro'))").all();
  for (const u of lista) { try { await verificarMP(u.id); } catch (e) {} }
  // aviso por mail 3 días antes de que venza lo pagado con link (una vez por vencimiento)
  const pronto = new Date(Date.now() + 3 * 864e5).toISOString(), ahora = new Date().toISOString();
  const avisar = db.prepare("SELECT id, mp_email, mp_hasta, mp_ciclo FROM users WHERE mp_hasta > ? AND mp_hasta < ? AND mp_email IS NOT NULL AND (mp_aviso IS NULL OR mp_aviso != mp_hasta) AND (mp_estado IS NULL OR mp_estado != 'authorized')").all(ahora, pronto);
  for (const u of avisar) {
    const f = new Date(u.mp_hasta).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
    await mandar(u.mp_email, 'Tu plan de CajaViva vence el ' + f, envolver('Tu plan vence el ' + f,
      '<p style="font-size:15px;line-height:1.55;">Para seguir usando CajaViva con todas las funciones, renová tu plan antes de esa fecha. Lo que cargaste queda guardado.</p>' +
      '<p style="margin:24px 0;"><a href="' + APP_URL + '/?renovar=1" style="background:#1E7A5A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-size:15px;display:inline-block;">Renovar mi plan</a></p>' +
      '<p style="font-size:13.5px;color:#6B7975;">Entrá con tu usuario, tocá "Renovar" y pagás con Mercado Pago.</p>'));
    db.prepare('UPDATE users SET mp_aviso = mp_hasta WHERE id = ?').run(u.id);
  }
}
if (MP) { setInterval(function () { revisarTodos().catch(function () {}); }, 6 * 3600 * 1000); setTimeout(function () { revisarTodos().catch(function () {}); }, 60 * 1000); }

module.exports = router;
module.exports.verificarMP = verificarMP;
