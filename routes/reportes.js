const express = require('express');
const db = require('../db');

const router = express.Router();

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}
function menosDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── los mas vendidos ──
router.get('/mas-vendidos', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT i.producto_id AS id, i.nombre,
           SUM(i.cantidad) AS unidades,
           SUM(i.cantidad * i.precio_unitario) AS facturado,
           SUM(i.cantidad * (i.precio_unitario - i.costo_unitario)) AS ganancia,
           COUNT(DISTINCT v.id) AS veces
    FROM venta_items i
    JOIN ventas v ON v.id = i.venta_id
    LEFT JOIN productos p ON p.id = i.producto_id
    WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ?
      AND COALESCE(p.es_unidad, 0) = 0
    GROUP BY i.nombre
    ORDER BY unidades DESC
    LIMIT 40
  `).all(req.userId, desde, hasta);

  res.json(filas);
});

// ── los que no se venden ──
router.get('/sin-movimiento', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT p.id, p.nombre, p.stock, p.precio_venta, p.precio_costo, p.unidad,
           c.nombre AS categoria_nombre
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1 AND p.stock > 0
      AND COALESCE(p.es_unidad, 0) = 0 AND COALESCE(p.es_servicio, 0) = 0
      AND p.id NOT IN (
        SELECT DISTINCT i.producto_id FROM venta_items i
        JOIN ventas v ON v.id = i.venta_id
        WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ? AND i.producto_id IS NOT NULL
      )
    ORDER BY (p.stock * COALESCE(p.precio_costo, 0)) DESC
    LIMIT 40
  `).all(req.userId, req.userId, desde, hasta);

  const inmovilizado = filas.reduce(function (s, p) {
    return s + (p.stock * (p.precio_costo || 0));
  }, 0);

  res.json({ items: filas, inmovilizado: inmovilizado });
});

// ── que hay que comprar ──
router.get('/reponer', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const dias = parseInt(req.query.dias) || 30;
  const desde = menosDias(dias);
  const hasta = hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT p.id, p.nombre, p.stock, p.stock_minimo, p.unidad,
           p.precio_costo, c.nombre AS categoria_nombre,
           COALESCE((
             SELECT SUM(i.cantidad) FROM venta_items i
             JOIN ventas v ON v.id = i.venta_id
             WHERE i.producto_id = p.id AND v.fecha >= ? AND v.fecha <= ?
           ), 0) AS vendidas
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1
      AND COALESCE(p.es_unidad, 0) = 0 AND COALESCE(p.es_servicio, 0) = 0
      AND COALESCE(p.tiene_receta, 0) = 0
      AND (p.stock <= 0 OR (p.stock_minimo > 0 AND p.stock <= p.stock_minimo))
    ORDER BY p.stock ASC, vendidas DESC
  `).all(desde, hasta, req.userId);

  // sugerir cuanto comprar: lo que se vendio en el periodo, menos lo que hay
  filas.forEach(function (p) {
    const porDia = p.vendidas / dias;
    const sugerido = Math.max(1, Math.ceil(porDia * dias - p.stock));
    p.sugerido = sugerido;
    p.costoEstimado = sugerido * (p.precio_costo || 0);
  });

  const total = filas.reduce(function (s, p) { return s + p.costoEstimado; }, 0);
  res.json({ items: filas, totalEstimado: total, dias: dias });
});

// ── ventas por dia, para ver la tendencia ──
router.get('/por-dia', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT fecha, COUNT(*) AS ventas,
           COALESCE(SUM(total), 0) AS facturado,
           COALESCE(SUM(total - costo_total), 0) AS ganancia
    FROM ventas WHERE user_id = ? AND fecha >= ? AND fecha <= ?
    GROUP BY fecha ORDER BY fecha
  `).all(req.userId, desde, hasta);

  res.json(filas);
});


