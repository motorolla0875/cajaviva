// Crea una cuenta de demostracion completa para el revisor de Apple (o Google):
// un almacen con productos, ventas de las ultimas dos semanas, clientes con fiado,
// gastos, cierres de caja, un proveedor, una empleada, la tienda online activa y
// un pedido web esperando. La cuenta queda libre (no le vence la prueba).
//
// Usa la misma API que la app, contra el servidor que ya esta corriendo.
//
// Uso (en el servidor, dentro de ~/cajaviva):
//   node crear-demo-apple.js            crea la cuenta
//   node crear-demo-apple.js --borrar   la borra para poder crearla de nuevo
require('dotenv').config();
const db = require('./db');

const BASE = 'http://localhost:' + (process.env.PORT || 5200) + '/api';
const USUARIO = 'demo.apple';
const CLAVE = 'CajaViva2026';
const SLUG = 'almacen-don-ramon';

let TOKEN = null;
async function api(metodo, ruta, cuerpo) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const d = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(metodo + ' ' + ruta + ': ' + (d.error || r.status));
  return d;
}

// fecha local de Argentina, n dias atras
function diaAtras(n) {
  const d = new Date(Date.now() - 3 * 3600000 - n * 86400000);
  return d.toISOString().slice(0, 10);
}

// azar con semilla, para que la cuenta salga siempre igual
let semilla = 20261019;
function azar() { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; }
function entre(a, b) { return a + Math.floor(azar() * (b - a + 1)); }

const CATS = ['Bebidas', 'Almacen', 'Lacteos', 'Fiambreria', 'Golosinas', 'Limpieza', 'Verduleria', 'Panificados'];

// nombre, categoria, precio, costo, stock, unidad
const PRODS = [
  ['Coca Cola 2.25L', 'Bebidas', 4200, 2900, 60, 'unidad'],
  ['Agua mineral 1.5L', 'Bebidas', 1500, 900, 80, 'unidad'],
  ['Cerveza 1L', 'Bebidas', 3200, 2200, 60, 'unidad'],
  ['Jugo en polvo', 'Bebidas', 450, 260, 120, 'unidad'],
  ['Yerba mate 1kg', 'Almacen', 6500, 4700, 40, 'unidad'],
  ['Azucar 1kg', 'Almacen', 2400, 1650, 50, 'unidad'],
  ['Fideos 500g', 'Almacen', 1800, 1150, 70, 'unidad'],
  ['Arroz 1kg', 'Almacen', 3100, 2200, 50, 'unidad'],
  ['Aceite de girasol 900ml', 'Almacen', 4200, 3100, 40, 'unidad'],
  ['Pure de tomate 520g', 'Almacen', 1500, 950, 70, 'unidad'],
  ['Leche entera 1L', 'Lacteos', 1700, 1150, 70, 'unidad'],
  ['Yogur bebible 1L', 'Lacteos', 2600, 1750, 30, 'unidad'],
  ['Manteca 200g', 'Lacteos', 3100, 2150, 25, 'unidad'],
  ['Queso cremoso', 'Fiambreria', 11500, 7800, 25, 'kg'],
  ['Jamon cocido', 'Fiambreria', 14000, 9500, 20, 'kg'],
  ['Salame', 'Fiambreria', 16000, 11000, 12, 'kg'],
  ['Alfajor de chocolate', 'Golosinas', 900, 560, 150, 'unidad'],
  ['Chocolate 100g', 'Golosinas', 3400, 2350, 40, 'unidad'],
  ['Caramelos surtidos', 'Golosinas', 800, 480, 90, 'unidad'],
  ['Lavandina 1L', 'Limpieza', 1900, 1200, 40, 'unidad'],
  ['Detergente 500ml', 'Limpieza', 2800, 1950, 30, 'unidad'],
  ['Papel higienico x4', 'Limpieza', 3600, 2500, 40, 'unidad'],
  ['Papa', 'Verduleria', 1200, 700, 120, 'kg'],
  ['Tomate', 'Verduleria', 2800, 1800, 60, 'kg'],
  ['Banana', 'Verduleria', 2200, 1400, 70, 'kg'],
  ['Pan frances', 'Panificados', 2500, 1500, 60, 'kg'],
  ['Medialunas x6', 'Panificados', 4200, 2600, 40, 'unidad']
];

