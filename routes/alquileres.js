const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS reservas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    unidad_id TEXT NOT NULL,
    cliente_id TEXT,
    cliente_nombre TEXT NOT NULL,
    telefono TEXT,
    desde TEXT NOT NULL,
    hasta TEXT NOT NULL,
    personas INTEGER,
    precio_noche REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    sena REAL NOT NULL DEFAULT 0,
    pagado REAL NOT NULL DEFAULT 0,
    estado TEXT NOT NULL DEFAULT 'reservada',
    nota TEXT,
    venta_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(user_id, desde, hasta);
`);

// las unidades son productos marcados como tal
try { db.exec('ALTER TABLE negocio ADD COLUMN cap_alquiler INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN es_unidad INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN capacidad INTEGER'); } catch (e) {}
try { db.exec("ALTER TABLE productos ADD COLUMN cobro_por TEXT NOT NULL DEFAULT 'noche'"); } catch (e) {}

function hoyISO() { return new Date().toISOString().slice(0, 10); }

function noches(desde, hasta) {
  const d = new Date(desde + 'T12:00:00');
  const h = new Date(hasta + 'T12:00:00');
  return Math.max(1, Math.round((h - d) / 86400000));
}

// ── unidades disponibles en un rango ──
router.get('/disponibles', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || desde;

  const unidades = db.prepare(`
    SELECT id, nombre, precio_venta, capacidad, cobro_por, foto_mini, foto_url, notas
    FROM productos
    WHERE user_id = ? AND activo = 1 AND es_unidad = 1
    ORDER BY nombre
  `).all(req.userId);

  const ocupadas = db.prepare(`
    SELECT unidad_id, cliente_nombre, desde, hasta FROM reservas
    WHERE user_id = ? AND estado IN ('reservada','en_curso')
      AND desde < ? AND hasta > ?
  `).all(req.userId, hasta, desde);

  unidades.forEach(function (u) {
    const o = ocupadas.filter(function (r) { return r.unidad_id === u.id; })[0];
    u.libre = !o;
    if (o) {
      u.ocupada_por = o.cliente_nombre;
      u.ocupada_desde = o.desde;
      u.ocupada_hasta = o.hasta;

      // cuando se libera de verdad: la ultima reserva encadenada
      let libreDesde = o.hasta;
      for (let i = 0; i < 20; i++) {
        const sig = db.prepare(`
          SELECT hasta FROM reservas
          WHERE user_id = ? AND unidad_id = ? AND estado IN ('reservada','en_curso')
            AND desde <= ? AND hasta > ?
          ORDER BY hasta DESC LIMIT 1
        `).get(req.userId, u.id, libreDesde, libreDesde);
        if (!sig) break;
        libreDesde = sig.hasta;
      }
      u.libre_desde = libreDesde;
    }
  });

  res.json({ desde: desde, hasta: hasta, noches: noches(desde, hasta), unidades: unidades });
});

// ── reservas de un periodo ──
router.get('/', (req, res) => {
  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || desde;

  const filas = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND r.desde <= ? AND r.hasta >= ?
    ORDER BY r.desde, p.nombre
  `).all(req.userId, hasta, desde);

  res.json(filas);
});

