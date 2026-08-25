const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();
const SECRETO = process.env.JWT_SECRET || 'cajaviva-cambiar-esto-en-produccion';

db.exec(`
  CREATE TABLE IF NOT EXISTS empleados (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nombre TEXT NOT NULL,
    codigo TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    ultimo_acceso TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_empleados_codigo ON empleados(codigo);
`);

// la columna que dice quien hizo cada venta
try { db.exec('ALTER TABLE ventas ADD COLUMN empleado_id TEXT'); } catch (e) {}

// credenciales propias del empleado
try { db.exec('ALTER TABLE empleados ADD COLUMN username TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE empleados ADD COLUMN password_hash TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE empleados ADD COLUMN codigo_usado INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

function nuevoCodigo() {
  let c;
  do {
    c = String(Math.floor(100000 + Math.random() * 900000));
  } while (db.prepare('SELECT id FROM empleados WHERE codigo = ?').get(c));
  return c;
}

// ── listar ──
router.get('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const rows = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM ventas v WHERE v.empleado_id = e.id) AS ventas,
      (SELECT COALESCE(SUM(v.total), 0) FROM ventas v WHERE v.empleado_id = e.id) AS vendido
    FROM empleados e WHERE e.user_id = ? ORDER BY e.nombre
  `).all(req.userId);
  res.json(rows);
});

// ── crear ──
router.post('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre.' });

  const id = uuidv4();
  const codigo = nuevoCodigo();
  db.prepare('INSERT INTO empleados (id, user_id, nombre, codigo) VALUES (?, ?, ?, ?)')
    .run(id, req.userId, nombre, codigo);

  res.json({ id: id, codigo: codigo });
});

// ── activar o desactivar ──
router.put('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const e = db.prepare('SELECT * FROM empleados WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!e) return res.status(404).json({ error: 'Empleado no encontrado.' });

  const nombre = (req.body?.nombre || e.nombre).trim();
  const activo = req.body?.activo != null ? (req.body.activo ? 1 : 0) : e.activo;

  db.prepare('UPDATE empleados SET nombre = ?, activo = ? WHERE id = ?').run(nombre, activo, e.id);
  res.json({ ok: true });
});

// ── nuevo codigo ──
router.post('/:id/codigo', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const e = db.prepare('SELECT id FROM empleados WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!e) return res.status(404).json({ error: 'Empleado no encontrado.' });

  const codigo = nuevoCodigo();
  db.prepare('UPDATE empleados SET codigo = ?, codigo_usado = 0 WHERE id = ?').run(codigo, e.id);
  res.json({ codigo: codigo });
});

// ── borrar ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('DELETE FROM empleados WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

function sesionEmpleado(e) {
  db.prepare("UPDATE empleados SET ultimo_acceso = datetime('now') WHERE id = ?").run(e.id);
  const token = jwt.sign({ id: e.user_id, emp: e.id }, SECRETO, { expiresIn: '30d' });
  const u = db.prepare('SELECT id, username, plan FROM users WHERE id = ?').get(e.user_id);
  const n = db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(e.user_id);
  return { token: token, user: u, negocio: n, empleado: { id: e.id, nombre: e.nombre } };
}

// ── validar el codigo de invitacion ──
router.post('/codigo', (req, res) => {
  const codigo = String(req.body?.codigo || '').trim();
  if (!/^\d{6}$/.test(codigo)) return res.status(400).json({ error: 'El codigo tiene 6 numeros.' });

  const e = db.prepare('SELECT * FROM empleados WHERE codigo = ? AND activo = 1').get(codigo);
  if (!e) return res.status(400).json({ error: 'Codigo incorrecto o dado de baja.' });
  if (e.codigo_usado) return res.status(400).json({ error: 'Ese codigo ya se uso. Pedile uno nuevo al dueño.' });

  const neg = db.prepare('SELECT nombre FROM negocio WHERE user_id = ?').get(e.user_id);
  res.json({ ok: true, nombre: e.nombre, negocio: neg ? neg.nombre : 'el negocio' });
});

// ── el empleado crea su usuario con el codigo ──
router.post('/registrar', (req, res) => {
  const codigo = String(req.body?.codigo || '').trim();
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  const e = db.prepare('SELECT * FROM empleados WHERE codigo = ? AND activo = 1').get(codigo);
  if (!e) return res.status(400).json({ error: 'Codigo incorrecto o dado de baja.' });
  if (e.codigo_usado) return res.status(400).json({ error: 'Ese codigo ya se uso.' });

  if (username.length < 3) return res.status(400).json({ error: 'El usuario necesita al menos 3 letras.' });
  if (password.length < 4) return res.status(400).json({ error: 'La contraseña necesita al menos 4 caracteres.' });

  const tomado = db.prepare('SELECT id FROM empleados WHERE username = ? AND user_id = ?').get(username, e.user_id);
  if (tomado) return res.status(400).json({ error: 'Ese usuario ya esta tomado en este negocio.' });

  db.prepare('UPDATE empleados SET username = ?, password_hash = ?, codigo_usado = 1 WHERE id = ?')
    .run(username, bcrypt.hashSync(password, 10), e.id);

  res.json(sesionEmpleado(e));
});

// ── el empleado entra con su usuario ──
router.post('/entrar', (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  if (!username || !password) return res.status(400).json({ error: 'Completa usuario y contraseña.' });

  const e = db.prepare('SELECT * FROM empleados WHERE username = ? AND activo = 1').get(username);
  if (!e || !e.password_hash || !bcrypt.compareSync(password, e.password_hash)) {
    return res.status(400).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  res.json(sesionEmpleado(e));
});

module.exports = router;
