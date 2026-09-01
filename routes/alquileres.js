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
try { db.exec('ALTER TABLE negocio ADD COLUMN cap_canchas INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN turno_partido INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN hora_desde TEXT NOT NULL DEFAULT '08:00'"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN hora_hasta TEXT NOT NULL DEFAULT '22:00'"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN hora_desde2 TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN hora_hasta2 TEXT"); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN hora_entrada TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN comprobante TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN sena_estado TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE reservas ADD COLUMN sena_fecha TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN recargo_finde REAL NOT NULL DEFAULT 0'); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS reserva_extras (
    id TEXT PRIMARY KEY,
    reserva_id TEXT NOT NULL,
    producto_id TEXT,
    nombre TEXT NOT NULL,
    cantidad REAL NOT NULL DEFAULT 1,
    precio_unitario REAL NOT NULL DEFAULT 0,
    costo_unitario REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_extras_res ON reserva_extras(reserva_id);
`);

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
  // se aplica el recargo mas alto, nunca los dos juntos
  const t = db.prepare(`
    SELECT recargo FROM temporadas
    WHERE user_id = ? AND substr(?, 6) >= substr(desde, 6) AND substr(?, 6) <= substr(hasta, 6)
    ORDER BY recargo DESC LIMIT 1
  `).get(userId, dia, dia);

  const rTemp = t ? t.recargo : 0;

  const d = new Date(dia + 'T12:00:00').getDay();
  const rFinde = ((d === 5 || d === 6) && negocio && negocio.recargo_finde > 0)
    ? negocio.recargo_finde : 0;

  const mayor = Math.max(rTemp, rFinde);
  return Math.round(base * (1 + mayor / 100));
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

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

function noches(desde, hasta) {
  const d = new Date(desde + 'T12:00:00');
  const h = new Date(hasta + 'T12:00:00');
  return Math.max(1, Math.round((h - d) / 86400000));
}

// horas entre dos horarios del mismo dia
function horasEntre(he, hs) {
  if (!he || !hs) return 1;
  const a = he.split(':'), b = hs.split(':');
  const min = (parseInt(b[0]) * 60 + parseInt(b[1] || 0)) - (parseInt(a[0]) * 60 + parseInt(a[1] || 0));
  return min > 0 ? min / 60 : 1;
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

    while (cursor < fin) {
      const dia = cursor.toISOString().slice(0, 10);
      const md = dia.slice(5);

      // cual gana esa noche
      let mejorT = null, rTemp = 0;
      temps.forEach(function (t) {
        if (md >= t.desde.slice(5) && md <= t.hasta.slice(5) && t.recargo > rTemp) {
          rTemp = t.recargo; mejorT = t.nombre;
        }
      });

      const d = cursor.getDay();
      const rFinde = ((d === 5 || d === 6) && neg && neg.recargo_finde > 0) ? neg.recargo_finde : 0;

      const gana = rTemp >= rFinde ? mejorT : 'fin de semana';
      if (gana && Math.max(rTemp, rFinde) > 0 && motivos.indexOf(gana) < 0) motivos.push(gana);

      cursor.setDate(cursor.getDate() + 1);
    }

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
  `).all(req.userId, hoyISO(req.userId));
  res.json(filas);
});

