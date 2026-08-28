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
try { db.exec('ALTER TABLE reservas ADD COLUMN hora_entrada TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN comprobante TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN sena_estado TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN sena_fecha TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN recargo_finde REAL NOT NULL DEFAULT 0'); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS temporadas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nombre TEXT NOT NULL,
    desde TEXT NOT NULL,
    hasta TEXT NOT NULL,
    recargo REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// precio de una noche puntual segun temporada y dia
function precioNoche(userId, base, dia, negocio) {
  let p = base;

  const t = db.prepare(`
    SELECT recargo FROM temporadas
    WHERE user_id = ? AND substr(?, 6) >= substr(desde, 6) AND substr(?, 6) <= substr(hasta, 6)
    ORDER BY recargo DESC LIMIT 1
  `).get(userId, dia, dia);

  if (t) p = p * (1 + t.recargo / 100);

  const d = new Date(dia + 'T12:00:00').getDay();
  if ((d === 5 || d === 6) && negocio && negocio.recargo_finde > 0) {
    p = p * (1 + negocio.recargo_finde / 100);
  }

  return Math.round(p);
}

// total de una estadia, noche por noche
function calcularTotal(userId, base, desde, hasta) {
  const neg = db.prepare('SELECT recargo_finde FROM negocio WHERE user_id = ?').get(userId);
  let total = 0;
  const detalle = [];
  const cursor = new Date(desde + 'T12:00:00');
  const fin = new Date(hasta + 'T12:00:00');

  while (cursor < fin) {
    const dia = cursor.toISOString().slice(0, 10);
    const p = precioNoche(userId, base, dia, neg);
    total += p;
    detalle.push({ dia: dia, precio: p });
    cursor.setDate(cursor.getDate() + 1);
  }

  return { total: total, detalle: detalle };
}
try { db.exec('ALTER TABLE reservas ADD COLUMN hora_salida TEXT'); } catch (e) {}
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
    WHERE user_id = ? AND (estado IN ('reservada','en_curso')
      OR (estado = 'pendiente' AND sena_estado = 'enviado' AND sena_fecha > datetime('now', '-1 day')))
      AND desde < ? AND hasta > ?
  `).all(req.userId, hasta, desde);

  // calcular el precio real de esas noches
  const nn = noches(desde, hasta);
  const neg = db.prepare('SELECT recargo_finde FROM negocio WHERE user_id = ?').get(req.userId);

  const temps = db.prepare('SELECT nombre, desde, hasta, recargo FROM temporadas WHERE user_id = ?').all(req.userId);

  unidades.forEach(function (u) {
    const calc = calcularTotal(req.userId, u.precio_venta || 0, desde, hasta);
    u.total_real = calc.total;
    u.total_base = (u.precio_venta || 0) * nn;
    u.hay_recargo = calc.total > u.total_base;

    // por que se recarga
    const motivos = [];
    const cursor = new Date(desde + 'T12:00:00');
    const fin = new Date(hasta + 'T12:00:00');
    let hayFinde = false;

    while (cursor < fin) {
      const dia = cursor.toISOString().slice(0, 10);
      const md = dia.slice(5);
      temps.forEach(function (t) {
        if (md >= t.desde.slice(5) && md <= t.hasta.slice(5) && motivos.indexOf(t.nombre) < 0) {
          motivos.push(t.nombre);
        }
      });
      const d = cursor.getDay();
      if ((d === 5 || d === 6) && neg && neg.recargo_finde > 0) hayFinde = true;
      cursor.setDate(cursor.getDate() + 1);
    }

    if (hayFinde) motivos.push('fin de semana');
    u.motivos = motivos;

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
          personas, precioNoche, sena, nota, horaEntrada, horaSalida } = req.body || {};

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

  const pn = parseFloat(req.body?.precioNoche) || u.precio_venta || 0;
  const n = noches(desde, hasta);
  const calc = calcularTotal(req.userId, pn, desde, hasta);
  const total = req.body?.precioNoche != null ? pn * n : calc.total;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, sena, nota, hora_entrada, hora_salida)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, unidadId, clienteId || null, clienteNombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, pn, total, parseFloat(sena) || 0, nota || null,
         horaEntrada || null, horaSalida || null);

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
      personas = ?, precio_noche = ?, total = ?, sena = ?, estado = ?, nota = ?,
      hora_entrada = ?, hora_salida = ?
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
    req.body?.horaEntrada !== undefined ? req.body.horaEntrada : r.hora_entrada,
    req.body?.horaSalida !== undefined ? req.body.horaSalida : r.hora_salida,
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


// ── calendario de un mes ──
router.get('/calendario', (req, res) => {
  const mes = req.query.mes || hoyISO().slice(0, 7);
  const primero = mes + '-01';
  const d = new Date(primero + 'T12:00:00');
  d.setMonth(d.getMonth() + 1);
  const siguiente = d.toISOString().slice(0, 10);

  const unidades = db.prepare(`
    SELECT id, nombre FROM productos
    WHERE user_id = ? AND activo = 1 AND es_unidad = 1
    ORDER BY nombre
  `).all(req.userId);

  const reservas = db.prepare(`
    SELECT r.id, r.unidad_id, r.cliente_nombre, r.desde, r.hasta, r.estado
    FROM reservas r
    WHERE r.user_id = ? AND r.estado IN ('reservada','en_curso')
      AND r.desde < ? AND r.hasta > ?
  `).all(req.userId, siguiente, primero);

  // dias del mes con cuantas unidades ocupadas
  const dias = {};
  const cursor = new Date(primero + 'T12:00:00');
  while (cursor.toISOString().slice(0, 10) < siguiente) {
    const dia = cursor.toISOString().slice(0, 10);
    const ocupadas = reservas.filter(function (r) {
      return r.desde <= dia && r.hasta > dia;
    });
    dias[dia] = {
      ocupadas: ocupadas.length,
      total: unidades.length,
      quienes: ocupadas.map(function (r) { return r.cliente_nombre; })
    };
    cursor.setDate(cursor.getDate() + 1);
  }

  res.json({ mes: mes, unidades: unidades.length, dias: dias, reservas: reservas });
});


// ── disponibilidad publica ──
router.get('/publico/:slug/libres', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });

  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || desde;
  if (hasta <= desde) return res.json({ unidades: [], noches: 0 });

  const unidades = db.prepare(`
    SELECT id, nombre, precio_venta, capacidad, cobro_por, foto_mini, foto_url, notas
    FROM productos
    WHERE user_id = ? AND activo = 1 AND es_unidad = 1 AND en_catalogo = 1
    ORDER BY nombre
  `).all(n.user_id);

  const ocupadas = db.prepare(`
    SELECT unidad_id FROM reservas
    WHERE user_id = ? AND (estado IN ('reservada','en_curso')
      OR (estado = 'pendiente' AND sena_estado = 'enviado' AND sena_fecha > datetime('now', '-1 day')))
      AND desde < ? AND hasta > ?
  `).all(n.user_id, hasta, desde).map(function (r) { return r.unidad_id; });

  const libres = unidades.filter(function (u) { return ocupadas.indexOf(u.id) < 0; });
  const nn = noches(desde, hasta);
  const neg = db.prepare('SELECT recargo_finde FROM negocio WHERE user_id = ?').get(n.user_id);
  const temps = db.prepare('SELECT nombre, desde, hasta, recargo FROM temporadas WHERE user_id = ?').all(n.user_id);

  libres.forEach(function (u) {
    const calc = calcularTotal(n.user_id, u.precio_venta || 0, desde, hasta);
    u.total_real = calc.total;
    u.total_base = (u.precio_venta || 0) * nn;
    u.hay_recargo = calc.total > u.total_base;

    const motivos = [];
    const cursor = new Date(desde + 'T12:00:00');
    const fin = new Date(hasta + 'T12:00:00');
    let hayFinde = false;

    while (cursor < fin) {
      const md = cursor.toISOString().slice(5, 10);
      temps.forEach(function (t) {
        if (md >= t.desde.slice(5) && md <= t.hasta.slice(5) && motivos.indexOf(t.nombre) < 0) {
          motivos.push(t.nombre);
        }
      });
      const d = cursor.getDay();
      if ((d === 5 || d === 6) && neg && neg.recargo_finde > 0) hayFinde = true;
      cursor.setDate(cursor.getDate() + 1);
    }

    if (hayFinde) motivos.push('fin de semana');
    u.motivos = motivos;

    // comparar con el precio de hoy: si sale menos, es un ahorro
    const hoyCalc = calcularTotal(n.user_id, u.precio_venta || 0,
      new Date().toISOString().slice(0, 10),
      new Date(Date.now() + 86400000).toISOString().slice(0, 10));
    const porNocheHoy = hoyCalc.total;
    const porNocheAhora = calc.total / nn;

    u.ahorro = porNocheAhora < porNocheHoy
      ? Math.round((1 - porNocheAhora / porNocheHoy) * 100) : 0;
  });

  res.json({
    desde: desde, hasta: hasta, noches: nn,
    unidades: libres, sena: n.sena_monto || 0,
    alias: n.alias_pago, titular: n.titular_pago
  });
});

// ── el cliente reserva (publico) ──
router.post('/publico/:slug', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });

  const { unidadId, nombre, telefono, desde, hasta, personas, nota } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Poné tu nombre.' });
  if (!unidadId || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos.' });
  if (hasta <= desde) return res.status(400).json({ error: 'La salida tiene que ser despues de la entrada.' });

  const u = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ? AND es_unidad = 1')
    .get(unidadId, n.user_id);
  if (!u) return res.status(400).json({ error: 'Unidad no encontrada.' });

  const choque = db.prepare(`
    SELECT id FROM reservas
    WHERE user_id = ? AND unidad_id = ? AND (estado IN ('reservada','en_curso')
      OR (estado = 'pendiente' AND sena_estado = 'enviado' AND sena_fecha > datetime('now', '-1 day')))
      AND desde < ? AND hasta > ?
  `).get(n.user_id, unidadId, hasta, desde);

  if (choque) return res.status(400).json({ error: 'Esas fechas ya se ocuparon. Proba con otras.' });

  const nn2 = noches(desde, hasta);
  const calcPub = calcularTotal(n.user_id, u.precio_venta || 0, desde, hasta);
  const total = calcPub.total;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, estado, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)
  `).run(id, n.user_id, unidadId, nombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, Math.round(total / nn2), total,
         (nota ? nota + ' - ' : '') + 'Pedido por la web');

  res.json({
    id: id, unidad: u.nombre, desde: desde, hasta: hasta,
    noches: nn2, total: total,
    sena: n.sena_monto || 0, alias: n.alias_pago, titular: n.titular_pago
  });
});


