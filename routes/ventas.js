const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function hoyISO() { return new Date().toISOString().slice(0, 10); }

// ── registrar una venta ──
router.post('/', (req, res) => {
  const { clienteId, items, medioPago, montoPagado, descuentoPct, notas, deviceId } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La venta no tiene productos.' });
  }

  const lineas = [];
  let total = 0;
  let costoTotal = 0;

  for (const it of items) {
    const prod = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(it.productoId, req.userId);
    if (!prod) return res.status(400).json({ error: 'Hay un producto que ya no existe.' });

    const cantidad = parseFloat(it.cantidad);
    if (isNaN(cantidad) || cantidad <= 0) return res.status(400).json({ error: `Cantidad no válida en ${prod.nombre}.` });

    const precio = it.precioUnitario != null ? parseFloat(it.precioUnitario) : prod.precio_venta;
    const costo = prod.precio_costo || 0;

    lineas.push({ prod, cantidad, precio, costo });
    total += precio * cantidad;
    costoTotal += costo * cantidad;
  }

  const pct = parseFloat(descuentoPct) || 0;
  if (pct > 0) total = total * (1 - Math.min(100, pct) / 100);

  // total manual: el vendedor redondea o hace un descuento a ojo
  const manual = req.body?.totalFinal;
  if (manual != null && manual !== '') {
    const tm = parseFloat(manual);
    if (!isNaN(tm) && tm >= 0) total = tm;
  }

  const ventaId = uuidv4();
  const pagado = montoPagado != null ? parseFloat(montoPagado) : total;
  const estado = pagado >= total ? 'cobrada' : 'pendiente';

  // la fecha la manda el navegador: vale la del negocio, no la del servidor
  const fechaVenta = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.fecha || '') ? req.body.fecha : hoyISO();

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ventaId, req.userId, clienteId || null, clienteId ? 'reparto' : 'mostrador',
         fechaVenta, estado, total, costoTotal, medioPago || 'efectivo',
         pagado, pct, notas || null, deviceId || null);

  for (const l of lineas) {
    db.prepare(`
      INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), ventaId, l.prod.id, l.prod.nombre, l.cantidad, l.precio, l.costo);

    db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(l.cantidad, l.prod.id);
  }

  // si quedó saldo y hay cliente, se suma a su deuda
  if (clienteId && pagado < total) {
    db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ? AND user_id = ?')
      .run(total - pagado, clienteId, req.userId);
  }

  res.json({ id: ventaId, total, estado });
});

// ── listar ventas de un período ──
router.get('/', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || hoyISO();

  const ventas = db.prepare(`
    SELECT v.*, c.nombre AS cliente_nombre
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ?
    ORDER BY v.created_at DESC
  `).all(req.userId, desde, hasta);

  for (const v of ventas) {
    v.items = db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(v.id);
  }

  res.json(ventas);
});

// ── resumen del día: vendido, ganancia y gastos ──
router.get('/resumen', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || hoyISO();

  const v = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS vendido,
           COALESCE(SUM(costo_total), 0) AS costo,
           COUNT(*) AS cantidad
    FROM ventas WHERE user_id = ? AND fecha >= ? AND fecha <= ?
  `).get(req.userId, desde, hasta);

  const g = db.prepare(`
    SELECT COALESCE(SUM(monto), 0) AS gastos
    FROM gastos WHERE user_id = ? AND fecha >= ? AND fecha <= ?
  `).get(req.userId, desde, hasta);

  res.json({
    desde, hasta,
    vendido: v.vendido,
    cantidadVentas: v.cantidad,
    gananciaBruta: v.vendido - v.costo,
    gastos: g.gastos,
    balance: v.vendido - g.gastos
  });
});

