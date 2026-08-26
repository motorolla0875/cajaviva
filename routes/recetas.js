const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS receta_items (
    id TEXT PRIMARY KEY,
    producto_id TEXT NOT NULL,
    insumo_id TEXT NOT NULL,
    cantidad REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_receta_producto ON receta_items(producto_id);
`);

try { db.exec('ALTER TABLE productos ADD COLUMN es_insumo INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN tiene_receta INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

// recalcula el costo del producto sumando sus insumos
function recalcularCosto(productoId) {
  const items = db.prepare(`
    SELECT r.cantidad, p.precio_costo
    FROM receta_items r JOIN productos p ON p.id = r.insumo_id
    WHERE r.producto_id = ?
  `).all(productoId);

  if (items.length === 0) {
    db.prepare('UPDATE productos SET tiene_receta = 0 WHERE id = ?').run(productoId);
    return null;
  }

  const costo = items.reduce(function (s, i) {
    return s + (i.cantidad * (i.precio_costo || 0));
  }, 0);

  db.prepare('UPDATE productos SET precio_costo = ?, tiene_receta = 1 WHERE id = ?')
    .run(Math.round(costo * 100) / 100, productoId);

  return costo;
}

// ── ver la receta de un producto ──
router.get('/producto/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  const items = db.prepare(`
    SELECT r.id, r.cantidad, r.insumo_id,
           i.nombre, i.unidad, i.precio_costo, i.stock
    FROM receta_items r JOIN productos i ON i.id = r.insumo_id
    WHERE r.producto_id = ?
    ORDER BY i.nombre
  `).all(p.id);

  const costo = items.reduce(function (s, i) { return s + (i.cantidad * (i.precio_costo || 0)); }, 0);
  const ganancia = p.precio_venta - costo;

  // cuantas porciones se pueden hacer con el stock actual
  let alcanza = null;
  items.forEach(function (i) {
    if (i.cantidad <= 0) return;
    const posibles = Math.floor(i.stock / i.cantidad);
    if (alcanza === null || posibles < alcanza) alcanza = posibles;
  });

  res.json({
    producto: { id: p.id, nombre: p.nombre, precio_venta: p.precio_venta, tiene_receta: p.tiene_receta },
    items: items,
    costo: costo,
    ganancia: ganancia,
    margen: costo > 0 ? Math.round((ganancia / costo) * 100) : null,
    alcanza: alcanza
  });
});

// ── agregar un insumo ──
router.post('/producto/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  const insumo = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.body?.insumoId, req.userId);
  if (!insumo) return res.status(400).json({ error: 'Insumo no encontrado.' });
  if (insumo.id === p.id) return res.status(400).json({ error: 'Un producto no puede ser insumo de si mismo.' });

  const cantidad = parseFloat(req.body?.cantidad);
  if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Poné una cantidad valida.' });

  const existe = db.prepare('SELECT id FROM receta_items WHERE producto_id = ? AND insumo_id = ?').get(p.id, insumo.id);
  if (existe) {
    db.prepare('UPDATE receta_items SET cantidad = ? WHERE id = ?').run(cantidad, existe.id);
  } else {
    db.prepare('INSERT INTO receta_items (id, producto_id, insumo_id, cantidad) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), p.id, insumo.id, cantidad);
  }

  const costo = recalcularCosto(p.id);
  res.json({ ok: true, costo: costo });
});

// ── cambiar la cantidad de un insumo ──
router.put('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const it = db.prepare(`
    SELECT r.*, p.user_id FROM receta_items r
    JOIN productos p ON p.id = r.producto_id WHERE r.id = ?
  `).get(req.params.id);
  if (!it || it.user_id !== req.userId) return res.status(404).json({ error: 'No encontrado.' });

  const cantidad = parseFloat(req.body?.cantidad);
  if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Cantidad no valida.' });

  db.prepare('UPDATE receta_items SET cantidad = ? WHERE id = ?').run(cantidad, it.id);
  const costo = recalcularCosto(it.producto_id);
  res.json({ ok: true, costo: costo });
});

// ── sacar un insumo ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const it = db.prepare(`
    SELECT r.*, p.user_id FROM receta_items r
    JOIN productos p ON p.id = r.producto_id WHERE r.id = ?
  `).get(req.params.id);
  if (!it || it.user_id !== req.userId) return res.status(404).json({ error: 'No encontrado.' });

  db.prepare('DELETE FROM receta_items WHERE id = ?').run(it.id);
  const costo = recalcularCosto(it.producto_id);
  res.json({ ok: true, costo: costo });
});

// ── marcar un producto como insumo (no se vende suelto) ──
router.put('/insumo/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE productos SET es_insumo = ? WHERE id = ? AND user_id = ?')
    .run(req.body?.esInsumo ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});

// ── recalcular todos los costos (cuando cambia el precio de un insumo) ──
router.post('/recalcular', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const conReceta = db.prepare('SELECT id FROM productos WHERE user_id = ? AND tiene_receta = 1').all(req.userId);
  conReceta.forEach(function (p) { recalcularCosto(p.id); });
  res.json({ actualizados: conReceta.length });
});

module.exports = { router, recalcularCosto };