// ── disponibilidad publica ──
router.get('/publico/:slug/libres', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });

  const desde = req.query.desde || hoyISO();
  const hasta = req.query.hasta || desde;
  if (hasta <= desde) return res.json({ unidades: [], noches: 0 });

  const unidades = db.prepare(`
    SELECT id, nombre, precio_venta, capacidad, cobro_por, foto_mini, foto_url, notas
    FROM productos
    WHERE user_id = ? AND activo = 1 AND es_unidad = 1 AND en_catalogo = 1
    ORDER BY nombre
  `).all(n.user_id);

  const ocupadas = db.prepare(`
    SELECT unidad_id FROM reservas
    WHERE user_id = ? AND estado IN ('reservada','en_curso')
      AND desde < ? AND hasta > ?
  `).all(n.user_id, hasta, desde).map(function (r) { return r.unidad_id; });

  const libres = unidades.filter(function (u) { return ocupadas.indexOf(u.id) < 0; });

  res.json({
    desde: desde, hasta: hasta, noches: noches(desde, hasta),
    unidades: libres, sena: n.sena_monto || 0,
    alias: n.alias_pago, titular: n.titular_pago
  });
});

// ── el cliente reserva (publico) ──
router.post('/publico/:slug', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });

  const { unidadId, nombre, telefono, desde, hasta, personas, nota } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Poné tu nombre.' });
  if (!unidadId || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos.' });
  if (hasta <= desde) return res.status(400).json({ error: 'La salida tiene que ser despues de la entrada.' });

  const u = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ? AND es_unidad = 1')
    .get(unidadId, n.user_id);
  if (!u) return res.status(400).json({ error: 'Unidad no encontrada.' });

  const choque = db.prepare(`
    SELECT id FROM reservas
    WHERE user_id = ? AND unidad_id = ? AND estado IN ('reservada','en_curso')
      AND desde < ? AND hasta > ?
  `).get(n.user_id, unidadId, hasta, desde);

  if (choque) return res.status(400).json({ error: 'Esas fechas ya se ocuparon. Proba con otras.' });

  const nn = noches(desde, hasta);
  const total = (u.precio_venta || 0) * nn;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, estado, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reservada', ?)
  `).run(id, n.user_id, unidadId, nombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, u.precio_venta || 0, total,
         (nota ? nota + ' - ' : '') + 'Pedido por la web');

  res.json({
    id: id, unidad: u.nombre, desde: desde, hasta: hasta,
    noches: nn, total: total,
    sena: n.sena_monto || 0, alias: n.alias_pago, titular: n.titular_pago
  });
});


// ── reservas pedidas por la web, sin confirmar ──
router.get('/pendientes', (req, res) => {
  const filtro = req.query.estado || 'pendientes';

  // las que nadie pago se vencen a las 24 horas
  db.prepare(`
    DELETE FROM reservas
    WHERE user_id = ? AND estado = 'pendiente'
      AND (sena_estado IS NULL OR sena_estado != 'enviado')
      AND created_at < datetime('now', '-1 day')
  `).run(req.userId);

  const filas = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre, p.foto_mini, p.foto_url
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND r.nota LIKE '%Pedido por la web%'
      AND r.estado IN (${filtro === 'listos' ? "'reservada','en_curso','terminada'"
        : filtro === 'cancelados' ? "'cancelada'" : "'pendiente'"})
    ORDER BY r.created_at DESC LIMIT 60
  `).all(req.userId);

  filas.forEach(function (r) {
    if (r.sena_estado === 'enviado' && r.sena_fecha) {
      const vence = new Date(r.sena_fecha + 'Z');
      vence.setDate(vence.getDate() + 1);
      const horas = Math.max(0, Math.round((vence - new Date()) / 3600000));
      r.horas_restantes = horas;
    }
  });

  res.json({ items: filas, cantidad: filtro === 'pendientes' ? filas.length : 0 });
});

