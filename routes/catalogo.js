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
try { db.exec("ALTER TABLE negocio ADD COLUMN fuente TEXT NOT NULL DEFAULT 'sistema'"); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN dominio TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN dominio_ok INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
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
    alias_pago, titular_pago, acepta_efectivo, acepta_transferencia, tema, banner, fondo, fuente
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
      tema = ?, fondo = ?, fuente = ?
    WHERE user_id = ?
  `).run(slug, req.body?.activo ? 1 : 0, req.body?.whatsapp || null,
         req.body?.mensaje || null, req.body?.alias || null, req.body?.titular || null,
         req.body?.efectivo ? 1 : 0, req.body?.transferencia ? 1 : 0,
         req.body?.tema || 'verde', req.body?.fondo || 'claro',
         req.body?.fuente || 'sistema', req.userId);

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
           p.es_unidad, p.capacidad, p.cobro_por,
           p.foto_mini AS foto, p.foto_url AS foto_grande, c.nombre AS categoria
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.user_id = ? AND p.activo = 1 AND p.en_catalogo = 1 AND p.es_insumo = 0
    ORDER BY c.nombre, p.nombre
  `).all(n.user_id);

  // precio del dia con los recargos que correspondan
  const hoyCat = new Date().toISOString().slice(0, 10);
  const negR = db.prepare('SELECT recargo_finde FROM negocio WHERE user_id = ?').get(n.user_id);
  let tempsCat = [];
  try {
    tempsCat = db.prepare('SELECT desde, hasta, recargo FROM temporadas WHERE user_id = ?').all(n.user_id);
  } catch (e) {}

  function precioDelDia(base, dia) {
    const md = dia.slice(5);
    let rTemp = 0;
    tempsCat.forEach(function (t) {
      if (md >= t.desde.slice(5) && md <= t.hasta.slice(5) && t.recargo > rTemp) rTemp = t.recargo;
    });
    const dd = new Date(dia + 'T12:00:00').getDay();
    const rFinde = ((dd === 5 || dd === 6) && negR && negR.recargo_finde > 0)
      ? negR.recargo_finde : 0;
    return Math.round(base * (1 + Math.max(rTemp, rFinde) / 100));
  }

  // las unidades llevan su galeria y descripcion larga
  productos.forEach(function (p) {
    if (!p.es_unidad) return;
    p.precio_base = p.precio_venta || 0;
    p.precio_hoy = precioDelDia(p.precio_venta || 0, hoyCat);
    try {
      p.galeria = db.prepare('SELECT url FROM galeria WHERE producto_id = ? ORDER BY orden').all(p.id)
        .map(function (f) { return f.url; });
    } catch (e) { p.galeria = []; }
    const d = db.prepare('SELECT descripcion_larga FROM productos WHERE id = ?').get(p.id);
    p.descripcion_larga = d ? d.descripcion_larga : null;
  });

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
      fuente: n.fuente || 'sistema',
      banner: n.banner
    },
    productos: productos
  });
});


// ── dominio propio ──
router.get('/dominio', (req, res) => {
  const n = db.prepare('SELECT dominio, dominio_ok, slug FROM negocio WHERE user_id = ?').get(req.userId);
  res.json(n || {});
});

router.put('/dominio', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  let d = (req.body?.dominio || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

  if (d && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) {
    return res.status(400).json({ error: 'Ese dominio no parece valido. Ej: mitienda.com' });
  }

  if (d) {
    const otro = db.prepare('SELECT user_id FROM negocio WHERE dominio = ? AND user_id != ?').get(d, req.userId);
    if (otro) return res.status(400).json({ error: 'Ese dominio ya lo esta usando otro negocio.' });
  }

  db.prepare('UPDATE negocio SET dominio = ?, dominio_ok = 0 WHERE user_id = ?')
    .run(d || null, req.userId);

  res.json({ dominio: d || null });
});

// ── buscar un negocio por su dominio (interno) ──
router.get('/por-dominio/:host', (req, res) => {
  const host = String(req.params.host || '').toLowerCase().replace(/^www\./, '');
  const n = db.prepare('SELECT slug FROM negocio WHERE dominio = ? AND catalogo_activo = 1').get(host);
  if (!n) return res.status(404).json({ error: 'No encontrado.' });
  res.json({ slug: n.slug });
});


// ── pedir el certificado del dominio propio ──
router.post('/dominio/certificar', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const n = db.prepare('SELECT dominio, dominio_ok FROM negocio WHERE user_id = ?').get(req.userId);
  if (!n || !n.dominio) return res.status(400).json({ error: 'Primero guarda tu dominio.' });
  if (n.dominio_ok) return res.json({ ok: true, estado: 'listo' });

  // solo letras, numeros, guiones y puntos
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(n.dominio)) {
    return res.status(400).json({ error: 'Dominio invalido.' });
  }

  const { execFile } = require('child_process');

  execFile('sudo', ['/usr/local/bin/certificar-dominio', n.dominio],
    { timeout: 120000 }, function (err, salida, errSalida) {
      const texto = String(salida || '') + String(errSalida || '');

      if (texto.indexOf('OK:') >= 0) {
        return res.json({ ok: true, estado: 'listo' });
      }
      if (texto.indexOf('PENDIENTE:') >= 0) {
        return res.json({ ok: false, estado: 'dns',
          error: 'Tu dominio todavia no apunta a nuestro servidor. Puede tardar hasta 24 horas.' });
      }
      return res.json({ ok: false, estado: 'error',
        error: 'No se pudo activar todavia. Proba de nuevo en un rato.' });
    });
});

module.exports = router;
