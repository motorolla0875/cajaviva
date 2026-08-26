const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// datos extra de la variante
try { db.exec('ALTER TABLE producto_variantes ADD COLUMN talle TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE producto_variantes ADD COLUMN color TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE producto_variantes ADD COLUMN activa INTEGER NOT NULL DEFAULT 1'); } catch (e) {}

// ── listar las variantes de un producto ──
router.get('/producto/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  const filas = db.prepare(`
    SELECT * FROM producto_variantes
    WHERE producto_id = ? AND activa = 1
    ORDER BY talle, color, nombre
  `).all(req.params.id);

  const total = filas.reduce(function (s, v) { return s + v.stock; }, 0);

  res.json({
    producto: { id: p.id, nombre: p.nombre, precio_venta: p.precio_venta, tiene_variantes: p.tiene_variantes },
    variantes: filas,
    stockTotal: total
  });
});

// ── generar todas las combinaciones de talles y colores ──
router.post('/producto/:id/generar', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  const talles = Array.isArray(req.body?.talles) ? req.body.talles.filter(Boolean) : [];
  const colores = Array.isArray(req.body?.colores) ? req.body.colores.filter(Boolean) : [];

  if (talles.length === 0 && colores.length === 0) {
    return res.status(400).json({ error: 'Poné al menos un talle o un color.' });
  }

  const listaT = talles.length > 0 ? talles : [null];
  const listaC = colores.length > 0 ? colores : [null];

  let creadas = 0;

  listaT.forEach(function (t) {
    listaC.forEach(function (c) {
      const nombre = [t, c].filter(Boolean).join(' / ');

      const existe = db.prepare(`
        SELECT id FROM producto_variantes
        WHERE producto_id = ? AND IFNULL(talle,'') = IFNULL(?,'') AND IFNULL(color,'') = IFNULL(?,'')
      `).get(p.id, t, c);
      if (existe) return;

      db.prepare(`
        INSERT INTO producto_variantes (id, producto_id, nombre, talle, color, stock, activa)
        VALUES (?, ?, ?, ?, ?, 0, 1)
      `).run(uuidv4(), p.id, nombre, t, c);
      creadas++;
    });
  });

  db.prepare('UPDATE productos SET tiene_variantes = 1 WHERE id = ?').run(p.id);

  res.json({ creadas: creadas });
});

// ── cambiar el stock o el precio de una variante ──
router.put('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const v = db.prepare(`
    SELECT pv.*, p.user_id FROM producto_variantes pv
    JOIN productos p ON p.id = pv.producto_id
    WHERE pv.id = ?
  `).get(req.params.id);
  if (!v || v.user_id !== req.userId) return res.status(404).json({ error: 'Variante no encontrada.' });

  const stock = req.body?.stock != null ? parseFloat(req.body.stock) : v.stock;
  const precio = req.body?.precio === '' || req.body?.precio == null ? null : parseFloat(req.body.precio);
  const codigo = req.body?.codigoBarras != null ? (req.body.codigoBarras || null) : v.codigo_barras;

  db.prepare('UPDATE producto_variantes SET stock = ?, precio_venta = ?, codigo_barras = ? WHERE id = ?')
    .run(isNaN(stock) ? v.stock : stock, precio, codigo, v.id);

  // el stock del producto es la suma de sus variantes
  const total = db.prepare('SELECT COALESCE(SUM(stock), 0) AS n FROM producto_variantes WHERE producto_id = ? AND activa = 1').get(v.producto_id);
  db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(total.n, v.producto_id);

  res.json({ ok: true, stockTotal: total.n });
});

// ── sumar stock a una variante ──
router.post('/:id/reponer', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const cantidad = parseFloat(req.body?.cantidad);
  if (isNaN(cantidad) || cantidad === 0) return res.status(400).json({ error: 'Cantidad no valida.' });

  const v = db.prepare(`
    SELECT pv.*, p.user_id FROM producto_variantes pv
    JOIN productos p ON p.id = pv.producto_id
    WHERE pv.id = ?
  `).get(req.params.id);
  if (!v || v.user_id !== req.userId) return res.status(404).json({ error: 'Variante no encontrada.' });

  db.prepare('UPDATE producto_variantes SET stock = stock + ? WHERE id = ?').run(cantidad, v.id);

  const total = db.prepare('SELECT COALESCE(SUM(stock), 0) AS n FROM producto_variantes WHERE producto_id = ? AND activa = 1').get(v.producto_id);
  db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(total.n, v.producto_id);

  res.json({ ok: true, stockTotal: total.n });
});

// ── borrar una variante ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const v = db.prepare(`
    SELECT pv.*, p.user_id FROM producto_variantes pv
    JOIN productos p ON p.id = pv.producto_id
    WHERE pv.id = ?
  `).get(req.params.id);
  if (!v || v.user_id !== req.userId) return res.status(404).json({ error: 'Variante no encontrada.' });

  db.prepare('DELETE FROM producto_variantes WHERE id = ?').run(v.id);

  const quedan = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(stock), 0) AS s FROM producto_variantes WHERE producto_id = ? AND activa = 1').get(v.producto_id);
  db.prepare('UPDATE productos SET stock = ?, tiene_variantes = ? WHERE id = ?')
    .run(quedan.s, quedan.n > 0 ? 1 : 0, v.producto_id);

  res.json({ ok: true, quedan: quedan.n });
});

module.exports = router;
