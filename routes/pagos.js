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

// pone el plan según lo que diga RevenueCat; devuelve el plan final
function aplicar(userId, activa) {
  const u = db.prepare('SELECT plan, plan_base FROM users WHERE id = ?').get(userId);
  if (!u) return null;
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

module.exports = router;