// ── crear una reserva ──
router.post('/', (req, res) => {
  const { unidadId, clienteId, clienteNombre, telefono, desde, hasta,
          personas, precioNoche, sena, nota, horaEntrada, horaSalida } = req.body || {};

  if (!unidadId) return res.status(400).json({ error: 'Elegi que se alquila.' });
  if (!clienteNombre || !clienteNombre.trim()) return res.status(400).json({ error: 'Poné el nombre.' });
  if (!desde || !hasta) return res.status(400).json({ error: 'Poné las fechas.' });
  if (hasta < desde) return res.status(400).json({ error: 'La salida no puede ser antes de la entrada.' });
  if (hasta === desde && !req.body?.horaEntrada) {
    return res.status(400).json({ error: 'Para el mismo dia poné los horarios.' });
  }

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
  let total;

  if (hasta === desde) {
    // alquiler por hora dentro del mismo dia
    total = Math.round(pn * horasEntre(req.body?.horaEntrada, req.body?.horaSalida));
  } else {
    const n = noches(desde, hasta);
    const calc = calcularTotal(req.userId, pn, desde, hasta);
    total = req.body?.precioNoche != null ? pn * n : calc.total;
  }
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, sena, nota, hora_entrada, hora_salida)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, unidadId, clienteId || null, clienteNombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, pn, total, parseFloat(sena) || 0, nota || null,
         horaEntrada || null, horaSalida || null);

  // la seña entra a la caja cuando se recibe
  const montoSena = parseFloat(sena) || 0;
  if (montoSena > 0) {
    const ventaSena = uuidv4();
    db.prepare(`
      INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
        costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
      VALUES (?, ?, ?, 'mostrador', ?, 'cobrada', ?, 0, ?, ?, 0, ?, ?)
    `).run(ventaSena, req.userId, clienteId || null, hoyISO(req.userId), montoSena,
           'efectivo', montoSena,
           'Seña: ' + u.nombre + ' - ' + clienteNombre.trim(), req.empleadoId || null);

    db.prepare(`
      INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, ?, 1, ?, 0)
    `).run(uuidv4(), ventaSena, unidadId,
           'Seña de reserva (' + desde + ')', montoSena);

    db.prepare('UPDATE reservas SET pagado = ? WHERE id = ?').run(montoSena, id);
  }

  res.json({ id: id, noches: noches(desde, hasta), total: total, sena: montoSena });
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
  const he = req.body?.horaEntrada !== undefined ? req.body.horaEntrada : r.hora_entrada;
  const hs = req.body?.horaSalida !== undefined ? req.body.horaSalida : r.hora_salida;
  const total = hasta === desde
    ? Math.round(pn * horasEntre(he, hs))
    : pn * noches(desde, hasta);

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

  // los consumos se suman al total
  const extras = db.prepare('SELECT * FROM reserva_extras WHERE reserva_id = ?').all(r.id);
  const totalExtras = extras.reduce(function (a, i) { return a + i.cantidad * i.precio_unitario; }, 0);

  const yaPagado = r.pagado || 0;

  // si el frontend manda un total, ese es el saldo final a cobrar
  let total, totalCompleto;

  if (req.body?.total != null) {
    total = Math.max(0, parseFloat(req.body.total));
    totalCompleto = total + yaPagado;
  } else {
    totalCompleto = r.total + totalExtras;
    total = Math.max(0, totalCompleto - yaPagado);
  }

  if (total <= 0) {
    db.prepare("UPDATE reservas SET estado = 'terminada' WHERE id = ?").run(r.id);
    return res.json({ ventaId: null, total: 0, yaPagado: yaPagado });
  }

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
    VALUES (?, ?, ?, 'mostrador', ?, 'cobrada', ?, 0, ?, ?, 0, ?, ?)
  `).run(ventaId, req.userId, req.body?.clienteId || r.cliente_id || null,
         req.body?.fecha || hoyISO(req.userId), total,
         medio, medio === 'cuenta_corriente' ? 0 : total,
         'Alquiler: ' + (u ? u.nombre : '') + ' - ' + r.cliente_nombre, req.empleadoId || null);

  if (medio === 'cuenta_corriente' && (req.body?.clienteId || r.cliente_id)) {
    db.prepare('UPDATE clientes SET saldo = COALESCE(saldo,0) + ? WHERE id = ? AND user_id = ?')
      .run(total, req.body?.clienteId || r.cliente_id, req.userId);
  }

  db.prepare(`
    INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, 1, ?, 0)
  `).run(uuidv4(), ventaId, r.unidad_id,
         (u ? u.nombre : 'Alquiler') + ' (' + r.desde + ' al ' + r.hasta + ')',
         Math.max(0, total - totalExtras));

  // cada consumo va como linea aparte
  extras.forEach(function (e) {
    db.prepare(`
      INSERT INTO venta_items (id, venta_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), ventaId, e.producto_id, e.nombre, e.cantidad, e.precio_unitario, e.costo_unitario);
  });

  db.prepare("UPDATE reservas SET estado = 'terminada', pagado = ?, venta_id = ? WHERE id = ?")
    .run(totalCompleto, ventaId, r.id);

  res.json({ ventaId: ventaId, total: total, yaPagado: yaPagado });
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
  `).all(req.userId, hoyISO(req.userId));

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

    while (cursor < fin) {
      const md = cursor.toISOString().slice(5, 10);
      let mejorT = null, rTemp = 0;
      temps.forEach(function (t) {
        if (md >= t.desde.slice(5) && md <= t.hasta.slice(5) && t.recargo > rTemp) {
          rTemp = t.recargo; mejorT = t.nombre;
        }
      });
      const d = cursor.getDay();
      const rFinde = ((d === 5 || d === 6) && neg && neg.recargo_finde > 0) ? neg.recargo_finde : 0;
      const gana = rTemp >= rFinde ? mejorT : 'fin de semana';
      if (gana && Math.max(rTemp, rFinde) > 0 && motivos.indexOf(gana) < 0) motivos.push(gana);
      cursor.setDate(cursor.getDate() + 1);
    }

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

  const { unidadId, nombre, telefono, desde, hasta, personas, nota,
          horaEntrada, horaSalida } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Poné tu nombre.' });
  if (!unidadId || !desde || !hasta) return res.status(400).json({ error: 'Faltan datos.' });
  if (hasta < desde) return res.status(400).json({ error: 'La salida no puede ser antes de la entrada.' });
  if (hasta === desde && !horaEntrada) {
    return res.status(400).json({ error: 'Elegi un horario.' });
  }

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
  let total;
  if (hasta === desde) {
    total = Math.round((u.precio_venta || 0) * horasEntre(horaEntrada, horaSalida));
  } else {
    total = calcularTotal(n.user_id, u.precio_venta || 0, desde, hasta).total;
  }
  const id = uuidv4();

  db.prepare(`
    INSERT INTO reservas (id, user_id, unidad_id, cliente_nombre, telefono,
      desde, hasta, personas, precio_noche, total, estado, nota,
      hora_entrada, hora_salida)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)
  `).run(id, n.user_id, unidadId, nombre.trim(), telefono || null,
         desde, hasta, parseInt(personas) || null, Math.round(total / nn2), total,
         (nota ? nota + ' - ' : '') + 'Pedido por la web',
         horaEntrada || null, horaSalida || null);

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
  if (hasta < desde) return res.status(400).json({ error: 'La salida no puede ser antes de la entrada.' });
  if (hasta === desde && !req.body?.horaEntrada) {
    return res.status(400).json({ error: 'Para el mismo dia poné los horarios.' });
  }

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


// ── los que estan ahora ──
router.get('/encurso', (req, res) => {
  const hoy = hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre, p.foto_mini, p.foto_url
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND r.estado = 'en_curso'
    ORDER BY r.hasta
  `).all(req.userId);

  // los que tendrian que entrar hoy
  const entranHoy = db.prepare(`
    SELECT r.*, p.nombre AS unidad_nombre, p.foto_mini, p.foto_url
    FROM reservas r
    LEFT JOIN productos p ON p.id = r.unidad_id
    WHERE r.user_id = ? AND r.estado = 'reservada' AND r.desde <= ?
    ORDER BY r.desde
  `).all(req.userId, hoy);

  filas.forEach(function (r) {
    const dias = Math.round((new Date(r.hasta + 'T12:00:00') - new Date(hoy + 'T12:00:00')) / 86400000);
    r.dias_restantes = dias;
    r.se_va_hoy = dias <= 0;

    const ex = db.prepare('SELECT cantidad, precio_unitario FROM reserva_extras WHERE reserva_id = ?').all(r.id);
    r.total_extras = ex.reduce(function (s, i) { return s + i.cantidad * i.precio_unitario; }, 0);
    r.cant_extras = ex.length;
    r.total_general = r.total + r.total_extras;
    r.saldo = Math.max(0, r.total_general - (r.pagado || 0));
  });

  res.json({ encurso: filas, porEntrar: entranHoy });
});


