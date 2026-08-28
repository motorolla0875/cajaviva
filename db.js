const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'cajaviva.db'));

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    email TEXT,
    plan TEXT DEFAULT 'gratis',
    plan_trial_ends_at TEXT,
    plan_trial_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS negocio (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre TEXT,
    rubro TEXT,
    cap_mostrador INTEGER NOT NULL DEFAULT 1,
    cap_reparto INTEGER NOT NULL DEFAULT 0,
    cap_peso INTEGER NOT NULL DEFAULT 0,
    cap_vencimientos INTEGER NOT NULL DEFAULT 0,
    cap_variantes INTEGER NOT NULL DEFAULT 0,
    cap_recetas INTEGER NOT NULL DEFAULT 0,
    cap_turnos INTEGER NOT NULL DEFAULT 0,
    moneda TEXT NOT NULL DEFAULT '$',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_negocio_user ON negocio(user_id);

  CREATE TABLE IF NOT EXISTS categorias (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_categorias_user ON categorias(user_id);

  CREATE TABLE IF NOT EXISTS productos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    categoria_id TEXT REFERENCES categorias(id) ON DELETE SET NULL,
    nombre TEXT NOT NULL,
    codigo_barras TEXT,
    precio_venta REAL NOT NULL DEFAULT 0,
    precio_costo REAL,
    unidad TEXT NOT NULL DEFAULT 'unidad',
    stock REAL NOT NULL DEFAULT 0,
    stock_minimo REAL NOT NULL DEFAULT 0,
    foto_url TEXT,
    tiene_variantes INTEGER NOT NULL DEFAULT 0,
    notas TEXT,
    activo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_productos_user ON productos(user_id, activo);
  CREATE INDEX IF NOT EXISTS idx_productos_barras ON productos(user_id, codigo_barras);

  CREATE TABLE IF NOT EXISTS producto_variantes (
    id TEXT PRIMARY KEY,
    producto_id TEXT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    codigo_barras TEXT,
    precio_venta REAL,
    stock REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_variantes_producto ON producto_variantes(producto_id);

  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    whatsapp TEXT,
    direccion TEXT,
    localidad TEXT,
    lat REAL,
    lng REAL,
    dias TEXT,
    descuento_pct REAL NOT NULL DEFAULT 0,
    descuento_tipo TEXT NOT NULL DEFAULT 'total',
    descuento_target_id TEXT,
    descuento_productos TEXT,
    saldo REAL NOT NULL DEFAULT 0,
    notas TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_clientes_user ON clientes(user_id);

  CREATE TABLE IF NOT EXISTS proveedores (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    whatsapp TEXT,
    notas TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_proveedores_user ON proveedores(user_id);

  CREATE TABLE IF NOT EXISTS ventas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cliente_id TEXT REFERENCES clientes(id) ON DELETE SET NULL,
    tipo TEXT NOT NULL DEFAULT 'mostrador',
    fecha TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'cobrada',
    total REAL NOT NULL DEFAULT 0,
    costo_total REAL NOT NULL DEFAULT 0,
    medio_pago TEXT,
    monto_pagado REAL,
    descuento_pct REAL NOT NULL DEFAULT 0,
    notas TEXT,
    device_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ventas_user_fecha ON ventas(user_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id);

  CREATE TABLE IF NOT EXISTS venta_items (
    id TEXT PRIMARY KEY,
    venta_id TEXT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id TEXT,
    variante_id TEXT,
    nombre TEXT NOT NULL,
    cantidad REAL NOT NULL,
    precio_unitario REAL NOT NULL,
    costo_unitario REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_venta_items_venta ON venta_items(venta_id);

  CREATE TABLE IF NOT EXISTS gastos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proveedor_id TEXT REFERENCES proveedores(id) ON DELETE SET NULL,
    descripcion TEXT NOT NULL,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    categoria TEXT,
    automatico INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gastos_user_fecha ON gastos(user_id, fecha);

  CREATE TABLE IF NOT EXISTS pagos_cliente (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    tipo TEXT NOT NULL DEFAULT 'pago',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pagos_cliente ON pagos_cliente(cliente_id);

  CREATE TABLE IF NOT EXISTS cheques (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    venta_id TEXT REFERENCES ventas(id) ON DELETE SET NULL,
    monto REAL NOT NULL,
    fecha_cobro TEXT NOT NULL,
    acreditado INTEGER NOT NULL DEFAULT 0,
    nota TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cheques_user ON cheques(user_id, acreditado);
`);

console.log('Base de datos CajaViva lista.');

module.exports = db;

// ── fecha y hora en la zona del negocio ──
function zonaDe(userId) {
  try {
    const n = db.prepare('SELECT zona_horaria FROM negocio WHERE user_id = ?').get(userId);
    return (n && n.zona_horaria) || 'America/Argentina/Buenos_Aires';
  } catch (e) { return 'America/Argentina/Buenos_Aires'; }
}

// devuelve YYYY-MM-DD en la zona del negocio
function hoyEn(userId) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: zonaDe(userId) });
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}

// devuelve los minutos desde medianoche en la zona del negocio
function minutosAhoraEn(userId) {
  try {
    const h = new Date().toLocaleTimeString('en-GB', {
      timeZone: zonaDe(userId), hour: '2-digit', minute: '2-digit'
    });
    const p = h.split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1]);
  } catch (e) {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

module.exports.zonaDe = zonaDe;
module.exports.hoyEn = hoyEn;
module.exports.minutosAhoraEn = minutosAhoraEn;
