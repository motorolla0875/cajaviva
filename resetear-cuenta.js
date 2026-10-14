// Deja vacia una cuenta: borra productos, ventas, clientes, caja, fotos, etc.
// NO borra el usuario (sigue entrando con su clave), ni la configuracion del negocio,
// ni la conexion con MercadoLibre.
//
// Uso:
//   node resetear-cuenta.js diego --ver   (solo muestra cuanto hay, no borra nada)
//   node resetear-cuenta.js diego         (borra de verdad)
const db = require('./db');

const nombre = process.argv[2];
const soloVer = process.argv.indexOf('--ver') !== -1;
const u = nombre && db.prepare('SELECT id, username FROM users WHERE username = ?').get(nombre);
if (!u) { console.log('No encontre el usuario "' + (nombre || '') + '".'); process.exit(1); }

const SE_QUEDAN = new Set(['users', 'negocio', 'mercadolibre_conexion', 'reset_tokens']);
const HIJAS = [
  ['devolucion_items', 'devolucion_id', 'devoluciones'],
  ['reserva_extras', 'reserva_id', 'reservas'],
  ['pedido_web_items', 'pedido_id', 'pedidos_web'],
  ['receta_items', 'producto_id', 'productos'],
  ['producto_variantes', 'producto_id', 'productos'],
  ['venta_items', 'venta_id', 'ventas']
];
const existe = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  .filter(t => !SE_QUEDAN.has(t) && db.prepare('PRAGMA table_info(' + t + ')').all().some(c => c.name === 'user_id'));

console.log('Cuenta:', u.username);
for (const t of tablas) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM ' + t + ' WHERE user_id = ?').get(u.id).n;
  if (n) console.log('  ' + t + ': ' + n);
}
if (soloVer) { console.log('(solo consulta: no se borro nada)'); process.exit(0); }

db.exec('BEGIN');
try {
  for (const [hija, col, madre] of HIJAS) {
    if (existe(hija) && existe(madre)) db.prepare('DELETE FROM ' + hija + ' WHERE ' + col + ' IN (SELECT id FROM ' + madre + ' WHERE user_id = ?)').run(u.id);
  }
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    for (const t of tablas) {
      try { db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(u.id); } catch (e) { if (vuelta === 3) throw e; }
    }
  }
  db.exec('COMMIT');
  console.log('Listo: la cuenta "' + u.username + '" quedo vacia (el usuario, el negocio y MercadoLibre siguen).');
} catch (e) {
  db.exec('ROLLBACK');
  console.log('ERROR, no se borro nada:', e.message);
}