// ── proximas reservas ──
router.get('/proximas', (req, res) => {
  const filas = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND r.hasta >= ? AND r.estado IN ('reservada','en_curso')
    ORDER BY r.desde LIMIT 60
  `).all(req.userId, hoyISO());
  res.json(filas);
});

// ── crear una reserva ──
router.post('/', (req, res) => {
  const { unidadId, clienteId, clienteNombre, telefono, desde, hasta,
          personas, precioNoche, sena, nota } = req.body || {};

  if (!unidadId) return res.status(400).json({ error: 'Elegi que se alquila.' });
  if (!clienteNombre || !clienteNombre.trim()) return res.status(400).json({ error: 'Poné el nombre.' });
  if (!desde || !hasta) return res.status(400).json({ error: 'Poné las fechas.' });
  if (hasta <= desde) return res.status(400).json({ error: 'La salida tiene que ser despues de la entrada.' });

  const u = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(unidadId, req.userId);
  if (!u) return res.status(404).json({ error: 'Unidad no encontrada.' });

  // que no se pise con otra
  const choque = db.prepare(`
    SELECT cliente_nombre, desde, hasta FROM reservas
    WHERE user_id = ? AND unidad_id = ? AND estado IN ('reservada','en_curso')
      AND desde < ? AND hasta > ?
  `).get(req.userId, unidadId, hasta, desde);

  if (choque) {
    return res.status(400).json({
      error: 'Esa unidad ya esta reservada del ' + choque.desde + ' al ' + choque.hasta +
             ' por ' + choque.cliente_nombre + '.'
    });
  }

  const pn = parseFloat(precioNoche) || u.precio_venta || 0;
  const n = noches(desde, hasta);
  const total = pn * n;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, sena, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, unidadId, clienteId || null, clienteNombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, pn, total, parseFloat(sena) || 0, nota || null);

  res.json({ id: id, noches: n, total: total });
});

// ── editar o cambiar estado ──
router.put('/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reservas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });

  const estado = ['reservada', 'en_curso', 'terminada', 'cancelada'].indexOf(req.body?.estado) >= 0
    ? req.body.estado : r.estado;

  const desde = req.body?.desde || r.desde;
  const hasta = req.body?.hasta || r.hasta;
  const pn = req.body?.precioNoche != null ? parseFloat(req.body.precioNoche) : r.precio_noche;
  const total = pn * noches(desde, hasta);

  db.prepare(`
    UPDATE reservas SET cliente_nombre = ?, telefono = ?, desde = ?, hasta = ?,
      personas = ?, precio_noche = ?, total = ?, sena = ?, estado = ?, nota = ?
    WHERE id = ?
  `).run(
    (req.body?.clienteNombre || r.cliente_nombre).trim(),
    req.body?.telefono !== undefined ? req.body.telefono : r.telefono,
    desde, hasta,
    req.body?.personas != null ? parseInt(req.body.personas) : r.personas,
    pn, total,
    req.body?.sena != null ? parseFloat(req.body.sena) : r.sena,
    estado,
    req.body?.nota !== undefined ? req.body.nota : r.nota,
    r.id
  );

  res.json({ ok: true, total: total });
});

// ── cobrar: se convierte en venta ──
router.post('/:id/cobrar', (req, res) => {
  const r = db.prepare('SELECT * FROM reservas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
  if (r.venta_id) return res.status(400).json({ error: 'Esa reserva ya se cobro.' });

  const u = db.prepare('SELECT nombre FROM productos WHERE id = ?').get(r.unidad_id);
  const ventaId = uuidv4();
  const medio = req.body?.medioPago || 'efectivo';
  const total = req.body?.total != null ? parseFloat(req.body.total) : r.total;

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
    VALUES (?, ?, ?, 'mostrador', ?, 'cobrada', ?, 0, ?, ?, 0, ?, ?)
  `).run(ventaId, req.userId, r.cliente_id, req.body?.fecha || hoyISO(), total,
         medio, total,
         'Alquiler: ' + (u ? u.nombre : '') + ' - ' + r.cliente_nombre, req.empleadoId || null);

  db.prepare(`
    INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, 1, ?, 0)
  `).run(uuidv4(), ventaId, r.unidad_id,
         (u ? u.nombre : 'Alquiler') + ' (' + r.desde + ' al ' + r.hasta + ')', total);

  db.prepare("UPDATE reservas SET estado = 'terminada', pagado = ?, venta_id = ? WHERE id = ?")
    .run(total, ventaId, r.id);

  res.json({ ventaId: ventaId, total: total });
});

// ── borrar ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('DELETE FROM reservas WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});


// ── historial: lo que ya paso ──
router.get('/historial', (req, res) => {
  const filas = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND (r.estado IN ('terminada','cancelada') OR r.hasta < ?)
    ORDER BY r.desde DESC LIMIT 100
  `).all(req.userId, hoyISO());

  const total = filas.filter(function (r) { return r.estado === 'terminada'; })
    .reduce(function (s, r) { return s + r.total; }, 0);

  res.json({ items: filas, total: total });
});

module.exports = router;
