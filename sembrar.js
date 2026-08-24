const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const USER = '09582e08-3d72-4439-8913-6c11d1116bc3';
const hoy = new Date().toISOString().slice(0, 10);

const CATS = ['Bebidas', 'Golosinas', 'Galletitas', 'Cigarrillos', 'Almacen', 'Limpieza', 'Panificados'];

const PRODS = [
  ['Coca Cola 500ml', 'Bebidas', 1800, 1150, 24],
  ['Coca Cola 2.25L', 'Bebidas', 4200, 2900, 12],
  ['Sprite 500ml', 'Bebidas', 1700, 1100, 18],
  ['Agua mineral 500ml', 'Bebidas', 1100, 620, 30],
  ['Cerveza Quilmes 1L', 'Bebidas', 3200, 2200, 24],
  ['Fernet Branca 750ml', 'Bebidas', 16500, 12800, 6],
  ['Jugo Cepita 1L', 'Bebidas', 2300, 1550, 12],

  ['Alfajor Jorgito', 'Golosinas', 900, 560, 40],
  ['Alfajor Guaymallen', 'Golosinas', 650, 390, 50],
  ['Chocolate Milka 100g', 'Golosinas', 3400, 2350, 15],
  ['Chupetin Pico Dulce', 'Golosinas', 350, 190, 80],
  ['Caramelos Sugus', 'Golosinas', 800, 480, 40],
  ['Mantecol 120g', 'Golosinas', 2100, 1400, 12],

  ['Oreo 118g', 'Galletitas', 2200, 1500, 20],
  ['Pepitos 118g', 'Galletitas', 1900, 1280, 18],
  ['Criollitas 200g', 'Galletitas', 1600, 1050, 24],
  ['Rumba 100g', 'Galletitas', 1400, 900, 20],

  ['Marlboro Box 20', 'Cigarrillos', 4800, 4150, 20],
  ['Philip Morris 20', 'Cigarrillos', 4500, 3900, 20],

  ['Yerba Playadito 1kg', 'Almacen', 6500, 4700, 10],
  ['Azucar Ledesma 1kg', 'Almacen', 2400, 1650, 15],
  ['Fideos Matarazzo 500g', 'Almacen', 1800, 1150, 20],
  ['Aceite Natura 900ml', 'Almacen', 4200, 3100, 12],
  ['Arroz Gallo 1kg', 'Almacen', 3100, 2200, 12],
  ['Puré de tomate 520g', 'Almacen', 1500, 950, 24],

  ['Lavandina 1L', 'Limpieza', 1900, 1200, 12],
  ['Detergente Magistral 300ml', 'Limpieza', 2800, 1950, 10],
  ['Papel higienico x4', 'Limpieza', 3600, 2500, 15],
  ['Jabon en polvo 800g', 'Limpieza', 5200, 3800, 8],

  ['Pan lactal Bimbo', 'Panificados', 3800, 2700, 8],
  ['Facturas x6', 'Panificados', 4500, 2800, 6],
  ['Medialunas x3', 'Panificados', 2400, 1400, 10]
];

const catIds = {};
for (const nombre of CATS) {
  const existe = db.prepare('SELECT id FROM categorias WHERE user_id = ? AND nombre = ?').get(USER, nombre);
  if (existe) { catIds[nombre] = existe.id; continue; }
  const id = uuidv4();
  db.prepare('INSERT INTO categorias (id, user_id, nombre) VALUES (?, ?, ?)').run(id, USER, nombre);
  catIds[nombre] = id;
}

let creados = 0, gastoTotal = 0;
for (const [nombre, cat, venta, costo, stock] of PRODS) {
  const existe = db.prepare('SELECT id FROM productos WHERE user_id = ? AND nombre = ?').get(USER, nombre);
  if (existe) continue;
  db.prepare(`
    INSERT INTO productos (id, user_id, categoria_id, nombre, precio_venta, precio_costo, unidad, stock, stock_minimo)
    VALUES (?, ?, ?, ?, ?, ?, 'unidad', ?, ?)
  `).run(uuidv4(), USER, catIds[cat], nombre, venta, costo, stock, Math.max(3, Math.round(stock * 0.15)));
  creados++;
  gastoTotal += stock * costo;
}

if (gastoTotal > 0) {
  db.prepare(`
    INSERT INTO gastos (id, user_id, descripcion, monto, fecha, categoria, automatico)
    VALUES (?, ?, 'Carga inicial de mercaderia', ?, ?, 'stock', 1)
  `).run(uuidv4(), USER, gastoTotal, hoy);
}

console.log('Categorias: ' + CATS.length);
console.log('Productos creados: ' + creados);
console.log('Gasto de mercaderia: $' + Math.round(gastoTotal).toLocaleString('es-AR'));
