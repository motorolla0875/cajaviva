const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS devoluciones (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    venta_id TEXT,
    cliente_id TEXT,
    fecha TEXT NOT NULL,
    monto REAL NOT NULL,
    forma TEXT NOT NULL,
    motivo TEXT,
    empleado_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS devolucion_items (
    id TEXT PRIMARY KEY,
    devolucion_id TEXT NOT NULL,
    producto_id TEXT,
    nombre TEXT NOT NULL,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    costo_unitario REAL NOT NULL DEFAULT 0
  );
`);

function hoyISO() { return new Date().toISOString().slice(0, 10); }

// ── registrar una devolucion ──
router.post('/', (req, res) => {
  const { ventaId, items, forma, motivo, fecha } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Elegi que se devuelve.' });
  }

  const venta = ventaId
    ? db.prepare('SELECT * FROM ventas WHERE id = ? AND user_id = ?').get(ventaId, req.userId)
    : null;
  if (ventaId && !venta) return res.status(404).json({ error: 'Venta no encontrada.' });

  const devId = uuidv4();
  let monto = 0;
  const lineas = [];

  for (const it of items) {
    const original = db.prepare('SELECT * FROM venta_items WHERE id = ?').get(it.itemId);
    if (!original) continue;

    const cant = parseFloat(it.cantidad);
    if (isNaN(cant) || cant <= 0) continue;
    if (cant > original.cantidad) {
      return res.status(400).json({ error: 'No podes devolver mas de lo que se vendio de ' + original.nombre + '.' });
    }

    lineas.push({ original: original, cantidad: cant });
    monto += original.precio_unitario * cant;
  }

  if (lineas.length === 0) return res.status(400).json({ error: 'No hay nada valido para devolver.' });

  const formaOk = ['efectivo', 'credito', 'descuenta_deuda'].indexOf(forma) >= 0 ? forma : 'efectivo';

  db.prepare(`
    INSERT INTO devoluciones (id, user_id, venta_id, cliente_id, fecha, monto, forma, motivo, empleado_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(devId, req.userId, ventaId || null, venta ? venta.cliente_id : null,
         fecha || hoyISO(), monto, formaOk, motivo || null, req.empleadoId || null);

  for (const l of lineas) {
    db.prepare(`
      INSERT INTO devolucion_items (id, devolucion_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), devId, l.original.producto_id, l.original.nombre,
           l.cantidad, l.original.precio_unitario, l.original.costo_unitario);

    // el stock vuelve
    if (l.original.producto_id) {
      db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(l.cantidad, l.original.producto_id);
    }

    // ajustar la venta original
    const resta = l.original.precio_unitario * l.cantidad;
    const restaCosto = l.original.costo_unitario * l.cantidad;
    const queda = l.original.cantidad - l.cantidad;

    if (queda <= 0) {
      db.prepare('DELETE FROM venta_items WHERE id = ?').run(l.original.id);
    } else {
      db.prepare('UPDATE venta_items SET cantidad = ? WHERE id = ?').run(queda, l.original.id);
    }

    if (venta) {
      db.prepare(`
        UPDATE ventas SET total = MAX(0, total - ?), costo_total = MAX(0, costo_total - ?)
        WHERE id = ?
      `).run(resta, restaCosto, venta.id);
    }
  }

  // que pasa con la plata
  if (venta && venta.cliente_id) {
    if (formaOk === 'descuenta_deuda') {
      db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?').run(monto, venta.cliente_id);
    } else if (formaOk === 'credito') {
      db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ?').run(monto, venta.cliente_id);
      db.prepare(`
        INSERT INTO pagos_cliente (id, user_id, cliente_id, monto, fecha, nota, tipo)
        VALUES (?, ?, ?, ?, ?, 'Credito por devolucion', 'pago')
      `).run(uuidv4(), req.userId, venta.cliente_id, monto, fecha || hoyISO());
    }
  }

  // si se devolvio plata, sale de la caja
  if (formaOk === 'efectivo') {
    db.prepare(`
      INSERT INTO gastos (id, user_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, ?, ?, ?, 'devolucion', 1)
    `).run(uuidv4(), req.userId, 'Devolucion a cliente', monto, fecha || hoyISO());
  }

  // ajustar lo pagado de la venta
  if (venta) {
    const v2 = db.prepare('SELECT total, monto_pagado FROM ventas WHERE id = ?').get(venta.id);
    const nuevoPagado = Math.min(v2.monto_pagado, v2.total);
    db.prepare(`
      UPDATE ventas SET monto_pagado = ?,
        estado = CASE WHEN ? >= total THEN 'cobrada' ELSE 'pendiente' END
      WHERE id = ?
    `).run(nuevoPagado, nuevoPagado, venta.id);
  }

  res.json({ id: devId, monto: monto, forma: formaOk });
});

// ── listar devoluciones ──
router.get('/', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || hoyISO();

  const filas = db.prepare(`
    SELECT d.*, c.nombre AS cliente_nombre
    FROM devoluciones d
    LEFT JOIN clientes c ON c.id = d.cliente_id
    WHERE d.user_id = ? AND d.fecha >= ? AND d.fecha <= ?
    ORDER BY d.created_at DESC
  `).all(req.userId, desde, hasta);

  for (const d of filas) {
    d.items = db.prepare('SELECT * FROM devolucion_items WHERE devolucion_id = ?').all(d.id);
  }

  res.json(filas);
});

module.exports = router;
