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
try { db.exec("ALTER TABLE negocio ADD COLUMN color_personalizado TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN color_fondo TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN color_personalizado_2 TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN color_fondo_2 TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN color_texto TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN logo TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN instagram TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN facebook TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN twitter TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN tiktok TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN descripcion TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN mp_access_token TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN acepta_mercadopago INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
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
    alias_pago, titular_pago, acepta_efectivo, acepta_transferencia, tema, banner, fondo, fuente,
    color_personalizado, color_personalizado_2, color_fondo, color_fondo_2, color_texto, logo, instagram, facebook, twitter, tiktok, descripcion, mp_access_token, acepta_mercadopago
    FROM negocio WHERE user_id = ?`).get(req.userId);
  const cuantos = db.prepare('SELECT COUNT(*) AS n FROM productos WHERE user_id = ? AND activo = 1 AND en_catalogo = 1').get(req.userId);

  // el token nunca se manda de vuelta al frontend, solo si esta conectado o no
  if (n) {
    n.mp_conectado = !!n.mp_access_token;
    delete n.mp_access_token;
  }

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

  // el color personalizado tiene que ser un hex valido, o vacio para volver a los temas fijos
  let colorPer = (req.body?.colorPersonalizado || '').trim();
  if (colorPer && !/^#[0-9a-fA-F]{6}$/.test(colorPer)) colorPer = '';

  let colorPer2 = (req.body?.colorPersonalizado2 || '').trim();
  if (colorPer2 && !/^#[0-9a-fA-F]{6}$/.test(colorPer2)) colorPer2 = '';

  let colorFondo = (req.body?.colorFondo || '').trim();
  if (colorFondo && !/^#[0-9a-fA-F]{6}$/.test(colorFondo)) colorFondo = '';

  let colorFondo2 = (req.body?.colorFondo2 || '').trim();
  if (colorFondo2 && !/^#[0-9a-fA-F]{6}$/.test(colorFondo2)) colorFondo2 = '';

  let colorTexto = (req.body?.colorTexto || '').trim();
  if (colorTexto && !/^#[0-9a-fA-F]{6}$/.test(colorTexto)) colorTexto = '';

  // el token de Mercado Pago solo se pisa si mandaron uno nuevo (nunca se lo devolvemos al frontend)
  const mpToken = (req.body?.mpAccessToken || '').trim();

  db.prepare(`
    UPDATE negocio SET slug = ?, catalogo_activo = ?, whatsapp = ?, catalogo_mensaje = ?,
      alias_pago = ?, titular_pago = ?, acepta_efectivo = ?, acepta_transferencia = ?,
      tema = ?, fondo = ?, fuente = ?, color_personalizado = ?, color_personalizado_2 = ?,
      color_fondo = ?, color_fondo_2 = ?, color_texto = ?, instagram = ?, facebook = ?,
      twitter = ?, tiktok = ?, descripcion = ?,
      acepta_mercadopago = ?, mp_access_token = COALESCE(?, mp_access_token)
    WHERE user_id = ?
  `).run(slug, req.body?.activo ? 1 : 0, req.body?.whatsapp || null,
         req.body?.mensaje || null, req.body?.alias || null, req.body?.titular || null,
         req.body?.efectivo ? 1 : 0, req.body?.transferencia ? 1 : 0,
         req.body?.tema || 'verde', req.body?.fondo || 'claro',
         req.body?.fuente || 'sistema', colorPer || null, colorPer2 || null,
         colorFondo || null, colorFondo2 || null, colorTexto || null,
         req.body?.instagram || null, req.body?.facebook || null,
         req.body?.twitter || null, req.body?.tiktok || null,
         req.body?.descripcion || null,
         req.body?.aceptaMercadopago ? 1 : 0, mpToken || null, req.userId);

  const actualizado = db.prepare(`SELECT slug, catalogo_activo, whatsapp, catalogo_mensaje,
    alias_pago, titular_pago, acepta_efectivo, acepta_transferencia, tema, banner,
    color_personalizado, color_personalizado_2, color_fondo, color_fondo_2, color_texto, logo, instagram, facebook, twitter, tiktok, descripcion, mp_access_token, acepta_mercadopago
    FROM negocio WHERE user_id = ?`).get(req.userId);

  actualizado.mp_conectado = !!actualizado.mp_access_token;
  delete actualizado.mp_access_token;

  res.json(actualizado);
});

// ── desconectar Mercado Pago ──
router.delete('/mercadopago', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE negocio SET mp_access_token = NULL, acepta_mercadopago = 0 WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
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
    SELECT p.id, p.nombre, p.precio_venta, p.precio_oferta, p.unidad, p.stock, p.tiene_variantes, p.notas, p.duracion, p.es_servicio,
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

  // la galeria de fotos extra es para cualquier producto
  productos.forEach(function (p) {
    try {
      p.galeria = db.prepare('SELECT url FROM galeria WHERE producto_id = ? ORDER BY orden').all(p.id)
        .map(function (f) { return f.url; });
    } catch (e) { p.galeria = []; }
  });

  // las unidades ademas llevan precio segun el dia y descripcion larga
  productos.forEach(function (p) {
    if (!p.es_unidad) return;
    p.precio_base = p.precio_venta || 0;
    p.precio_hoy = precioDelDia(p.precio_venta || 0, hoyCat);
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
      acepta_mercadopago: !!(n.acepta_mercadopago && n.mp_access_token),
      acepta_efectivo: n.acepta_efectivo,
      tema: n.tema || 'verde',
      fondo: n.fondo || 'claro',
      fuente: n.fuente || 'sistema',
      banner: n.banner,
      color_personalizado: n.color_personalizado || null,
      color_personalizado_2: n.color_personalizado_2 || null,
      color_fondo: n.color_fondo || null,
      color_fondo_2: n.color_fondo_2 || null,
      color_texto: n.color_texto || null,
      logo: n.logo || null,
      instagram: n.instagram || null,
      facebook: n.facebook || null,
      twitter: n.twitter || null,
      tiktok: n.tiktok || null,
      descripcion: n.descripcion || null
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


// ── directorio publico de negocios ──
router.get('/directorio', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const rubro = req.query.rubro || '';

  let sql = `
    SELECT n.nombre, n.slug, n.rubro, n.banner, n.tema, n.pais,
           (SELECT COUNT(*) FROM productos p
            WHERE p.user_id = n.user_id AND p.activo = 1
              AND p.en_catalogo = 1 AND COALESCE(p.es_insumo,0) = 0) AS productos
    FROM negocio n
    WHERE n.catalogo_activo = 1 AND n.en_directorio = 1 AND n.slug IS NOT NULL AND n.slug != ''
  `;

  const params = [];

  if (rubro) { sql += ' AND n.rubro = ?'; params.push(rubro); }
  if (q) { sql += ' AND LOWER(n.nombre) LIKE ?'; params.push('%' + q + '%'); }

  sql += ' ORDER BY productos DESC, n.nombre LIMIT 120';

  const filas = db.prepare(sql).all(...params);

  // solo los que tienen algo cargado
  const conProductos = filas.filter(function (n) { return n.productos > 0; });

  // rubros disponibles, para los filtros
  const rubros = db.prepare(`
    SELECT rubro, COUNT(*) AS n FROM negocio
    WHERE catalogo_activo = 1 AND en_directorio = 1 AND slug IS NOT NULL AND rubro IS NOT NULL
    GROUP BY rubro ORDER BY n DESC
  `).all();

  res.json({ negocios: conProductos, rubros: rubros });
});


// ── administracion del directorio (solo el dueño de CajaViva) ──
const crypto = require('crypto');
const sesionesAdmin = new Set();

function soloAdmin(req, res, next) {
  const t = (req.headers['x-admin'] || '').trim();
  if (!t || !sesionesAdmin.has(t)) return res.status(403).json({ error: 'No autorizado.' });
  next();
}

router.get('/admin/negocios', soloAdmin, (req, res) => {
  const filas = db.prepare(`
    SELECT n.nombre, n.slug, n.rubro, n.pais, n.en_directorio, n.pide_directorio,
           n.catalogo_activo, n.created_at,
           (SELECT COUNT(*) FROM productos p
            WHERE p.user_id = n.user_id AND p.activo = 1 AND p.en_catalogo = 1) AS productos
    FROM negocio n
    WHERE n.slug IS NOT NULL AND n.slug != ''
    ORDER BY n.en_directorio DESC, productos DESC
  `).all();

  res.json({ negocios: filas });
});

router.put('/admin/aprobar', soloAdmin, (req, res) => {
  const { slug, aprobar } = req.body || {};
  if (!slug) return res.status(400).json({ error: 'Falta el negocio.' });

  db.prepare('UPDATE negocio SET en_directorio = ? WHERE slug = ?')
    .run(aprobar ? 1 : 0, slug);

  res.json({ ok: true });
});


// ── entrar al panel de administracion ──
router.post('/admin/entrar', (req, res) => {
  const { usuario, clave } = req.body || {};
  const u = process.env.ADMIN_USER;
  const c = process.env.ADMIN_PASS;

  if (!u || !c) return res.status(500).json({ error: 'Panel no configurado.' });
  if (usuario !== u || clave !== c) {
    return res.status(401).json({ error: 'Usuario o clave incorrectos.' });
  }

  const t = crypto.randomBytes(24).toString('hex');
  sesionesAdmin.add(t);
  res.json({ token: t });
});

module.exports = router;