const CLIENTES = [
  ['Marta Gonzalez', '1155551234', 'Belgrano 450'],
  ['Jorge Fernandez', '1155552345', 'San Martin 1200'],
  ['Silvia Romero', '1155553456', 'Rivadavia 88'],
  ['Carlos Benitez', '1155554567', 'Mitre 731']
];

async function borrar() {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(USUARIO);
  if (!u) { console.log('No existe la cuenta ' + USUARIO + '.'); return; }
  const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (r) { return r.name; });
  const HIJAS = [['venta_items', 'venta_id', 'ventas'], ['pedido_web_items', 'pedido_id', 'pedidos_web'],
    ['producto_variantes', 'producto_id', 'productos'], ['receta_items', 'producto_id', 'productos'],
    ['devolucion_items', 'devolucion_id', 'devoluciones'], ['reserva_extras', 'reserva_id', 'reservas']];
  HIJAS.forEach(function (h) {
    if (tablas.indexOf(h[0]) >= 0 && tablas.indexOf(h[2]) >= 0) {
      db.prepare('DELETE FROM ' + h[0] + ' WHERE ' + h[1] + ' IN (SELECT id FROM ' + h[2] + ' WHERE user_id = ?)').run(u.id);
    }
  });
  tablas.forEach(function (t) {
    if (t === 'users') return;
    const tiene = db.prepare('PRAGMA table_info(' + t + ')').all().some(function (c) { return c.name === 'user_id'; });
    if (tiene) db.prepare('DELETE FROM ' + t + ' WHERE user_id = ?').run(u.id);
  });
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  console.log('Cuenta ' + USUARIO + ' borrada.');
}

