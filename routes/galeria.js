const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const CARPETA = path.join(__dirname, '..', 'public', 'fotos');
if (!fs.existsSync(CARPETA)) fs.mkdirSync(CARPETA, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS galeria (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    producto_id TEXT NOT NULL,
    url TEXT NOT NULL,
    orden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_galeria_prod ON galeria(producto_id);
`);

try { db.exec('ALTER TABLE productos ADD COLUMN descripcion_larga TEXT'); } catch (e) {}

const subir = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

// ── ver la galeria de una unidad ──
router.get('/:productoId', (req, res) => {
  const p = db.prepare('SELECT descripcion_larga FROM productos WHERE id = ? AND user_id = ?')
    .get(req.params.productoId, req.userId);
  if (!p) return res.status(404).json({ error: 'No encontrado.' });

  const fotos = db.prepare('SELECT id, url FROM galeria WHERE producto_id = ? ORDER BY orden, created_at')
    .all(req.params.productoId);

  res.json({ fotos: fotos, descripcion: p.descripcion_larga || '' });
});

// ── agregar una foto ──
router.post('/:productoId', subir.single('foto'), (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT id FROM productos WHERE id = ? AND user_id = ?')
    .get(req.params.productoId, req.userId);
  if (!p) return res.status(404).json({ error: 'No encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'No llego la imagen.' });

  const cuantas = db.prepare('SELECT COUNT(*) AS n FROM galeria WHERE producto_id = ?')
    .get(req.params.productoId);
  if (cuantas.n >= 5) return res.status(400).json({ error: 'Ya tenes 5 fotos. Borra alguna primero.' });

  const nombre = uuidv4() + '-gal.webp';
  fs.writeFileSync(path.join(CARPETA, nombre), req.file.buffer);

  const id = uuidv4();
  db.prepare('INSERT INTO galeria (id, user_id, producto_id, url, orden) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.userId, req.params.productoId, '/fotos/' + nombre, cuantas.n);

  res.json({ id: id, url: '/fotos/' + nombre });
});

// ── borrar una foto ──
router.delete('/foto/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const f = db.prepare('SELECT * FROM galeria WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!f) return res.status(404).json({ error: 'No encontrada.' });

  const ruta = path.join(CARPETA, path.basename(f.url));
  if (fs.existsSync(ruta)) { try { fs.unlinkSync(ruta); } catch (e) {} }

  db.prepare('DELETE FROM galeria WHERE id = ?').run(f.id);
  res.json({ ok: true });
});

// ── guardar la descripcion larga ──
router.put('/:productoId/descripcion', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE productos SET descripcion_larga = ? WHERE id = ? AND user_id = ?')
    .run(req.body?.texto || null, req.params.productoId, req.userId);
  res.json({ ok: true });
});

module.exports = router;
