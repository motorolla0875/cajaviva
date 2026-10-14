// Borrar la cuenta y todos sus datos (lo exigen Google Play y App Store).
const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();
const CARPETA_FOTOS = path.join(__dirname, '..', 'public', 'fotos');

// tablas "hijas" que no tienen user_id: se borran por su tabla madre
const HIJAS = [
  ['devolucion_items', 'devolucion_id', 'devoluciones'],
  ['reserva_extras', 'reserva_id', 'reservas'],
  ['pedido_web_items', 'pedido_id', 'pedidos_web'],
  ['receta_items', 'producto_id', 'productos'],
  ['producto_variantes', 'producto_id', 'productos'],
  ['venta_items', 'venta_id', 'ventas']
];

function existe(tabla) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tabla); }

function borrarTodo(userId) {
  // fotos que subió (se buscan antes de borrar los registros)
  const fotos = new Set();
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
    if (!cols.includes('user_id')) continue;
    for (const c of cols.filter(c => /foto|imagen|logo|banner/.test(c))) {
      for (const r of db.prepare('SELECT ' + c + ' AS f FROM ' + t + ' WHERE user_id = ?').all(userId)) {
        if (typeof r.f === 'string' && r.f.indexOf('/fotos/') !== -1) fotos.add(path.basename(r.f.split('?')[0]));
      }
    }
  }

  db.exec('BEGIN');
  try {
    for (const [hija, col, madre] of HIJAS) {
      if (existe(hija) && existe(madre)) db.prepare('DELETE FROM ' + hija + ' WHERE ' + col + ' IN (SELECT id FROM ' + madre + ' WHERE user_id = ?)').run(userId);
    }
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'users'").all().map(r => r.name);
    // varias pasadas, por si una tabla depende de otra
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      for (const t of tablas) {
        const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
        if (!cols.includes('user_id')) continue;
        try { db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(userId); } catch (e) { if (vuelta === 3) throw e; }
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  for (const f of fotos) { try { fs.unlinkSync(path.join(CARPETA_FOTOS, f)); } catch (e) {} }
}

// la cuenta tiene que confirmar con su contraseña (si tiene una)
router.post('/borrar', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede borrar la cuenta.' });
  const u = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.userId);
  if (!u) return res.status(404).json({ error: 'La cuenta no existe.' });
  const { password, confirmar } = req.body || {};
  if (confirmar !== 'BORRAR') return res.status(400).json({ error: 'Escribí BORRAR para confirmar.' });
  if (u.password_hash && !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    return res.status(401).json({ error: 'La contraseña no es correcta.' });
  }
  try {
    borrarTodo(u.id);
    console.log('[cuenta] Cuenta borrada:', u.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[cuenta] Error al borrar:', e.message);
    res.status(500).json({ error: 'No se pudo borrar la cuenta. Escribinos a dmith.builds@gmail.com.' });
  }
});

module.exports = router;
module.exports.borrarTodo = borrarTodo;