// ── aceptar o rechazar ──
router.post('/:id/confirmar', (req, res) => {
  const r = db.prepare('SELECT * FROM reservas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });

  if (req.body?.aceptar) {
    // revisar que las fechas sigan libres
    const choque = db.prepare(`
      SELECT cliente_nombre FROM reservas
      WHERE user_id = ? AND unidad_id = ? AND id != ?
        AND estado IN ('reservada','en_curso')
        AND desde < ? AND hasta > ?
    `).get(req.userId, r.unidad_id, r.id, r.hasta, r.desde);

    if (choque) return res.status(400).json({ error: 'Esas fechas ya se ocuparon por ' + choque.cliente_nombre + '.' });

    db.prepare("UPDATE reservas SET estado = 'reservada' WHERE id = ?").run(r.id);
  } else {
    db.prepare("UPDATE reservas SET estado = 'cancelada' WHERE id = ?").run(r.id);
  }

  res.json({ ok: true });
});


// ── temporadas ──
router.get('/temporadas/lista', (req, res) => {
  const t = db.prepare('SELECT * FROM temporadas WHERE user_id = ? ORDER BY desde').all(req.userId);
  const n = db.prepare('SELECT recargo_finde FROM negocio WHERE user_id = ?').get(req.userId);
  res.json({ items: t, recargoFinde: n ? n.recargo_finde : 0 });
});

router.post('/temporadas/nueva', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const { nombre, desde, hasta, recargo } = req.body || {};
  if (!nombre || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos.' });

  const id = uuidv4();
  db.prepare('INSERT INTO temporadas (id, user_id, nombre, desde, hasta, recargo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, nombre.trim(), desde, hasta, parseFloat(recargo) || 0);
  res.json({ id: id });
});

router.delete('/temporadas/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('DELETE FROM temporadas WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

router.put('/temporadas/finde', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE negocio SET recargo_finde = ? WHERE user_id = ?')
    .run(parseFloat(req.body?.recargo) || 0, req.userId);
  res.json({ ok: true });
});

module.exports = router;