// ── consumos de una reserva ──
router.get('/:id/extras', (req, res) => {
  const r = db.prepare('SELECT id, total, pagado FROM reservas WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });

  const items = db.prepare('SELECT * FROM reserva_extras WHERE reserva_id = ? ORDER BY created_at')
    .all(r.id);

  const totalExtras = items.reduce(function (s, i) { return s + i.cantidad * i.precio_unitario; }, 0);

  res.json({
    items: items, totalExtras: totalExtras,
    totalEstadia: r.total, pagado: r.pagado || 0,
    totalGeneral: r.total + totalExtras
  });
});

router.post('/:id/extras', (req, res) => {
  const r = db.prepare('SELECT id FROM reservas WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });

  const { productoId, cantidad } = req.body || {};
  const c = parseFloat(cantidad) || 1;
  if (c <= 0) return res.status(400).json({ error: 'Cantidad no valida.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(productoId, req.userId);
  if (!p) return res.status(400).json({ error: 'Producto no encontrado.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO reserva_extras (id, reserva_id, producto_id, nombre, cantidad, precio_unitario, costo_unitario)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, r.id, p.id, p.nombre, c, p.precio_venta || 0, p.precio_costo || 0);

  // descontar del stock
  if (!p.es_servicio && !p.tiene_receta) {
    db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(c, p.id);
  }

  res.json({ id: id });
});

router.delete('/extras/:id', (req, res) => {
  const e = db.prepare(`
    SELECT e.* FROM reserva_extras e
    JOIN reservas r ON r.id = e.reserva_id
    WHERE e.id = ? AND r.user_id = ?
  `).get(req.params.id, req.userId);

  if (!e) return res.status(404).json({ error: 'No encontrado.' });

  if (e.producto_id) {
    db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(e.cantidad, e.producto_id);
  }
  db.prepare('DELETE FROM reserva_extras WHERE id = ?').run(e.id);
  res.json({ ok: true });
});


// ── horarios del negocio para la grilla ──
router.get('/horarios', (req, res) => {
  const n = db.prepare(`
    SELECT hora_desde, hora_hasta, turno_partido, hora_desde2, hora_hasta2
    FROM negocio WHERE user_id = ?
  `).get(req.userId);
  res.json(n || {});
});

router.put('/horarios', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const b = req.body || {};
  db.prepare(`
    UPDATE negocio SET hora_desde = ?, hora_hasta = ?,
      turno_partido = ?, hora_desde2 = ?, hora_hasta2 = ?
    WHERE user_id = ?
  `).run(b.desde || '08:00', b.hasta || '22:00',
         b.partido ? 1 : 0, b.desde2 || null, b.hasta2 || null, req.userId);
  res.json({ ok: true });
});


// ── grilla de un dia: canchas x horarios ──
router.get('/grilla', (req, res) => {
  const dia = req.query.dia || hoyISO(req.userId);

  const n = db.prepare(`
    SELECT hora_desde, hora_hasta, turno_partido, hora_desde2, hora_hasta2
    FROM negocio WHERE user_id = ?
  `).get(req.userId);

  const canchas = db.prepare(`
    SELECT id, nombre, precio_venta, foto_mini, foto_url
    FROM productos
    WHERE user_id = ? AND activo = 1 AND es_unidad = 1
    ORDER BY nombre
  `).all(req.userId);

  const reservas = db.prepare(`
    SELECT id, unidad_id, cliente_nombre, telefono, hora_entrada, hora_salida,
           estado, total, pagado, sena
    FROM reservas
    WHERE user_id = ? AND desde = ? AND estado IN ('reservada','en_curso','terminada')
    ORDER BY hora_entrada
  `).all(req.userId, dia);

  // armar las franjas
  function aMin(h) {
    if (!h) return 0;
    const p = h.split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1] || 0);
  }
  function aHora(m) {
    const h = Math.floor(m / 60) % 24;
    return String(h).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  const rangos = [];
  rangos.push([aMin(n.hora_desde || '08:00'), aMin(n.hora_hasta || '22:00')]);
  if (n.turno_partido && n.hora_desde2 && n.hora_hasta2) {
    rangos.push([aMin(n.hora_desde2), aMin(n.hora_hasta2)]);
  }

  const franjas = [];
  rangos.forEach(function (r) {
    let ini = r[0];
    let fin = r[1] > r[0] ? r[1] : r[1] + 1440;
    while (ini < fin) {
      franjas.push(aHora(ini));
      ini += 60;
    }
  });

  res.json({ dia: dia, canchas: canchas, franjas: franjas, reservas: reservas });
});


// ── horarios libres de una cancha (publico) ──
router.get('/publico/:slug/horas', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });

  const dia = req.query.dia || hoyISO(req.userId);
  const unidadId = req.query.unidad;
  if (!unidadId) return res.status(400).json({ error: 'Falta la cancha.' });

  const u = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ? AND es_unidad = 1')
    .get(unidadId, n.user_id);
  if (!u) return res.status(404).json({ error: 'Cancha no encontrada.' });

  const tomadas = db.prepare(`
    SELECT hora_entrada, hora_salida FROM reservas
    WHERE user_id = ? AND unidad_id = ? AND desde = ?
      AND (estado IN ('reservada','en_curso')
        OR (estado = 'pendiente' AND sena_estado = 'enviado' AND sena_fecha > datetime('now','-1 day')))
  `).all(n.user_id, unidadId, dia);

  function aMin(h) {
    if (!h) return 0;
    const p = h.split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1] || 0);
  }
  function aHora(m) {
    return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  const rangos = [[aMin(n.hora_desde || '08:00'), aMin(n.hora_hasta || '22:00')]];
  if (n.turno_partido && n.hora_desde2 && n.hora_hasta2) {
    rangos.push([aMin(n.hora_desde2), aMin(n.hora_hasta2)]);
  }

  const hoyLocal = db.hoyEn ? db.hoyEn(n.user_id) : new Date().toISOString().slice(0, 10);
  const esHoy = dia === hoyLocal;
  const minAhora = db.minutosAhoraEn ? db.minutosAhoraEn(n.user_id) : 0;

  const libres = [];
  rangos.forEach(function (r) {
    let ini = r[0];
    const fin = r[1] > r[0] ? r[1] : r[1] + 1440;
    while (ini + 60 <= fin) {
      const h = aHora(ini);
      const ocupada = tomadas.some(function (t) {
        const a = aMin(t.hora_entrada), b = aMin(t.hora_salida);
        return ini < b && (ini + 60) > a;
      });
      if (!ocupada && (!esHoy || ini > minAhora)) libres.push(h);
      ini += 60;
    }
  });

  res.json({
    dia: dia, cancha: u.nombre, precio: u.precio_venta || 0,
    horas: libres, sena: n.sena_monto || 0,
    alias: n.alias_pago, titular: n.titular_pago
  });
});

module.exports = router;
