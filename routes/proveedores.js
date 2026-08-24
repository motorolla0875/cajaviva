const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ── listar con lo que se le compro ──
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT COALESCE(SUM(g.monto), 0) FROM gastos g WHERE g.proveedor_id = p.id) AS total_comprado,
      (SELECT COUNT(*) FROM gastos g WHERE g.proveedor_id = p.id) AS compras
    FROM proveedores p
    WHERE p.user_id = ?
    ORDER BY p.nombre
  `).all(req.userId);
  res.json(rows);
});

// ── crear ──
router.post('/', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre al proveedor.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO proveedores (id, user_id, nombre, whatsapp, notas)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.userId, nombre, req.body?.whatsapp || null, req.body?.notas || null);

  res.json({ id });
});

// ── editar ──
router.put('/:id', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre.' });

  const p = db.prepare('SELECT id FROM proveedores WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Proveedor no encontrado.' });

  db.prepare('UPDATE proveedores SET nombre = ?, whatsapp = ?, notas = ? WHERE id = ? AND user_id = ?')
    .run(nombre, req.body?.whatsapp || null, req.body?.notas || null, req.params.id, req.userId);

  res.json({ ok: true });
});

// ── borrar: los gastos quedan sin proveedor, no se borran ──
router.delete('/:id', (req, res) => {
  db.prepare('UPDATE gastos SET proveedor_id = NULL WHERE proveedor_id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  db.prepare('DELETE FROM proveedores WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── historial de compras a un proveedor ──
router.get('/:id/compras', (req, res) => {
  const p = db.prepare('SELECT * FROM proveedores WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Proveedor no encontrado.' });

  const compras = db.prepare(`
    SELECT * FROM gastos WHERE proveedor_id = ? AND user_id = ?
    ORDER BY fecha DESC, created_at DESC LIMIT 60
  `).all(req.params.id, req.userId);

  res.json({ proveedor: p, compras: compras });
});

module.exports = router;
