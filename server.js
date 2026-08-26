require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { router: authRouter, requiereAuth } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 5200;

app.use(express.json());
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
app.use('/api/turnos', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/turnos'));
app.use('/api/fotos', function (req, res, next) {
  if (req.path.indexOf('/comprobante/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/fotos'));
app.use('/api/pedidos', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/pedidos'));
app.use('/api/catalogo', function (req, res, next) {
  if (req.path.indexOf('/publico/') === 0) return next();
  return requiereAuth(req, res, next);
}, require('./routes/catalogo'));

app.listen(PORT, () => console.log(`CajaViva escuchando en el puerto ${PORT}`));
