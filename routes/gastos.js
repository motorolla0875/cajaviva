const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function hoyISO() { return new Date().toISOString().slice(0, 10); }

router.get('/', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || hoyISO();
  const rows = db.prepare(`
    SELECT * FROM gastos
    WHERE user_id = ? AND fecha >= ? AND fecha <= ?
    ORDER BY fecha DESC, created_at DESC
  `).all(req.userId, desde, hasta);
  res.json(rows);
});

router.post('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  const { descripcion, monto, fecha, proveedorId } = req.body || {};
  if (!descripcion || !descripcion.trim()) return res.status(400).json({ error: 'Falta la descripcion.' });
  const m = parseFloat(monto);
  if (isNaN(m) || m <= 0) return res.status(400).json({ error: 'El monto tiene que ser mayor a 0.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO gastos (id, user_id, proveedor_id, descripcion, monto, fecha, automatico)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(id, req.userId, proveedorId || null, descripcion.trim(), m,
         /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoyISO());

  res.json({ id });
});

router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  db.prepare('DELETE FROM gastos WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
