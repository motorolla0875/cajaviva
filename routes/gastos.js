const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const mercadolibre = require('./mercadolibre');

const router = express.Router();

try { db.exec('ALTER TABLE gastos ADD COLUMN producto_id TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE gastos ADD COLUMN cantidad REAL'); } catch (e) {}

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

router.get('/', (req, res) => {
  const desde = req.query.desde || hoyISO(req.userId);
  const hasta = req.query.hasta || hoyISO(req.userId);
  const rows = db.prepare(`
    SELECT * FROM gastos
    WHERE user_id = ? AND fecha >= ? AND fecha <= ?
    ORDER BY fecha DESC, created_at DESC
  `).all(req.userId, desde, hasta);
  res.json(rows);
});

router.post('/', (req, res) => {
  if (req.esEmpleado && !db.tienePermiso(req, 'perm_gastos')) return res.status(403).json({ error: 'No tenés permiso para esto.' });
  const { descripcion, monto, fecha, proveedorId } = req.body || {};
  if (!descripcion || !descripcion.trim()) return res.status(400).json({ error: 'Falta la descripcion.' });
  const m = parseFloat(monto);
  if (isNaN(m) || m <= 0) return res.status(400).json({ error: 'El monto tiene que ser mayor a 0.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO gastos (id, user_id, proveedor_id, descripcion, monto, fecha, automatico)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(id, req.userId, proveedorId || null, descripcion.trim(), m,
         /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoyISO(req.userId));

  res.json({ id });
});

router.delete('/:id', (req, res) => {
  if (req.esEmpleado && !db.tienePermiso(req, 'perm_gastos')) return res.status(403).json({ error: 'No tenés permiso para esto.' });

  const g = db.prepare('SELECT * FROM gastos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!g) return res.status(404).json({ error: 'Gasto no encontrado.' });

  if (g.categoria === 'stock' && g.producto_id && g.cantidad) {
    const prod = db.prepare('SELECT id, stock FROM productos WHERE id = ? AND user_id = ?').get(g.producto_id, req.userId);
    if (prod) {
      const nuevoStock = prod.stock - g.cantidad;
      db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevoStock, prod.id);
      if (db.avisar) db.avisar(req.userId, 'productos');
      mercadolibre.actualizarStockMl(req.userId, prod.id, nuevoStock).catch(function () {});
    }
  }

  db.prepare('DELETE FROM gastos WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
