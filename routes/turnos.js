const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

try { db.exec('ALTER TABLE turnos ADD COLUMN desde_web INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

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

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

function minutos(hora) {
  const p = String(hora).split(':');
  return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0);
}
function aHora(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ── horarios de atencion ──
try { db.exec('ALTER TABLE negocio ADD COLUMN horarios TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN turnos_web INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN sena_monto REAL NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE turnos ADD COLUMN sena_estado TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE turnos ADD COLUMN comprobante TEXT'); } catch (e) {}

router.get('/horarios', (req, res) => {
  const n = db.prepare('SELECT horarios, turnos_web FROM negocio WHERE user_id = ?').get(req.userId);
  let h = null;
  try { h = n && n.horarios ? JSON.parse(n.horarios) : null; } catch (e) {}
  res.json({ horarios: h, turnosWeb: n ? !!n.turnos_web : false, sena: n ? n.sena_monto : 0 });
});

router.put('/horarios', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE negocio SET horarios = ?, turnos_web = ?, sena_monto = ? WHERE user_id = ?')
    .run(JSON.stringify(req.body?.horarios || {}), req.body?.turnosWeb ? 1 : 0,
         parseFloat(req.body?.sena) || 0, req.userId);
  res.json({ ok: true });
});



// ── turnos de un dia ──
router.get('/', (req, res) => {
  const fecha = req.query.fecha || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT t.*, e.nombre AS empleado_nombre
    FROM turnos t
    LEFT JOIN empleados e ON e.id = t.empleado_id
    WHERE t.user_id = ? AND t.fecha = ?
    ORDER BY CASE WHEN t.estado = 'reservado' THEN 0 ELSE 1 END, t.hora
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
  `).all(req.userId, hoyISO(req.userId));
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
    WHERE user_id = ? AND fecha = ? AND estado IN ('reservado','atendido')
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
  `).run(ventaId, req.userId, t.cliente_id, req.body?.fecha || hoyISO(req.userId), total, costo,
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


// ── horarios libres de un dia (publico) ──
router.get('/publico/:slug/libres', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });
  if (!n.turnos_web) return res.json({ activo: false, horas: [] });

  const fecha = req.query.fecha || hoyISO(req.userId);
  const duracion = parseInt(req.query.duracion) || 30;

  let cfg = {};
  try { cfg = n.horarios ? JSON.parse(n.horarios) : {}; } catch (e) {}

  const dias = cfg.dias || { '1':1,'2':1,'3':1,'4':1,'5':1,'6':1 };
  const diaSemana = String(new Date(fecha + 'T12:00:00').getDay());
  if (!dias[diaSemana]) return res.json({ activo: true, abierto: false, horas: [] });

  const desde = minutos(cfg.desde || '09:00');
  const hasta = minutos(cfg.hasta || '19:00');

  const ocupados = db.prepare(`
    SELECT t.hora, t.duracion FROM turnos t
    LEFT JOIN productos p ON p.id = t.producto_id
    WHERE t.user_id = ? AND t.fecha = ? AND t.estado IN ('reservado','atendido')
      AND COALESCE(p.agenda_propia, 0) = 0
  `).all(n.user_id, fecha);

  // si es hoy, no ofrecer horas pasadas
  const ahora = new Date();
  const esHoy = fecha === hoyISO(req.userId);
  const minAhora = ahora.getHours() * 60 + ahora.getMinutes() + 30;

  const horas = [];
  for (let m = desde; m + duracion <= hasta; m += 15) {
    if (esHoy && m < minAhora) continue;
    const choca = ocupados.some(function (o) {
      const d = minutos(o.hora), h = d + o.duracion;
      return m < h && (m + duracion) > d;
    });
    if (!choca) horas.push(aHora(m));
  }

  res.json({ activo: true, abierto: true, horas: horas, desde: cfg.desde, hasta: cfg.hasta,
             sena: n.sena_monto || 0, alias: n.alias_pago, titular: n.titular_pago });
});

// ── el cliente reserva (publico) ──
router.post('/publico/:slug', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });
  if (!n.turnos_web) return res.status(400).json({ error: 'Este negocio no toma turnos por la web.' });

  const { nombre, telefono, productoId, fecha, hora, nota } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Poné tu nombre.' });
  if (!fecha || !hora) return res.status(400).json({ error: 'Elegi el dia y la hora.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ? AND es_servicio = 1')
    .get(productoId, n.user_id);
  if (!p) return res.status(400).json({ error: 'Servicio no encontrado.' });

  const dur = p.duracion || 30;
  const desde = minutos(hora), hasta = desde + dur;

  const choca = db.prepare(`
    SELECT t.hora, t.duracion FROM turnos t
    LEFT JOIN productos p ON p.id = t.producto_id
    WHERE t.user_id = ? AND t.fecha = ? AND t.estado IN ('reservado','atendido')
      AND COALESCE(p.agenda_propia, 0) = 0
  `).all(n.user_id, fecha).some(function (t) {
    const d = minutos(t.hora), h = d + t.duracion;
    return desde < h && hasta > d;
  });

  if (choca) return res.status(400).json({ error: 'Ese horario ya se ocupo. Proba con otro.' });

  const id = uuidv4();
  const pideSena = (n.sena_monto || 0) > 0;

  db.prepare(`
    INSERT INTO turnos (id, user_id, cliente_nombre, telefono, producto_id,
      servicio, fecha, hora, duracion, precio, estado, nota, sena_estado, desde_web)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, 1)
  `).run(id, n.user_id, nombre.trim(), telefono || null, p.id,
         p.nombre, fecha, hora, dur, p.precio_venta,
         (nota ? nota + ' - ' : '') + 'Pedido por la web',
         pideSena ? 'pendiente' : null);

  res.json({ id: id, servicio: p.nombre, fecha: fecha, hora: hora, precio: p.precio_venta,
             sena: n.sena_monto || 0, alias: n.alias_pago, titular: n.titular_pago });
});


// ── confirmar la seña ──
router.put('/:id/sena', (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });

  const estado = ['pendiente', 'enviado', 'confirmada'].indexOf(req.body?.estado) >= 0
    ? req.body.estado : 'confirmada';

  db.prepare('UPDATE turnos SET sena_estado = ? WHERE id = ?').run(estado, t.id);
  res.json({ ok: true });
});


// ── turnos pedidos por la web, sin confirmar ──
router.get('/pendientes', (req, res) => {
  const estado = req.query.estado || 'pendientes';

  const filas = db.prepare(`
    SELECT t.*, p.nombre AS servicio_nombre, p.foto_mini, p.foto_url
    FROM turnos t
    LEFT JOIN productos p ON p.id = t.producto_id
    WHERE t.user_id = ? AND t.desde_web = 1
      AND t.estado IN (${estado === 'listos' ? "'reservado','atendido'"
        : estado === 'cancelados' ? "'cancelado','no_vino'" : "'pendiente'"})
    ORDER BY t.created_at DESC LIMIT 60
  `).all(req.userId);

  res.json({ items: filas, cantidad: estado === 'pendientes' ? filas.length : 0 });
});

router.post('/:id/confirmar', (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });

  if (req.body?.aceptar) {
    db.prepare("UPDATE turnos SET estado = 'reservado' WHERE id = ?").run(t.id);
  } else {
    db.prepare("UPDATE turnos SET estado = 'cancelado' WHERE id = ?").run(t.id);
  }
  res.json({ ok: true });
});

module.exports = router;
