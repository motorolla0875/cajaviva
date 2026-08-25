const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function hoyISO() { return new Date().toISOString().slice(0, 10); }

// ── listar productos activos ──
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, c.nombre AS categoria_nombre
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1
    ORDER BY p.nombre
  `).all(req.userId);

  // el empleado no ve el costo
  if (req.esEmpleado) rows.forEach(function (p) { delete p.precio_costo; });

  res.json(rows);
});

// ── crear producto ──
router.post('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  const { nombre, categoriaId, codigoBarras, precioVenta, precioCosto,
          unidad, stockInicial, stockMinimo, notas } = req.body || {};

  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del producto.' });

  const pv = parseFloat(precioVenta);
  if (isNaN(pv) || pv < 0) return res.status(400).json({ error: 'El precio de venta no es válido.' });

  const pc = precioCosto === '' || precioCosto == null ? null : parseFloat(precioCosto);
  const stock = parseFloat(stockInicial) || 0;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO productos (id, user_id, categoria_id, nombre, codigo_barras,
      precio_venta, precio_costo, unidad, stock, stock_minimo, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, categoriaId || null, nombre.trim(), codigoBarras || null,
         pv, pc, unidad || 'unidad', stock, parseFloat(stockMinimo) || 0, notas || null);

  // gasto automático por la carga inicial de stock
  if (stock > 0 && pc > 0) {
    db.prepare(`
      INSERT INTO gastos (id, user_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, ?, ?, ?, 'stock', 1)
    `).run(uuidv4(), req.userId, `Stock inicial - ${nombre.trim()}`, stock * pc, hoyISO());
  }

  res.json({ id });
});

// ── editar producto ──
router.put('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  const { nombre, categoriaId, codigoBarras, precioVenta, precioCosto,
          unidad, stockMinimo, notas } = req.body || {};

  const prod = db.prepare('SELECT id FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });

  db.prepare(`
    UPDATE productos SET nombre = ?, categoria_id = ?, codigo_barras = ?,
      precio_venta = ?, precio_costo = ?, unidad = ?, stock_minimo = ?,
      notas = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(nombre.trim(), categoriaId || null, codigoBarras || null,
         parseFloat(precioVenta) || 0,
         precioCosto === '' || precioCosto == null ? null : parseFloat(precioCosto),
         unidad || 'unidad', parseFloat(stockMinimo) || 0, notas || null,
         req.params.id, req.userId);

  res.json({ ok: true });
});

// ── reponer stock (genera gasto automático) ──
router.post('/:id/reponer', (req, res) => {
  const cantidad = parseFloat(req.body?.cantidad);
  if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Cantidad no válida.' });

  const prod = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });

  const costoUnitario = req.body?.costoUnitario != null && req.body.costoUnitario !== ''
    ? parseFloat(req.body.costoUnitario)
    : prod.precio_costo;

  db.prepare('UPDATE productos SET stock = stock + ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(cantidad, prod.id);

  // si cambió el costo, lo actualizamos para las próximas ventas
  if (costoUnitario != null && costoUnitario !== prod.precio_costo) {
    db.prepare('UPDATE productos SET precio_costo = ? WHERE id = ?').run(costoUnitario, prod.id);
  }

  if (costoUnitario > 0) {
    db.prepare(`
      INSERT INTO gastos (id, user_id, proveedor_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, ?, ?, ?, ?, 'stock', 1)
    `).run(uuidv4(), req.userId, req.body?.proveedorId || null,
           `Reposición - ${prod.nombre}`, cantidad * costoUnitario, hoyISO());
  }

  res.json({ ok: true, stock: prod.stock + cantidad });
});

// ── quitar stock (rotura, vencido, robo) ──
router.post('/:id/quitar', (req, res) => {
  const cantidad = parseFloat(req.body?.cantidad);
  if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: 'Cantidad no válida.' });

  const prod = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (cantidad > prod.stock) return res.status(400).json({ error: 'No hay tanto stock disponible.' });

  db.prepare('UPDATE productos SET stock = stock - ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(cantidad, prod.id);

  res.json({ ok: true, stock: prod.stock - cantidad });
});

// ── borrado suave ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });
  db.prepare('UPDATE productos SET activo = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
