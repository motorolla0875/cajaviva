const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS turnos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    cliente_id TEXT,
    cliente_nombre TEXT NOT NULL,
    telefono TEXT,
    empleado_id TEXT,
    producto_id TEXT,
    servicio TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    duracion INTEGER NOT NULL DEFAULT 30,
    precio REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'reservado',
    nota TEXT,
    venta_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(user_id, fecha);
`);

// duracion del servicio, en el producto
try { db.exec('ALTER TABLE productos ADD COLUMN duracion INTEGER'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN es_servicio INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

function hoyISO() { return new Date().toISOString().slice(0, 10); }

function minutos(hora) {
  const p = String(hora).split(':');
  return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0);
}
function aHora(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ── turnos de un dia ──
router.get('/', (req, res) => {
  const fecha = req.query.fecha || hoyISO();

  const filas = db.prepare(`
    SELECT t.*, e.nombre AS empleado_nombre
    FROM turnos t
    LEFT JOIN empleados e ON e.id = t.empleado_id
    WHERE t.user_id = ? AND t.fecha = ?
    ORDER BY t.hora
  `).all(req.userId, fecha);

  filas.forEach(function (t) { t.hora_fin = aHora(minutos(t.hora) + t.duracion); });

  const totales = {
    reservados: filas.filter(function (t) { return t.estado === 'reservado'; }).length,
    atendidos: filas.filter(function (t) { return t.estado === 'atendido'; }).length,
    porCobrar: filas.filter(function (t) { return t.estado === 'reservado'; })
      .reduce(function (s, t) { return s + t.precio; }, 0)
  };

  res.json({ fecha: fecha, items: filas, totales: totales });
});

// ── proximos turnos ──
router.get('/proximos', (req, res) => {
  const filas = db.prepare(`
    SELECT t.*, e.nombre AS empleado_nombre
    FROM turnos t
    LEFT JOIN empleados e ON e.id = t.empleado_id
    WHERE t.user_id = ? AND t.fecha >= ? AND t.estado = 'reservado'
    ORDER BY t.fecha, t.hora LIMIT 60
  `).all(req.userId, hoyISO());
  res.json(filas);
});

// ── crear un turno ──
router.post('/', (req, res) => {
  const { clienteNombre, telefono, clienteId, empleadoId, productoId,
          servicio, fecha, hora, duracion, precio, nota } = req.body || {};

  if (!clienteNombre || !clienteNombre.trim()) return res.status(400).json({ error: 'Poné el nombre del cliente.' });
  if (!fecha || !hora) return res.status(400).json({ error: 'Poné la fecha y la hora.' });

  let nombreServicio = (servicio || '').trim();
  let dur = parseInt(duracion) || 30;
  let pre = parseFloat(precio) || 0;

  if (productoId) {
    const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(productoId, req.userId);
    if (p) {
      nombreServicio = nombreServicio || p.nombre;
      if (!duracion) dur = p.duracion || 30;
      if (!precio) pre = p.precio_venta;
    }
  }

  if (!nombreServicio) return res.status(400).json({ error: 'Elegi el servicio.' });

  // avisar si se superpone con otro del mismo profesional
  const desde = minutos(hora), hasta = desde + dur;
  const choques = db.prepare(`
    SELECT hora, duracion, cliente_nombre FROM turnos
    WHERE user_id = ? AND fecha = ? AND estado != 'cancelado'
      AND IFNULL(empleado_id, '') = IFNULL(?, '')
  `).all(req.userId, fecha, empleadoId || null)
    .filter(function (t) {
      const d = minutos(t.hora), h = d + t.duracion;
      return desde < h && hasta > d;
    });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO turnos (id, user_id, cliente_id, cliente_nombre, telefono, empleado_id,
      producto_id, servicio, fecha, hora, duracion, precio, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, clienteId || null, clienteNombre.trim(), telefono || null,
         empleadoId || null, productoId || null, nombreServicio, fecha, hora, dur, pre, nota || null);

  res.json({ id: id, choques: choques.length, conQuien: choques.map(function (c) { return c.cliente_nombre; }) });
});

// ── editar ──
router.put('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });

  const estado = ['reservado', 'atendido', 'cancelado', 'ausente'].indexOf(req.body?.estado) >= 0
    ? req.body.estado : t.estado;

  db.prepare(`
    UPDATE turnos SET cliente_nombre = ?, telefono = ?, empleado_id = ?,
      servicio = ?, fecha = ?, hora = ?, duracion = ?, precio = ?, estado = ?, nota = ?
    WHERE id = ?
  `).run(
    (req.body?.clienteNombre || t.cliente_nombre).trim(),
    req.body?.telefono !== undefined ? req.body.telefono : t.telefono,
    req.body?.empleadoId !== undefined ? req.body.empleadoId : t.empleado_id,
    (req.body?.servicio || t.servicio).trim(),
    req.body?.fecha || t.fecha,
    req.body?.hora || t.hora,
    parseInt(req.body?.duracion) || t.duracion,
    req.body?.precio != null ? parseFloat(req.body.precio) : t.precio,
    estado,
    req.body?.nota !== undefined ? req.body.nota : t.nota,
    t.id
  );

  res.json({ ok: true });
});

// ── cobrar el turno: se convierte en venta ──
router.post('/:id/cobrar', (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });
  if (t.venta_id) return res.status(400).json({ error: 'Ese turno ya se cobro.' });

  const ventaId = uuidv4();
  const medio = req.body?.medioPago || 'efectivo';
  const total = req.body?.total != null ? parseFloat(req.body.total) : t.precio;

  let costo = 0;
  if (t.producto_id) {
    const p = db.prepare('SELECT precio_costo FROM productos WHERE id = ?').get(t.producto_id);
    if (p && p.precio_costo) costo = p.precio_costo;
  }

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
    VALUES (?, ?, ?, 'mostrador', ?, 'cobrada', ?, ?, ?, ?, 0, ?, ?)
  `).run(ventaId, req.userId, t.cliente_id, req.body?.fecha || hoyISO(), total, costo,
         medio, total, 'Turno: ' + t.servicio + ' - ' + t.cliente_nombre, t.empleado_id);

  db.prepare(`
    INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(uuidv4(), ventaId, t.producto_id, t.servicio, total, costo);

  db.prepare("UPDATE turnos SET estado = 'atendido', venta_id = ? WHERE id = ?").run(ventaId, t.id);

  res.json({ ventaId: ventaId, total: total });
});

// ── borrar ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('DELETE FROM turnos WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
