require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { router: authRouter, requiereAuth } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 5200;

app.use(express.json());
// si entra por un dominio propio, se sirve el catalogo de ese negocio
app.use(function (req, res, next) {
  const host = String(req.hostname || '').toLowerCase().replace(/^www\./, '');

  // los dominios de la app siguen normal
  if (host === 'cajaviva.app' || host === 'localhost' || host.indexOf('217.142') === 0) {
    return next();
  }

  // solo la pagina principal: el resto (api, fotos, archivos) sigue igual
  if (req.path !== '/' && req.path !== '/index.html') return next();

  try {
    const n = db.prepare('SELECT slug FROM negocio WHERE dominio = ? AND catalogo_activo = 1').get(host);
    if (n) return res.sendFile(path.join(__dirname, 'public', 'catalogo.html'));

    // el dominio llega aca pero no tiene negocio: avisar
    return res.status(404).send(
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;' +
      'margin:80px auto;padding:24px;text-align:center;color:#2C2C2A;">' +
      '<div style="font-size:38px;margin-bottom:12px;">🔌</div>' +
      '<h1 style="font-size:20px;font-weight:500;margin:0 0 8px;">Este dominio todavia no esta conectado</h1>' +
      '<p style="color:#6E6D67;font-size:14px;line-height:1.6;margin:0;">' +
      'Si es tu dominio, entra a tu cuenta de CajaViva y activalo desde ' +
      '<b>Catalogo para compartir</b>.</p></div>'
    );
  } catch (e) {}

  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// la pagina publica del catalogo
app.get('/c/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'catalogo.html'));
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, app: 'CajaViva', hora: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.get('/api/catalogo/publico/:slug', require('./routes/catalogo'));
app.use('/api/empleados', function (req, res, next) {
  // solo /entrar es publica; el resto necesita sesion
  if (req.path === '/entrar' || req.path === '/codigo' || req.path === '/registrar') return next();
  return requiereAuth(req, res, next);
}, require('./routes/empleados'));

app.use('/api/productos', requiereAuth, require('./routes/productos'));
app.use('/api/ventas', requiereAuth, require('./routes/ventas'));
app.use('/api/gastos', requiereAuth, require('./routes/gastos'));
app.use('/api/clientes', requiereAuth, require('./routes/clientes'));
app.use('/api/categorias', requiereAuth, require('./routes/categorias'));
app.use('/api/negocio', requiereAuth, require('./routes/negocio'));
app.use('/api/proveedores', requiereAuth, require('./routes/proveedores'));
app.use('/api/importar', requiereAuth, require('./routes/importar'));
app.use('/api/cierre', requiereAuth, require('./routes/cierre'));
app.use('/api/reportes', requiereAuth, require('./routes/reportes'));
app.use('/api/devoluciones', requiereAuth, require('./routes/devoluciones'));
app.use('/api/cheques', requiereAuth, require('./routes/cheques'));
app.use('/api/variantes', requiereAuth, require('./routes/variantes'));
app.use('/api/recetas', requiereAuth, require('./routes/recetas').router);
app.use('/api/galeria', requiereAuth, require('./routes/galeria'));
app.use('/api/alquileres', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/alquileres'));
app.use('/api/turnos', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/turnos'));
app.use('/api/fotos', function (req, res, next) {
  if (req.path.indexOf('/comprobante/') === 0 || req.path.indexOf('/sena/') === 0 || req.path.indexOf('/reserva/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/fotos'));
app.use('/api/pedidos', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/pedidos'));
app.use('/api/catalogo', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0 || req.path.indexOf('/por-dominio/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/catalogo'));

app.listen(PORT, () => console.log(`CajaViva escuchando en el puerto ${PORT}`));
