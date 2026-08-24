const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ── listar con cantidad de productos ──
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM productos p WHERE p.categoria_id = c.id AND p.activo = 1) AS cantidad
    FROM categorias c
    WHERE c.user_id = ?
    ORDER BY c.nombre
  `).all(req.userId);
  res.json(rows);
});

// ── crear ──
router.post('/', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre a la categoria.' });

  const existe = db.prepare('SELECT id FROM categorias WHERE user_id = ? AND nombre = ?').get(req.userId, nombre);
  if (existe) return res.status(400).json({ error: 'Ya tenes una categoria con ese nombre.' });

  const id = uuidv4();
  db.prepare('INSERT INTO categorias (id, user_id, nombre) VALUES (?, ?, ?)').run(id, req.userId, nombre);
  res.json({ id });
});

// ── editar ──
router.put('/:id', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre.' });

  const c = db.prepare('SELECT id FROM categorias WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: 'Categoria no encontrada.' });

  db.prepare('UPDATE categorias SET nombre = ? WHERE id = ? AND user_id = ?')
    .run(nombre, req.params.id, req.userId);
  res.json({ ok: true });
});

// ── borrar: los productos quedan sin categoria, no se borran ──
router.delete('/:id', (req, res) => {
  db.prepare('UPDATE productos SET categoria_id = NULL WHERE categoria_id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  db.prepare('DELETE FROM categorias WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