// ── anular una venta (devuelve el stock) ──
router.delete('/:id', (req, res) => {
  const venta = db.prepare('SELECT * FROM ventas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const items = db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(venta.id);
  for (const it of items) {
    if (it.producto_id) {
      db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(it.cantidad, it.producto_id);
    }
  }

  if (venta.cliente_id && venta.monto_pagado < venta.total) {
    db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?')
      .run(venta.total - venta.monto_pagado, venta.cliente_id);
  }

  db.prepare('DELETE FROM ventas WHERE id = ?').run(venta.id);
  res.json({ ok: true });
});


// ── quitar un item de una venta ya hecha (devolucion parcial) ──
router.delete('/:ventaId/items/:itemId', (req, res) => {
  const venta = db.prepare('SELECT * FROM ventas WHERE id = ? AND user_id = ?').get(req.params.ventaId, req.userId);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const item = db.prepare('SELECT * FROM venta_items WHERE id = ? AND venta_id = ?').get(req.params.itemId, venta.id);
  if (!item) return res.status(404).json({ error: 'Producto no encontrado en la venta.' });

  const quedan = db.prepare('SELECT COUNT(*) AS n FROM venta_items WHERE venta_id = ?').get(venta.id);
  if (quedan.n <= 1) return res.status(400).json({ error: 'Es el unico producto. Anula la venta entera.' });

  // devolver el stock
  if (item.producto_id) {
    db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(item.cantidad, item.producto_id);
  }

  const resta = item.precio_unitario * item.cantidad;
  const restaCosto = item.costo_unitario * item.cantidad;
  const nuevoTotal = Math.max(0, venta.total - resta);

  db.prepare('DELETE FROM venta_items WHERE id = ?').run(item.id);

  // si era fiada, baja la deuda del cliente
  if (venta.cliente_id && venta.monto_pagado < venta.total) {
    const bajaDeuda = Math.min(resta, venta.total - venta.monto_pagado);
    db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?').run(bajaDeuda, venta.cliente_id);
  }

  const nuevoPagado = Math.min(venta.monto_pagado, nuevoTotal);

  db.prepare(`
    UPDATE ventas SET total = ?, costo_total = ?, monto_pagado = ?,
      estado = CASE WHEN ? >= ? THEN 'cobrada' ELSE 'pendiente' END
    WHERE id = ?
  `).run(nuevoTotal, Math.max(0, venta.costo_total - restaCosto), nuevoPagado,
         nuevoPagado, nuevoTotal, venta.id);

  res.json({ ok: true, nuevoTotal: nuevoTotal });
});

// ── cambiar la cantidad de un item ──
router.put('/:ventaId/items/:itemId', (req, res) => {
  const venta = db.prepare('SELECT * FROM ventas WHERE id = ? AND user_id = ?').get(req.params.ventaId, req.userId);
  if (!venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const item = db.prepare('SELECT * FROM venta_items WHERE id = ? AND venta_id = ?').get(req.params.itemId, venta.id);
  if (!item) return res.status(404).json({ error: 'Producto no encontrado.' });

  const nueva = parseFloat(req.body?.cantidad);
  if (isNaN(nueva) || nueva <= 0) return res.status(400).json({ error: 'Cantidad no valida.' });

  const dif = nueva - item.cantidad;

  if (item.producto_id) {
    db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(dif, item.producto_id);
  }

  const restaPrecio = item.precio_unitario * dif;
  const restaCosto = item.costo_unitario * dif;
  const nuevoTotal = Math.max(0, venta.total + restaPrecio);

  db.prepare('UPDATE venta_items SET cantidad = ? WHERE id = ?').run(nueva, item.id);

  if (venta.cliente_id && venta.monto_pagado < venta.total) {
    db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ?').run(restaPrecio, venta.cliente_id);
  }

  const nuevoPagado = Math.min(venta.monto_pagado, nuevoTotal);

  db.prepare(`
    UPDATE ventas SET total = ?, costo_total = ?, monto_pagado = ?,
      estado = CASE WHEN ? >= ? THEN 'cobrada' ELSE 'pendiente' END
    WHERE id = ?
  `).run(nuevoTotal, Math.max(0, venta.costo_total + restaCosto), nuevoPagado,
         nuevoPagado, nuevoTotal, venta.id);

  res.json({ ok: true, nuevoTotal: nuevoTotal });
});

module.exports = router;
