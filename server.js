require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { router: authRouter, requiereAuth } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 5200;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, app: 'CajaViva', hora: new Date().toISOString() });
});

app.use('/api/auth', authRouter);

app.use('/api/productos', requiereAuth, require('./routes/productos'));
app.use('/api/ventas', requiereAuth, require('./routes/ventas'));
app.use('/api/gastos', requiereAuth, require('./routes/gastos'));
app.use('/api/clientes', requiereAuth, require('./routes/clientes'));
app.use('/api/categorias', requiereAuth, require('./routes/categorias'));
app.use('/api/negocio', requiereAuth, require('./routes/negocio'));
app.use('/api/proveedores', requiereAuth, require('./routes/proveedores'));

app.listen(PORT, () => console.log(`CajaViva escuchando en el puerto ${PORT}`));
