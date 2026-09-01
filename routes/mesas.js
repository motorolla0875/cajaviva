const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

try { db.exec('ALTER TABLE negocio ADD COLUMN cap_mesas INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS mesas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nombre TEXT NOT NULL,
    orden INTEGER NOT NULL DEFAULT 0,
    activa INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mesa_consumo (
    id TEXT PRIMARY KEY,
    mesa_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    producto_id TEXT,
    nombre TEXT NOT NULL,
    cantidad REAL NOT NULL DEFAULT 1,
    precio_unitario REAL NOT NULL DEFAULT 0,
    costo_unitario REAL NOT NULL DEFAULT 0,
    abierta_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_consumo_mesa ON mesa_consumo(mesa_id);
`);

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

// ── todas las mesas con lo que llevan ──
router.get('/', (req, res) => {
  const mesas = db.prepare(
    'SELECT * FROM mesas WHERE user_id = ? AND activa = 1 ORDER BY orden, nombre'
  ).all(req.userId);

  mesas.forEach(function (m) {
    const items = db.prepare(
      'SELECT * FROM mesa_consumo WHERE mesa_id = ? ORDER BY created_at'
    ).all(m.id);

    m.items = items;
    m.total = items.reduce(function (a, i) { return a + i.cantidad * i.precio_unitario; }, 0);
    m.ocupada = items.length > 0;
    m.desde = items.length > 0 ? items[0].created_at : null;
  });

  res.json({ mesas: mesas });
});

// ── crear, renombrar, borrar ──
router.post('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Poné un nombre.' });

  const n = db.prepare('SELECT COUNT(*) AS c FROM mesas WHERE user_id = ? AND activa = 1').get(req.userId);
  const id = uuidv4();

  db.prepare('INSERT INTO mesas (id, user_id, nombre, orden) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, nombre, n.c);

  res.json({ id: id, nombre: nombre });
});

router.put('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Poné un nombre.' });

  db.prepare('UPDATE mesas SET nombre = ? WHERE id = ? AND user_id = ?')
    .run(nombre, req.params.id, req.userId);

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const items = db.prepare('SELECT COUNT(*) AS c FROM mesa_consumo WHERE mesa_id = ?').get(req.params.id);
  if (items.c > 0) return res.status(400).json({ error: 'Esa mesa tiene consumo. Cobrala primero.' });

  db.prepare('UPDATE mesas SET activa = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── crear varias de una ──
router.post('/varias', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const cuantas = parseInt(req.body?.cuantas) || 0;
  if (cuantas < 1 || cuantas > 60) return res.status(400).json({ error: 'Entre 1 y 60 mesas.' });

  const n = db.prepare('SELECT COUNT(*) AS c FROM mesas WHERE user_id = ? AND activa = 1').get(req.userId);

  const stmt = db.prepare('INSERT INTO mesas (id, user_id, nombre, orden) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= cuantas; i++) {
    stmt.run(uuidv4(), req.userId, 'Mesa ' + (n.c + i), n.c + i);
  }

  res.json({ ok: true, creadas: cuantas });
});

// ── sumar consumo a una mesa ──
router.post('/:id/agregar', (req, res) => {
  const m = db.prepare('SELECT id FROM mesas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Mesa no encontrada.' });

  const items = req.body?.items || [];
  if (items.length === 0) return res.status(400).json({ error: 'No hay nada para agregar.' });

  const stmt = db.prepare(`
    INSERT INTO mesa_consumo (id, mesa_id, user_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  items.forEach(function (i) {
    stmt.run(uuidv4(), m.id, req.userId, i.productoId || null, i.nombre,
             i.cantidad, i.precio, i.costo || 0);

    // descontar stock
    if (i.productoId) {
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ? AND user_id = ?')
        .run(i.cantidad, i.productoId, req.userId);
    }
  });

  res.json({ ok: true });
});

// ── sacar un item ──
router.delete('/item/:id', (req, res) => {
  const i = db.prepare('SELECT * FROM mesa_consumo WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!i) return res.status(404).json({ error: 'No encontrado.' });

  if (i.producto_id) {
    db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(i.cantidad, i.producto_id);
  }

  db.prepare('DELETE FROM mesa_consumo WHERE id = ?').run(i.id);
  res.json({ ok: true });
});

// ── pasar el consumo a otra mesa ──
router.post('/:id/mover', (req, res) => {
  const destino = req.body?.destino;
  if (!destino) return res.status(400).json({ error: 'Falta la mesa destino.' });

  const d = db.prepare('SELECT id FROM mesas WHERE id = ? AND user_id = ?').get(destino, req.userId);
  if (!d) return res.status(404).json({ error: 'Mesa destino no encontrada.' });

  db.prepare('UPDATE mesa_consumo SET mesa_id = ? WHERE mesa_id = ? AND user_id = ?')
    .run(destino, req.params.id, req.userId);

  res.json({ ok: true });
});

// ── cobrar la mesa ──
router.post('/:id/cobrar', (req, res) => {
  const m = db.prepare('SELECT * FROM mesas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!m) return res.status(404).json({ error: 'Mesa no encontrada.' });

  const items = db.prepare('SELECT * FROM mesa_consumo WHERE mesa_id = ?').all(m.id);
  if (items.length === 0) return res.status(400).json({ error: 'Esa mesa esta vacia.' });

  const bruto = items.reduce(function (a, i) { return a + i.cantidad * i.precio_unitario; }, 0);
  const total = req.body?.total != null ? parseFloat(req.body.total) : bruto;
  const costo = items.reduce(function (a, i) { return a + i.cantidad * (i.costo_unitario || 0); }, 0);

  const medio = req.body?.medioPago || 'efectivo';
  const clienteId = req.body?.clienteId || null;
  const ventaId = uuidv4();

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
    VALUES (?, ?, ?, 'mostrador', ?, 'cobrada', ?, ?, ?, ?, 0, ?, ?)
  `).run(ventaId, req.userId, clienteId, hoyISO(req.userId), total, costo,
         medio, medio === 'cuenta_corriente' ? 0 : total,
         m.nombre, req.empleadoId || null);

  const stmt = db.prepare(`
    INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  items.forEach(function (i) {
    stmt.run(uuidv4(), ventaId, i.producto_id, i.nombre, i.cantidad, i.precio_unitario, i.costo_unitario || 0);
  });

  // si es fiado, sumarlo a la cuenta
  if (medio === 'cuenta_corriente' && clienteId) {
    db.prepare('UPDATE clientes SET saldo = COALESCE(saldo,0) + ? WHERE id = ? AND user_id = ?')
      .run(total, clienteId, req.userId);
  }

  db.prepare('DELETE FROM mesa_consumo WHERE mesa_id = ?').run(m.id);

  res.json({ ventaId: ventaId, total: total, costo: costo });
});

module.exports = router;
