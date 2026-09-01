const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos_web (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nombre TEXT NOT NULL,
    telefono TEXT,
    direccion TEXT,
    nota TEXT,
    total REAL NOT NULL DEFAULT 0,
    forma_pago TEXT,
    estado TEXT NOT NULL DEFAULT 'nuevo',
    venta_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS pedido_web_items (
    id TEXT PRIMARY KEY,
    pedido_id TEXT NOT NULL,
    producto_id TEXT,
    nombre TEXT NOT NULL,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL
  );
`);

// datos de cobro del negocio
try { db.exec('ALTER TABLE negocio ADD COLUMN alias_pago TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN titular_pago TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN acepta_transferencia INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN acepta_efectivo INTEGER NOT NULL DEFAULT 1'); } catch (e) {}

try { db.exec('ALTER TABLE pedidos_web ADD COLUMN comprobante TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE pedido_web_items ADD COLUMN variante_id TEXT'); } catch (e) {}
try { db.exec("ALTER TABLE pedidos_web ADD COLUMN pago_estado TEXT NOT NULL DEFAULT 'pendiente'"); } catch (e) {}

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

// ── el cliente manda el pedido (publico) ──
router.post('/publico/:slug', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Catalogo no encontrado.' });

  const { nombre, telefono, direccion, nota, items, formaPago } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Poné tu nombre.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'El pedido esta vacio.' });

  const id = uuidv4();
  let total = 0;
  const lineas = [];

  for (const it of items) {
    const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ? AND activo = 1 AND en_catalogo = 1')
      .get(it.productoId, n.user_id);
    if (!p) continue;
    const c = parseFloat(it.cantidad);
    if (isNaN(c) || c <= 0) continue;

    let variante = null;
    if (it.varianteId) {
      variante = db.prepare('SELECT * FROM producto_variantes WHERE id = ? AND producto_id = ?')
        .get(it.varianteId, p.id);
    }
    // si tiene variantes pero no vino ninguna, se acepta igual (el comerciante pregunta)

    const precio = variante && variante.precio_venta ? variante.precio_venta : p.precio_venta;
    lineas.push({ p: p, cantidad: c, variante: variante, precio: precio });
    total += precio * c;
  }

  if (lineas.length === 0) return res.status(400).json({ error: 'No hay productos validos.' });

  db.prepare(`
    INSERT INTO pedidos_web (id, user_id, nombre, telefono, direccion, nota, total, forma_pago)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, n.user_id, nombre.trim(), telefono || null, direccion || null,
         nota || null, total, formaPago || 'efectivo');

  lineas.forEach(function (l) {
    db.prepare(`
      INSERT INTO pedido_web_items (id, pedido_id, producto_id, variante_id, nombre, cantidad, precio_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), id, l.p.id, l.variante ? l.variante.id : null,
           l.variante ? l.p.nombre + ' (' + l.variante.nombre + ')' : l.p.nombre,
           l.cantidad, l.precio);
  });

  res.json({ id: id, total: total, numero: id.slice(0, 6).toUpperCase() });
});

// ── el comerciante ve sus pedidos ──
router.get('/', (req, res) => {
  const estado = req.query.estado || 'pendientes';
  const cond = estado === 'pendientes' ? "AND estado IN ('nuevo','confirmado')"
    : estado === 'listos' ? "AND estado = 'entregado'"
    : estado === 'cancelados' ? "AND estado = 'cancelado'" : '';

  const filas = db.prepare(`
    SELECT * FROM pedidos_web WHERE user_id = ? ${cond}
    ORDER BY created_at DESC LIMIT 60
  `).all(req.userId);

  for (const p of filas) {
    p.items = db.prepare('SELECT * FROM pedido_web_items WHERE pedido_id = ?').all(p.id);

    // marcar los items que ya no tienen stock suficiente
    p.faltaStock = false;
    p.items.forEach(function (i) {
      if (!i.producto_id) return;
      const prod = db.prepare('SELECT stock, tiene_variantes, es_servicio, tiene_receta FROM productos WHERE id = ?').get(i.producto_id);
      if (!prod) return;
      if (prod.es_servicio || prod.tiene_receta) return;

      // si el nombre trae la variante, buscar su stock
      let disponible = prod.stock;
      if (prod.tiene_variantes) {
        const m = String(i.nombre).match(/\(([^)]+)\)\s*$/);
        if (m) {
          const v = db.prepare('SELECT stock FROM producto_variantes WHERE producto_id = ? AND nombre = ?')
            .get(i.producto_id, m[1]);
          if (v) disponible = v.stock;
        }
      }

      i.disponible = disponible;
      if (disponible < i.cantidad) { i.falta = true; p.faltaStock = true; }
    });
  }

  const nuevos = db.prepare("SELECT COUNT(*) AS n FROM pedidos_web WHERE user_id = ? AND estado = 'nuevo'").get(req.userId);
  res.json({ items: filas, nuevos: nuevos.n });
});

// ── cambiar el estado ──
router.put('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos_web WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });

  const estado = ['nuevo', 'confirmado', 'entregado', 'cancelado'].indexOf(req.body?.estado) >= 0
    ? req.body.estado : p.estado;

  db.prepare('UPDATE pedidos_web SET estado = ? WHERE id = ?').run(estado, p.id);
  res.json({ ok: true });
});

// ── convertirlo en venta ──
router.post('/:id/vender', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos_web WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (p.venta_id) return res.status(400).json({ error: 'Ese pedido ya se convirtio en venta.' });

  const items = db.prepare('SELECT * FROM pedido_web_items WHERE pedido_id = ?').all(p.id);
  const ventaId = uuidv4();
  let costoTotal = 0;

  items.forEach(function (i) {
    const prod = i.producto_id
      ? db.prepare('SELECT precio_costo FROM productos WHERE id = ?').get(i.producto_id) : null;
    costoTotal += (prod && prod.precio_costo ? prod.precio_costo : 0) * i.cantidad;
  });

  const totalFinal = req.body?.total != null ? parseFloat(req.body.total) : p.total;
  const medioFinal = req.body?.medioPago || p.forma_pago || 'efectivo';

  db.prepare(`
    INSERT INTO ventas (id, user_id, cliente_id, tipo, fecha, estado, total,
      costo_total, medio_pago, monto_pagado, descuento_pct, notas, empleado_id)
    VALUES (?, ?, NULL, 'mostrador', ?, 'cobrada', ?, ?, ?, ?, 0, ?, ?)
  `).run(ventaId, req.userId, req.body?.fecha || hoyISO(req.userId), totalFinal, costoTotal,
         medioFinal, totalFinal,
         'Pedido web de ' + p.nombre, req.empleadoId || null);

  items.forEach(function (i) {
    const prod = i.producto_id
      ? db.prepare('SELECT precio_costo FROM productos WHERE id = ?').get(i.producto_id) : null;
    db.prepare(`
      INSERT INTO venta_items (id, venta_id, producto_id, variante_id, nombre, cantidad, precio_unitario, costo_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), ventaId, i.producto_id, i.variante_id || null, i.nombre, i.cantidad, i.precio_unitario,
           prod && prod.precio_costo ? prod.precio_costo : 0);

    const info = i.producto_id
      ? db.prepare('SELECT es_servicio, tiene_receta FROM productos WHERE id = ?').get(i.producto_id) : null;

    if (info && info.es_servicio) {
      // un servicio no descuenta stock
    } else if (info && info.tiene_receta) {
      db.prepare('SELECT insumo_id, cantidad FROM receta_items WHERE producto_id = ?').all(i.producto_id)
        .forEach(function (r) {
          db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(r.cantidad * i.cantidad, r.insumo_id);
        });
    } else if (i.variante_id) {
      db.prepare('UPDATE producto_variantes SET stock = stock - ? WHERE id = ?').run(i.cantidad, i.variante_id);
      const tot = db.prepare('SELECT COALESCE(SUM(stock),0) AS n FROM producto_variantes WHERE producto_id = ? AND activa = 1').get(i.producto_id);
      db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(tot.n, i.producto_id);
    } else if (i.producto_id) {
      db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(i.cantidad, i.producto_id);
    }
  });

  db.prepare("UPDATE pedidos_web SET estado = 'entregado', venta_id = ? WHERE id = ?").run(ventaId, p.id);
  res.json({ ventaId: ventaId, total: p.total });
});


// ── confirmar que la plata llego ──
router.put('/:id/pago', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos_web WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });

  const estado = ['pendiente', 'enviado', 'verificado'].indexOf(req.body?.estado) >= 0
    ? req.body.estado : 'verificado';

  db.prepare('UPDATE pedidos_web SET pago_estado = ? WHERE id = ?').run(estado, p.id);
  res.json({ ok: true });
});

module.exports = router;