async function crear() {
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(USUARIO)) {
    console.log('La cuenta ' + USUARIO + ' ya existe. Para rehacerla: node crear-demo-apple.js --borrar');
    return;
  }

  // 1. cuenta nueva con usuario y clave
  TOKEN = (await api('POST', '/auth/nueva', {})).token;
  TOKEN = (await api('POST', '/auth/asegurar', { username: USUARIO, password: CLAVE })).token;
  const userId = (await api('GET', '/auth/yo')).user.id;
  // cuenta de demostracion: sin vencimiento de prueba
  db.prepare("UPDATE users SET plan = 'libre' WHERE id = ?").run(userId);

  // 2. el negocio
  await api('PUT', '/negocio/rubro', { rubro: 'almacen', nombre: 'Almacen Don Ramon' });
  await api('PUT', '/negocio/capacidad', { cap: 'cap_peso', valor: 1 });
  await api('PUT', '/negocio/datos', { pais: 'AR', zonaHoraria: 'America/Argentina/Buenos_Aires', direccion: 'Av. Calchaqui 2350, Quilmes', telefono: '1155550000' });

  // 3. proveedor, categorias y productos
  const prov = (await api('POST', '/proveedores', { nombre: 'Distribuidora Sur', whatsapp: '1155559999' })).id;
  const catIds = {};
  for (const c of CATS) catIds[c] = (await api('POST', '/categorias', { nombre: c })).id;
  const prods = [];
  for (const p of PRODS) {
    const id = (await api('POST', '/productos', {
      nombre: p[0], categoriaId: catIds[p[1]], precioVenta: p[2], precioCosto: p[3],
      stockInicial: p[4], stockMinimo: 5, unidad: p[5], proveedorId: prov
    })).id;
    prods.push({ id: id, nombre: p[0], precio: p[2], unidad: p[5] });
  }
  // la carga de stock inicial queda como gasto de hace 20 dias
  db.prepare("UPDATE gastos SET fecha = ? WHERE user_id = ? AND automatico = 1").run(diaAtras(20), userId);

  // 4. clientes
  const clientes = [];
  for (const c of CLIENTES) clientes.push((await api('POST', '/clientes', { nombre: c[0], whatsapp: c[1], direccion: c[2] })).id);

  // 5. ventas de los ultimos 14 dias (efectivo, transferencia y algunas fiadas)
  let nVentas = 0;
  for (let d = 13; d >= 0; d--) {
    const fecha = diaAtras(d);
    const cuantas = d === 0 ? 6 : entre(8, 14);
    let efectivoDia = 0;
    for (let v = 0; v < cuantas; v++) {
      const items = [];
      const lineas = entre(1, 4);
      for (let i = 0; i < lineas; i++) {
        const p = prods[entre(0, prods.length - 1)];
        if (items.some(function (x) { return x.productoId === p.id; })) continue;
        items.push({ productoId: p.id, cantidad: p.unidad === 'kg' ? [0.25, 0.5, 1, 1.5][entre(0, 3)] : entre(1, 3) });
      }
      const r = azar();
      const fiado = r < 0.12;
      const medio = fiado ? 'cuenta_corriente' : (r < 0.4 ? 'transferencia' : 'efectivo');
      const cuerpo = { items: items, fecha: fecha, medioPago: medio };
      if (fiado) { cuerpo.clienteId = clientes[entre(0, clientes.length - 1)]; cuerpo.montoPagado = 0; }
      const venta = await api('POST', '/ventas', cuerpo);
      if (medio === 'efectivo') efectivoDia += venta.total;
      nVentas++;
    }
    // cierre de caja de los dias anteriores (hoy queda abierta)
    if (d > 0) {
      const diferencia = [0, 0, 0, -500, 0, 200][entre(0, 5)];
      await api('POST', '/cierre', { fecha: fecha, apertura: 20000, esperado: 20000 + efectivoDia, contado: 20000 + efectivoDia + diferencia });
    }
  }

  // 6. un cliente pago parte de lo que debia
  await api('POST', '/clientes/' + clientes[0] + '/pagos', { monto: 5000, fecha: diaAtras(3), nota: 'Pago a cuenta' });

  // 7. gastos del mes
  await api('POST', '/gastos', { descripcion: 'Alquiler del local', monto: 350000, fecha: diaAtras(12) });
  await api('POST', '/gastos', { descripcion: 'Luz', monto: 48000, fecha: diaAtras(8) });
  await api('POST', '/gastos', { descripcion: 'Bolsas y envoltorios', monto: 15000, fecha: diaAtras(5) });

  // 8. una empleada (vende, sin ver costos ni reportes)
  const emp = await api('POST', '/empleados', { nombre: 'Lucia' });

  // 9. la tienda online activa y un pedido esperando
  await api('PUT', '/catalogo/config', {
    slug: SLUG, activo: true, whatsapp: '1155550000', efectivo: true, transferencia: true,
    alias: 'almacen.donramon', titular: 'Ramon Perez', tema: 'verde', fondo: 'claro',
    mensaje: 'Hace tu pedido y te lo llevamos en el dia.', descripcion: 'Almacen de barrio en Quilmes desde 1998.'
  });
  await api('POST', '/pedidos/publico/' + SLUG, {
    nombre: 'Laura Diaz', telefono: '1155557777', direccion: 'Lavalle 320', nota: 'Tocar timbre 2',
    formaPago: 'transferencia',
    items: [{ productoId: prods[0].id, cantidad: 2 }, { productoId: prods[4].id, cantidad: 1 }, { productoId: prods[26].id, cantidad: 1 }]
  });

  console.log('\nCuenta de demostracion lista.');
  console.log('  Usuario:     ' + USUARIO);
  console.log('  Contrasena:  ' + CLAVE);
  console.log('  Negocio:     Almacen Don Ramon (' + prods.length + ' productos, ' + nVentas + ' ventas, ' + clientes.length + ' clientes)');
  console.log('  Empleada:    Lucia, codigo ' + emp.codigo);
  console.log('  Tienda:      https://cajaviva.app/c/' + SLUG);
}

(process.argv.indexOf('--borrar') >= 0 ? borrar() : crear()).catch(function (e) {
  console.error('Error:', e.message);
  process.exit(1);
});
