const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS cierres (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fecha TEXT NOT NULL,
    esperado REAL NOT NULL DEFAULT 0,
    contado REAL NOT NULL DEFAULT 0,
    diferencia REAL NOT NULL DEFAULT 0,
    apertura REAL NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function hoyISO() { return new Date().toISOString().slice(0, 10); }

// ── resumen del dia para cerrar la caja ──
router.get('/', (req, res) => {
  const fecha = req.query.fecha || hoyISO();

  const ventas = db.prepare(`
    SELECT medio_pago,
           COALESCE(SUM(monto_pagado), 0) AS cobrado,
           COALESCE(SUM(total), 0) AS total,
           COUNT(*) AS cantidad
    FROM ventas WHERE user_id = ? AND fecha = ?
    GROUP BY medio_pago
  `).all(req.userId, fecha);

  let efectivo = 0, transferencia = 0, fiado = 0, totalVendido = 0, cantidad = 0;

  ventas.forEach(function (v) {
    totalVendido += v.total;
    cantidad += v.cantidad;
    if (v.medio_pago === 'efectivo') efectivo += v.cobrado;
    else if (v.medio_pago === 'transferencia') transferencia += v.cobrado;
    else fiado += (v.total - v.cobrado);
  });

  // pagos de fiados cobrados hoy: entran a la caja
  const pagos = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo = 'pago' THEN monto ELSE -monto END), 0) AS n
    FROM pagos_cliente WHERE user_id = ? AND fecha = ?
  `).get(req.userId, fecha);

  const gastos = db.prepare(`
    SELECT COALESCE(SUM(monto), 0) AS n FROM gastos WHERE user_id = ? AND fecha = ?
  `).get(req.userId, fecha);

  const previo = db.prepare(`
    SELECT contado FROM cierres WHERE user_id = ? AND fecha < ?
    ORDER BY fecha DESC LIMIT 1
  `).get(req.userId, fecha);

  const apertura = previo ? previo.contado : 0;
  const yaCerrado = db.prepare('SELECT * FROM cierres WHERE user_id = ? AND fecha = ?').get(req.userId, fecha);

  res.json({
    fecha: fecha,
    apertura: apertura,
    efectivo: efectivo,
    transferencia: transferencia,
    fiado: fiado,
    pagosRecibidos: pagos.n,
    gastos: gastos.n,
    totalVendido: totalVendido,
    cantidadVentas: cantidad,
    esperado: apertura + efectivo + pagos.n - gastos.n,
    cierre: yaCerrado || null
  });
});

// ── guardar el cierre ──
router.post('/', (req, res) => {
  const fecha = req.body?.fecha || hoyISO();
  const contado = parseFloat(req.body?.contado);
  if (isNaN(contado) || contado < 0) return res.status(400).json({ error: 'Poné cuanto contaste.' });

  const esperado = parseFloat(req.body?.esperado) || 0;
  const apertura = parseFloat(req.body?.apertura) || 0;

  db.prepare('DELETE FROM cierres WHERE user_id = ? AND fecha = ?').run(req.userId, fecha);
  db.prepare(`
    INSERT INTO cierres (id, user_id, fecha, esperado, contado, diferencia, apertura, notas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), req.userId, fecha, esperado, contado, contado - esperado, apertura, req.body?.notas || null);

  res.json({ ok: true, diferencia: contado - esperado });
});

// ── historial de cierres ──
router.get('/historial', (req, res) => {
  res.json(db.prepare(`
    SELECT * FROM cierres WHERE user_id = ? ORDER BY fecha DESC LIMIT 30
  `).all(req.userId));
});

module.exports = router;
