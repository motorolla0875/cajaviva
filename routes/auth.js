const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();
const SECRETO = process.env.JWT_SECRET || 'cajaviva-cambiar-esto-en-produccion';

function firmar(userId) {
  return jwt.sign({ id: userId }, SECRETO, { expiresIn: '365d' });
}

function datosUsuario(id) {
  const u = db.prepare('SELECT id, username, email, plan FROM users WHERE id = ?').get(id);
  const n = db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(id);
  return { user: u, negocio: n || null };
}

function crearCuenta() {
  const id = uuidv4();
  db.prepare('INSERT INTO users (id) VALUES (?)').run(id);
  db.prepare(`
    INSERT INTO negocio (id, user_id, nombre, rubro, cap_mostrador)
    VALUES (?, ?, 'Mi negocio', 'kiosco', 1)
  `).run(uuidv4(), id);
  return id;
}

// ── cuenta automatica: primera vez que se abre la app ──
router.post('/nueva', (req, res) => {
  const id = crearCuenta();
  const d = datosUsuario(id);
  res.json({ token: firmar(id), user: d.user, negocio: d.negocio });
});

// ── quien soy: valida el token guardado ──
router.get('/yo', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sin sesion.' });
  try {
    const p = jwt.verify(token, SECRETO);
    const d = datosUsuario(p.id);
    if (!d.user) return res.status(401).json({ error: 'Sesion invalida.' });
    res.json(d);
  } catch (e) {
    res.status(401).json({ error: 'Sesion invalida.' });
  }
});

// ── asegurar cuenta: ponerle usuario y contrasena a la cuenta automatica ──
router.post('/asegurar', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sin sesion.' });

  let userId;
  try { userId = jwt.verify(token, SECRETO).id; }
  catch (e) { return res.status(401).json({ error: 'Sesion invalida.' }); }

  const { username, password, email } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'Elegi un usuario.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'La contrasena tiene que tener al menos 6 caracteres.' });

  const existe = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username.trim(), userId);
  if (existe) return res.status(400).json({ error: 'Ese usuario ya esta tomado.' });

  db.prepare('UPDATE users SET username = ?, password_hash = ?, email = ? WHERE id = ?')
    .run(username.trim(), bcrypt.hashSync(password, 10), email || null, userId);

  const d = datosUsuario(userId);
  res.json({ token: firmar(userId), user: d.user, negocio: d.negocio });
});

// ── login ──
router.post('/entrar', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Completa usuario y contrasena.' });

  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!u || !u.password_hash || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(400).json({ error: 'Usuario o contrasena incorrectos.' });
  }

  const d = datosUsuario(u.id);
  res.json({ token: firmar(u.id), user: d.user, negocio: d.negocio });
});

// ── middleware: protege el resto de las rutas ──
function requiereAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sin sesion.' });
  try {
    const p = jwt.verify(token, SECRETO);
    req.userId = p.id;
    req.empleadoId = p.emp || null;
    req.esEmpleado = !!p.emp;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sesion invalida.' });
  }
}

module.exports = { router, requiereAuth };