// ── rendimiento de los empleados ──
router.get('/empleados', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT
      COALESCE(e.id, 'dueno') AS id,
      COALESCE(e.nombre, 'Vos (dueño)') AS nombre,
      COUNT(v.id) AS ventas,
      COALESCE(SUM(v.total), 0) AS facturado,
      COALESCE(SUM(v.total - v.costo_total), 0) AS ganancia,
      COALESCE(AVG(v.total), 0) AS promedio,
      COUNT(DISTINCT v.fecha) AS dias
    FROM ventas v
    LEFT JOIN empleados e ON e.id = v.empleado_id
    WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ?
    GROUP BY COALESCE(e.id, 'dueno')
    ORDER BY facturado DESC
  `).all(req.userId, desde, hasta);

  filas.forEach(function (f) {
    f.porDia = f.dias > 0 ? f.facturado / f.dias : 0;
  });

  res.json(filas);
});

// ── detalle diario de un empleado ──
router.get('/empleados/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);
  const cond = req.params.id === 'dueno' ? 'v.empleado_id IS NULL' : 'v.empleado_id = ?';
  const args = req.params.id === 'dueno'
    ? [req.userId, desde, hasta]
    : [req.userId, desde, hasta, req.params.id];

  const filas = db.prepare(`
    SELECT v.fecha, COUNT(*) AS ventas,
           COALESCE(SUM(v.total), 0) AS facturado
    FROM ventas v
    WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ? AND ${cond}
    GROUP BY v.fecha ORDER BY v.fecha DESC
  `).all(...args);

  res.json(filas);
});


// ── lo que esta por vencer ──
router.get('/vencimientos', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const hoy = hoyISO(req.userId);
  const filas = db.prepare(`
    SELECT p.id, p.nombre, p.vence, p.stock, p.unidad, p.precio_venta, p.precio_costo,
           p.aviso_dias, c.nombre AS categoria_nombre,
           CAST(julianday(p.vence) - julianday(?) AS INTEGER) AS dias
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1 AND p.vence IS NOT NULL AND p.stock > 0
    ORDER BY p.vence ASC
  `).all(hoy, req.userId);

  const vencidos = filas.filter(function (p) { return p.dias < 0; });
  const porVencer = filas.filter(function (p) { return p.dias >= 0 && p.dias <= (p.aviso_dias || 7); });

  const perdida = vencidos.reduce(function (s, p) { return s + (p.stock * (p.precio_costo || 0)); }, 0);
  const enRiesgo = porVencer.reduce(function (s, p) { return s + (p.stock * (p.precio_costo || 0)); }, 0);

  res.json({
    vencidos: vencidos, porVencer: porVencer,
    resto: filas.filter(function (p) { return p.dias > (p.aviso_dias || 7); }),
    perdida: perdida, enRiesgo: enRiesgo, hoy: hoy
  });
});


// ── unidades mas alquiladas ──
router.get('/unidades', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const filas = db.prepare(`
    SELECT p.id, p.nombre, p.precio_venta, p.capacidad, p.cobro_por,
           p.foto_mini, p.foto_url,
           COUNT(r.id) AS reservas,
           COALESCE(SUM(r.total), 0) AS facturado,
           COALESCE(SUM(julianday(r.hasta) - julianday(r.desde)), 0) AS noches
    FROM productos p
    LEFT JOIN reservas r ON r.unidad_id = p.id
      AND r.estado = 'terminada' AND r.desde >= ? AND r.desde <= ?
    WHERE p.user_id = ? AND p.activo = 1 AND p.es_unidad = 1
    GROUP BY p.id
    ORDER BY facturado DESC
  `).all(desde, hasta, req.userId);

  const dias = Math.max(1, Math.round(
    (new Date(hasta + 'T12:00:00') - new Date(desde + 'T12:00:00')) / 86400000
  ) + 1);

  filas.forEach(function (u) {
    u.ocupacion = Math.round((u.noches / dias) * 100);
  });

  const total = filas.reduce(function (s, u) { return s + u.facturado; }, 0);
  res.json({ items: filas, total: total, dias: dias });
});

module.exports = router;
