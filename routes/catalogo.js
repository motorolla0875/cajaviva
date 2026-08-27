const express = require('express');
const db = require('../db');

const router = express.Router();

// columnas para el catalogo
try { db.exec('ALTER TABLE negocio ADD COLUMN slug TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN catalogo_activo INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN whatsapp TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN catalogo_mensaje TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE productos ADD COLUMN en_catalogo INTEGER NOT NULL DEFAULT 1'); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN tema TEXT NOT NULL DEFAULT 'verde'"); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN banner TEXT'); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN fondo TEXT NOT NULL DEFAULT 'claro'"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN fondo TEXT NOT NULL DEFAULT 'claro'"); } catch (e) {}

function armarSlug(t) {
  return String(t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'negocio';
}

// ── configuracion del catalogo (dueño) ──
router.get('/config', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const n = db.prepare(`SELECT slug, catalogo_activo, whatsapp, catalogo_mensaje, nombre,
    alias_pago, titular_pago, acepta_efectivo, acepta_transferencia, tema, banner, fondo
    FROM negocio WHERE user_id = ?`).get(req.userId);
  const cuantos = db.prepare('SELECT COUNT(*) AS n FROM productos WHERE user_id = ? AND activo = 1 AND en_catalogo = 1').get(req.userId);
  res.json({ config: n || null, productos: cuantos.n });
});

router.put('/config', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const n = db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId);
  if (!n) return res.status(404).json({ error: 'Negocio no encontrado.' });

  let slug = req.body?.slug != null ? armarSlug(req.body.slug) : (n.slug || armarSlug(n.nombre));

  // que no se repita
  let intento = slug, i = 1;
  while (db.prepare('SELECT id FROM negocio WHERE slug = ? AND user_id != ?').get(intento, req.userId)) {
    intento = slug + '-' + (++i);
  }
  slug = intento;

  db.prepare(`
    UPDATE negocio SET slug = ?, catalogo_activo = ?, whatsapp = ?, catalogo_mensaje = ?,
      alias_pago = ?, titular_pago = ?, acepta_efectivo = ?, acepta_transferencia = ?,
      tema = ?, fondo = ?
    WHERE user_id = ?
  `).run(slug, req.body?.activo ? 1 : 0, req.body?.whatsapp || null,
         req.body?.mensaje || null, req.body?.alias || null, req.body?.titular || null,
         req.body?.efectivo ? 1 : 0, req.body?.transferencia ? 1 : 0,
         req.body?.tema || 'verde', req.body?.fondo || 'claro', req.userId);

  res.json(db.prepare(`SELECT slug, catalogo_activo, whatsapp, catalogo_mensaje,
    alias_pago, titular_pago, acepta_efectivo, acepta_transferencia, tema, banner
    FROM negocio WHERE user_id = ?`).get(req.userId));
});

// ── mostrar u ocultar un producto del catalogo ──
router.put('/producto/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE productos SET en_catalogo = ? WHERE id = ? AND user_id = ?')
    .run(req.body?.mostrar ? 1 : 0, req.params.id, req.userId);
  res.json({ ok: true });
});

// ── mostrar u ocultar todos ──
router.put('/todos', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const v = req.body?.mostrar ? 1 : 0;
  if (req.body?.categoriaId) {
    db.prepare('UPDATE productos SET en_catalogo = ? WHERE user_id = ? AND categoria_id = ?')
      .run(v, req.userId, req.body.categoriaId);
  } else {
    db.prepare('UPDATE productos SET en_catalogo = ? WHERE user_id = ?').run(v, req.userId);
  }
  res.json({ ok: true });
});

// ── el catalogo publico, sin sesion ──
router.get('/publico/:slug', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE slug = ? AND catalogo_activo = 1').get(req.params.slug);
  if (!n) return res.status(404).json({ error: 'Catalogo no encontrado.' });

  const productos = db.prepare(`
    SELECT p.id, p.nombre, p.precio_venta, p.unidad, p.stock, p.tiene_variantes, p.notas, p.duracion, p.es_servicio,
           p.foto_mini AS foto, p.foto_url AS foto_grande, c.nombre AS categoria
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1 AND p.en_catalogo = 1
    ORDER BY c.nombre, p.nombre
  `).all(n.user_id);

  // sumarle las combinaciones a los que tienen
  productos.forEach(function (p) {
    if (!p.tiene_variantes) return;
    p.variantes = db.prepare(`
      SELECT id, nombre, precio_venta, stock FROM producto_variantes
      WHERE producto_id = ? AND activa = 1
      ORDER BY talle, color, nombre
    `).all(p.id);
  });

  res.json({
    negocio: {
      nombre: n.nombre,
      whatsapp: n.whatsapp,
      mensaje: n.catalogo_mensaje,
      alias_pago: n.alias_pago,
      titular_pago: n.titular_pago,
      acepta_transferencia: n.acepta_transferencia,
      acepta_efectivo: n.acepta_efectivo,
      tema: n.tema || 'verde',
      fondo: n.fondo || 'claro',
      banner: n.banner
    },
    productos: productos
  });
});

module.exports = router;
