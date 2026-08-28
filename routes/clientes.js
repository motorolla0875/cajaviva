const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

// ── listar clientes ──
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM clientes WHERE user_id = ? ORDER BY nombre
  `).all(req.userId);
  res.json(rows);
});

// ── crear cliente ──
router.post('/', (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO clientes (id, user_id, nombre, whatsapp, direccion, notas)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, nombre.trim(), whatsapp || null, direccion || null, notas || null);

  res.json({ id });
});

// ── editar cliente ──
router.put('/:id', (req, res) => {
  const { nombre, whatsapp, direccion, notas } = req.body || {};
  const c = db.prepare('SELECT id FROM clientes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });

  db.prepare(`
    UPDATE clientes SET nombre = ?, whatsapp = ?, direccion = ?, notas = ?
    WHERE id = ? AND user_id = ?
  `).run(nombre.trim(), whatsapp || null, direccion || null, notas || null, req.params.id, req.userId);

  res.json({ ok: true });
});

// ── borrar cliente ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  const c = db.prepare('SELECT saldo FROM clientes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  if (c.saldo > 0) return res.status(400).json({ error: 'Este cliente todavia debe plata. Saldá la cuenta antes de borrarlo.' });

  db.prepare('DELETE FROM clientes WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── cuenta corriente: ventas fiadas y pagos ──
router.get('/:id/cuenta', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const ventas = db.prepare(`
    SELECT id, fecha, total, monto_pagado, created_at
    FROM ventas
    WHERE cliente_id = ? AND user_id = ? AND monto_pagado < total
    ORDER BY created_at DESC
  `).all(req.params.id, req.userId);

  for (const v of ventas) {
    v.items = db.prepare('SELECT nombre, cantidad, precio_unitario FROM venta_items WHERE venta_id = ?').all(v.id);
    v.deuda = v.total - v.monto_pagado;
  }

  const pagos = db.prepare(`
    SELECT * FROM pagos_cliente WHERE cliente_id = ? AND user_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id, req.userId);

  res.json({ cliente, ventas, pagos });
});

// ── registrar un pago o una devolucion ──
router.post('/:id/pagos', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const monto = parseFloat(req.body?.monto);
  if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'El monto tiene que ser mayor a 0.' });

  const tipo = req.body?.tipo === 'devolucion' ? 'devolucion' : 'pago';
  const signo = tipo === 'pago' ? -1 : 1;

  db.prepare(`
    INSERT INTO pagos_cliente (id, user_id, cliente_id, monto, fecha, nota, tipo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), req.userId, req.params.id, monto, req.body?.fecha || hoyISO(req.userId),
         req.body?.nota || null, tipo);

  db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ?').run(signo * monto, req.params.id);

  const actualizado = db.prepare('SELECT saldo FROM clientes WHERE id = ?').get(req.params.id);
  res.json({ ok: true, saldo: actualizado.saldo });
});

// ── borrar un pago (por si se cargó mal) ──
router.delete('/:id/pagos/:pagoId', (req, res) => {
  const pago = db.prepare('SELECT * FROM pagos_cliente WHERE id = ? AND user_id = ?').get(req.params.pagoId, req.userId);
  if (!pago) return res.status(404).json({ error: 'Pago no encontrado.' });

  const signo = pago.tipo === 'pago' ? 1 : -1;
  db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ?').run(signo * pago.monto, pago.cliente_id);
  db.prepare('DELETE FROM pagos_cliente WHERE id = ?').run(pago.id);

  res.json({ ok: true });
});

module.exports = router;
