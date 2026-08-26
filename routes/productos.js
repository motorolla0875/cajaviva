const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

try { db.exec('ALTER TABLE productos ADD COLUMN vence TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN aviso_dias INTEGER NOT NULL DEFAULT 7'); } catch (e) {}

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
          unidad, stockInicial, stockMinimo, notas, vence, avisoDias, esInsumo } = req.body || {};

  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del producto.' });

  const pv = parseFloat(precioVenta);
  if (isNaN(pv) || pv < 0) return res.status(400).json({ error: 'El precio de venta no es válido.' });

  const pc = precioCosto === '' || precioCosto == null ? null : parseFloat(precioCosto);
  const stock = parseFloat(stockInicial) || 0;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO productos (id, user_id, categoria_id, nombre, codigo_barras,
      precio_venta, precio_costo, unidad, stock, stock_minimo, notas, vence, aviso_dias, es_insumo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, categoriaId || null, nombre.trim(), codigoBarras || null,
         pv, pc, unidad || 'unidad', stock, parseFloat(stockMinimo) || 0, notas || null,
         /^\d{4}-\d{2}-\d{2}$/.test(vence || '') ? vence : null,
         parseInt(avisoDias) || 7, esInsumo ? 1 : 0);

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
          unidad, stockMinimo, notas, vence, avisoDias } = req.body || {};

  const prod = db.prepare('SELECT id FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });

  // si cambio algun precio, queda registrado
  const previo = db.prepare('SELECT precio_venta, precio_costo FROM productos WHERE id = ?').get(req.params.id);
  const nuevaVenta = parseFloat(precioVenta) || 0;
  const nuevoCosto = precioCosto === '' || precioCosto == null ? null : parseFloat(precioCosto);

  if (previo && (previo.precio_venta !== nuevaVenta ||
      (nuevoCosto != null && previo.precio_costo !== nuevoCosto))) {
    db.exec(`CREATE TABLE IF NOT EXISTS historial_precios (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, producto_id TEXT NOT NULL,
      precio_venta REAL, precio_costo REAL, motivo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare(`INSERT INTO historial_precios (id, user_id, producto_id, precio_venta, precio_costo, motivo)
                VALUES (?, ?, ?, ?, ?, 'edicion')`)
      .run(uuidv4(), req.userId, req.params.id, nuevaVenta, nuevoCosto);
  }

  db.prepare(`
    UPDATE productos SET nombre = ?, categoria_id = ?, codigo_barras = ?,
      precio_venta = ?, precio_costo = ?, unidad = ?, stock_minimo = ?,
      notas = ?, vence = ?, aviso_dias = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(nombre.trim(), categoriaId || null, codigoBarras || null,
         parseFloat(precioVenta) || 0,
         precioCosto === '' || precioCosto == null ? null : parseFloat(precioCosto),
         unidad || 'unidad', parseFloat(stockMinimo) || 0, notas || null,
         /^\d{4}-\d{2}-\d{2}$/.test(vence || '') ? vence : null,
         parseInt(avisoDias) || 7,
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

  // costo promedio ponderado: mezcla lo que ya habia con lo que entra
  let costoFinal = prod.precio_costo;
  if (costoUnitario != null && costoUnitario > 0) {
    const stockPrevio = Math.max(0, prod.stock);
    if (stockPrevio > 0 && prod.precio_costo > 0) {
      const valorPrevio = stockPrevio * prod.precio_costo;
      const valorNuevo = cantidad * costoUnitario;
      costoFinal = (valorPrevio + valorNuevo) / (stockPrevio + cantidad);
      costoFinal = Math.round(costoFinal * 100) / 100;
    } else {
      costoFinal = costoUnitario;
    }
  }

  db.prepare('UPDATE productos SET stock = stock + ?, precio_costo = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(cantidad, costoFinal, prod.id);

  // guardar el historial de precios
  db.exec(`CREATE TABLE IF NOT EXISTS historial_precios (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, producto_id TEXT NOT NULL,
    precio_venta REAL, precio_costo REAL, motivo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (costoUnitario != null && costoUnitario > 0 && costoUnitario !== prod.precio_costo) {
    db.prepare(`INSERT INTO historial_precios (id, user_id, producto_id, precio_venta, precio_costo, motivo)
                VALUES (?, ?, ?, ?, ?, 'compra')`)
      .run(uuidv4(), req.userId, prod.id, prod.precio_venta, costoUnitario);
  }

  if (costoUnitario > 0) {
    db.prepare(`
      INSERT INTO gastos (id, user_id, proveedor_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, ?, ?, ?, ?, 'stock', 1)
    `).run(uuidv4(), req.userId, req.body?.proveedorId || null,
           `Reposición - ${prod.nombre}`, cantidad * costoUnitario, req.body?.fecha || hoyISO());
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


// ── actualizar precios en lote ──
router.post('/precios-lote', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño puede hacer esto.' });

  const { categoriaId, ids, campo, modo, valor, redondeo } = req.body || {};
  const v = parseFloat(valor);
  if (isNaN(v)) return res.status(400).json({ error: 'Poné un valor valido.' });

  const col = campo === 'costo' ? 'precio_costo' : 'precio_venta';

  let productos;
  if (Array.isArray(ids) && ids.length > 0) {
    const q = ids.map(function () { return '?'; }).join(',');
    productos = db.prepare('SELECT * FROM productos WHERE user_id = ? AND activo = 1 AND id IN (' + q + ')')
      .all(req.userId, ...ids);
  } else if (categoriaId) {
    productos = db.prepare('SELECT * FROM productos WHERE user_id = ? AND activo = 1 AND categoria_id = ?')
      .all(req.userId, categoriaId);
  } else {
    productos = db.prepare('SELECT * FROM productos WHERE user_id = ? AND activo = 1').all(req.userId);
  }

  if (productos.length === 0) return res.status(400).json({ error: 'No hay productos para actualizar.' });

  function redondear(n) {
    if (!redondeo || redondeo <= 0) return Math.round(n * 100) / 100;
    return Math.round(n / redondeo) * redondeo;
  }

  let cambiados = 0;
  const antes = [];

  productos.forEach(function (p) {
    const actual = p[col];
    if (actual == null) return;

    let nuevo;
    if (modo === 'porcentaje') nuevo = actual * (1 + v / 100);
    else if (modo === 'monto') nuevo = actual + v;
    else if (modo === 'fijar') nuevo = v;
    else if (modo === 'margen') {
      // fijar el precio de venta segun un margen sobre el costo
      if (!p.precio_costo) return;
      nuevo = p.precio_costo * (1 + v / 100);
    } else return;

    nuevo = redondear(Math.max(0, nuevo));
    if (nuevo === actual) return;

    antes.push({ id: p.id, valor: actual });
    db.prepare('UPDATE productos SET ' + col + ' = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(nuevo, p.id);
    cambiados++;
  });

  // guardar para poder deshacer
  if (cambiados > 0) {
    db.exec(`CREATE TABLE IF NOT EXISTS cambios_precio (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, campo TEXT NOT NULL,
      datos TEXT NOT NULL, cantidad INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO cambios_precio (id, user_id, campo, datos, cantidad) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), req.userId, col, JSON.stringify(antes), cambiados);
  }

  res.json({ cambiados: cambiados, total: productos.length });
});

// ── vista previa antes de aplicar ──
router.post('/precios-preview', (req, res) => {
  const { categoriaId, campo, modo, valor, redondeo } = req.body || {};
  const v = parseFloat(valor);
  if (isNaN(v)) return res.json({ items: [] });

  const col = campo === 'costo' ? 'precio_costo' : 'precio_venta';

  const productos = categoriaId
    ? db.prepare('SELECT * FROM productos WHERE user_id = ? AND activo = 1 AND categoria_id = ? ORDER BY nombre').all(req.userId, categoriaId)
    : db.prepare('SELECT * FROM productos WHERE user_id = ? AND activo = 1 ORDER BY nombre').all(req.userId);

  function redondear(n) {
    if (!redondeo || redondeo <= 0) return Math.round(n * 100) / 100;
    return Math.round(n / redondeo) * redondeo;
  }

  const items = [];
  productos.forEach(function (p) {
    const actual = p[col];
    if (actual == null) return;
    let nuevo;
    if (modo === 'porcentaje') nuevo = actual * (1 + v / 100);
    else if (modo === 'monto') nuevo = actual + v;
    else if (modo === 'fijar') nuevo = v;
    else if (modo === 'margen') { if (!p.precio_costo) return; nuevo = p.precio_costo * (1 + v / 100); }
    else return;
    items.push({ id: p.id, nombre: p.nombre, antes: actual, despues: redondear(Math.max(0, nuevo)) });
  });

  res.json({ items: items });
});

// ── deshacer el ultimo cambio de precios ──
router.post('/precios-deshacer', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  let ultimo;
  try {
    ultimo = db.prepare('SELECT * FROM cambios_precio WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.userId);
  } catch (e) { return res.status(400).json({ error: 'No hay cambios para deshacer.' }); }
  if (!ultimo) return res.status(400).json({ error: 'No hay cambios para deshacer.' });

  const datos = JSON.parse(ultimo.datos);
  datos.forEach(function (d) {
    db.prepare('UPDATE productos SET ' + ultimo.campo + ' = ? WHERE id = ? AND user_id = ?')
      .run(d.valor, d.id, req.userId);
  });
  db.prepare('DELETE FROM cambios_precio WHERE id = ?').run(ultimo.id);

  res.json({ restaurados: datos.length });
});


// ── historial de precios de un producto ──
router.get('/:id/historial', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  let filas = [];
  try {
    filas = db.prepare(`
      SELECT * FROM historial_precios
      WHERE producto_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT 30
    `).all(req.params.id, req.userId);
  } catch (e) {}

  res.json({
    producto: { nombre: p.nombre, precio_venta: p.precio_venta, precio_costo: p.precio_costo },
    historial: filas
  });
});

module.exports = router;
