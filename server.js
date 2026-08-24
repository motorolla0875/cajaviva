const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5200;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── usuario de prueba, provisorio hasta que exista el login real ──
const USER_DEMO = 'demo-user-0001';
db.prepare(`INSERT OR IGNORE INTO users (id, username) VALUES (?, 'demo')`).run(USER_DEMO);
db.prepare(`INSERT OR IGNORE INTO negocio (id, user_id, nombre, rubro)
            VALUES ('demo-negocio', ?, 'Kiosco de prueba', 'kiosco')`).run(USER_DEMO);

app.use('/api', (req, res, next) => { req.userId = USER_DEMO; next(); });

app.use('/api/productos', require('./routes/productos'));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, app: 'CajaViva', hora: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`CajaViva escuchando en el puerto ${PORT}`));
