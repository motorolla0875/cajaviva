// Carga 3 productos de electrónica en la cuenta de prueba "apple" (para la revisión de Apple).
// Uso en el servidor: node crear-productos-apple.js
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const u = db.prepare('SELECT id FROM users WHERE username = ?').get('apple');
if (!u) { console.log('No existe el usuario "apple". Primero asegurá la cuenta con ese usuario.'); process.exit(1); }

let cat = db.prepare('SELECT id FROM categorias WHERE user_id = ? AND nombre = ?').get(u.id, 'Electrónica');
if (!cat) { cat = { id: uuidv4() }; db.prepare('INSERT INTO categorias (id, user_id, nombre) VALUES (?, ?, ?)').run(cat.id, u.id, 'Electrónica'); }

const PRODS = [
  ['Auriculares Bluetooth', 25000, 15000, 12],
  ['Cargador USB-C 20W', 12000, 7000, 20],
  ['Parlante portátil', 45000, 28000, 6]
];
PRODS.forEach(([nombre, pv, pc, stock]) => {
  if (db.prepare('SELECT id FROM productos WHERE user_id = ? AND nombre = ? AND activo = 1').get(u.id, nombre)) { console.log('Ya estaba:', nombre); return; }
  db.prepare('INSERT INTO productos (id, user_id, categoria_id, nombre, precio_venta, precio_costo, unidad, stock, stock_minimo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), u.id, cat.id, nombre, pv, pc, 'unidad', stock, 2);
  console.log('Cargado:', nombre);
});
console.log('Listo.');
