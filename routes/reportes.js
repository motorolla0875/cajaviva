const express = require('express');
const db = require('../db');

const router = express.Router();

function hoyISO() { return new Date().toISOString().slice(0, 10); }
function menosDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── los mas vendidos ──
router.get('/mas-vendidos', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const desde = req.query.desde || menosDias(29);
  const hasta = req.query.hasta || hoyISO();

  const filas = db.prepare(`
    SELECT i.producto_id AS id, i.nombre,
           SUM(i.cantidad) AS unidades,
           SUM(i.cantidad * i.precio_unitario) AS facturado,
           SUM(i.cantidad * (i.precio_unitario - i.costo_unitario)) AS ganancia,
           COUNT(DISTINCT v.id) AS veces
    FROM venta_items i
    JOIN ventas v ON v.id = i.venta_id
    WHERE v.user_id = ? AND v.fecha >= ? AND v.fecha <= ?
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
  const hasta = req.query.hasta || hoyISO();

  const filas = db.prepare(`
    SELECT p.id, p.nombre, p.stock, p.precio_venta, p.precio_costo, p.unidad,
           c.nombre AS categoria_nombre
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1 AND p.stock > 0
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
  const hasta = hoyISO();

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
  const hasta = req.query.hasta || hoyISO();

  const filas = db.prepare(`
    SELECT fecha, COUNT(*) AS ventas,
           COALESCE(SUM(total), 0) AS facturado,
           COALESCE(SUM(total - costo_total), 0) AS ganancia
    FROM ventas WHERE user_id = ? AND fecha >= ? AND fecha <= ?
    GROUP BY fecha ORDER BY fecha
  `).all(req.userId, desde, hasta);

  res.json(filas);
});

module.exports = router;
