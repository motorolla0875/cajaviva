const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// registro de importaciones, para poder deshacerlas
db.exec(`
  CREATE TABLE IF NOT EXISTS importaciones (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    ids TEXT NOT NULL,
    gasto_id TEXT,
    cantidad INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function hoyISO() { return new Date().toISOString().slice(0, 10); }

function aNumero(v) {
  if (v == null || v === '') return null;
  let t = String(v).trim().replace(/\$/g, '').replace(/\s/g, '');
  // 1.500,50 -> 1500.50   |   1,500.50 -> 1500.50
  if (t.indexOf(',') >= 0 && t.indexOf('.') >= 0) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (t.indexOf(',') >= 0) {
    t = t.replace(',', '.');
  }
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

// ── importar productos ──
router.post('/productos', (req, res) => {
  const filas = req.body?.filas;
  if (!Array.isArray(filas) || filas.length === 0) {
    return res.status(400).json({ error: 'No hay filas para importar.' });
  }

  const cats = {};
  db.prepare('SELECT id, nombre FROM categorias WHERE user_id = ?').all(req.userId)
    .forEach(function (c) { cats[c.nombre.toLowerCase()] = c.id; });

  let creados = 0, actualizados = 0, gastoStock = 0;
  const errores = [];
  const nuevosIds = [];

  filas.forEach(function (f, i) {
    const nombre = (f.nombre || '').toString().trim();
    if (!nombre) { errores.push('Fila ' + (i + 1) + ': sin nombre'); return; }

    const precioVenta = aNumero(f.precioVenta);
    if (precioVenta == null || precioVenta < 0) { errores.push('Fila ' + (i + 1) + ': precio invalido (' + nombre + ')'); return; }

    const precioCosto = aNumero(f.precioCosto);
    const stock = aNumero(f.stock) || 0;
    const codigo = f.codigoBarras ? String(f.codigoBarras).trim().replace(/\D/g, '') : null;
    const unidad = ['kg', 'litro'].indexOf((f.unidad || '').toLowerCase()) >= 0 ? f.unidad.toLowerCase() : 'unidad';

    // categoria: se crea sola si no existe
    let categoriaId = null;
    const catNombre = (f.categoria || '').toString().trim();
    if (catNombre) {
      const clave = catNombre.toLowerCase();
      if (!cats[clave]) {
        const idc = uuidv4();
        db.prepare('INSERT INTO categorias (id, user_id, nombre) VALUES (?, ?, ?)').run(idc, req.userId, catNombre);
        cats[clave] = idc;
      }
      categoriaId = cats[clave];
    }

    // si ya existe por codigo o por nombre, se actualiza
    let existente = null;
    if (codigo) existente = db.prepare('SELECT id FROM productos WHERE user_id = ? AND codigo_barras = ?').get(req.userId, codigo);
    if (!existente) existente = db.prepare('SELECT id FROM productos WHERE user_id = ? AND LOWER(nombre) = LOWER(?)').get(req.userId, nombre);

    if (existente) {
      db.prepare(`
        UPDATE productos SET precio_venta = ?, precio_costo = COALESCE(?, precio_costo),
          categoria_id = COALESCE(?, categoria_id), codigo_barras = COALESCE(?, codigo_barras),
          unidad = ?, stock = stock + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(precioVenta, precioCosto, categoriaId, codigo, unidad, stock, existente.id);
      actualizados++;
    } else {
      const idNuevo = uuidv4();
      db.prepare(`
        INSERT INTO productos (id, user_id, categoria_id, nombre, codigo_barras,
          precio_venta, precio_costo, unidad, stock, stock_minimo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(idNuevo, req.userId, categoriaId, nombre, codigo, precioVenta, precioCosto, unidad, stock);
      nuevosIds.push(idNuevo);
      creados++;
    }

    if (stock > 0 && precioCosto > 0) gastoStock += stock * precioCosto;
  });

  let gastoId = null;
  if (gastoStock > 0) {
    gastoId = uuidv4();
    db.prepare(`
      INSERT INTO gastos (id, user_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, 'Mercaderia importada', ?, ?, 'stock', 1)
    `).run(gastoId, req.userId, gastoStock, req.body?.fecha || hoyISO());
  }

  if (nuevosIds.length > 0 || gastoId) {
    db.prepare('INSERT INTO importaciones (id, user_id, tipo, ids, gasto_id, cantidad) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), req.userId, 'productos', JSON.stringify(nuevosIds), gastoId, nuevosIds.length);
  }

  res.json({ creados: creados, actualizados: actualizados, gastoStock: gastoStock, errores: errores });
});

// ── importar clientes ──
router.post('/clientes', (req, res) => {
  const filas = req.body?.filas;
  if (!Array.isArray(filas) || filas.length === 0) {
    return res.status(400).json({ error: 'No hay filas para importar.' });
  }

  let creados = 0, actualizados = 0;
  const errores = [];
  const nuevosIds = [];

  filas.forEach(function (f, i) {
    const nombre = (f.nombre || '').toString().trim();
    if (!nombre) { errores.push('Fila ' + (i + 1) + ': sin nombre'); return; }

    const whatsapp = f.whatsapp ? String(f.whatsapp).trim() : null;
    const direccion = f.direccion ? String(f.direccion).trim() : null;
    const notas = f.notas ? String(f.notas).trim() : null;
    const saldo = aNumero(f.saldo) || 0;

    const existe = db.prepare('SELECT id FROM clientes WHERE user_id = ? AND LOWER(nombre) = LOWER(?)').get(req.userId, nombre);

    if (existe) {
      db.prepare('UPDATE clientes SET whatsapp = COALESCE(?, whatsapp), direccion = COALESCE(?, direccion), notas = COALESCE(?, notas) WHERE id = ?')
        .run(whatsapp, direccion, notas, existe.id);
      actualizados++;
    } else {
      const idNuevo = uuidv4();
      db.prepare(`
        INSERT INTO clientes (id, user_id, nombre, whatsapp, direccion, notas, saldo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(idNuevo, req.userId, nombre, whatsapp, direccion, notas, saldo);
      nuevosIds.push(idNuevo);
      creados++;
    }
  });

  if (nuevosIds.length > 0) {
    db.prepare('INSERT INTO importaciones (id, user_id, tipo, ids, gasto_id, cantidad) VALUES (?, ?, ?, ?, NULL, ?)')
      .run(uuidv4(), req.userId, 'clientes', JSON.stringify(nuevosIds), nuevosIds.length);
  }

  res.json({ creados: creados, actualizados: actualizados, errores: errores });
});

// ── ver la ultima importacion ──
router.get('/ultima', (req, res) => {
  const u = db.prepare('SELECT * FROM importaciones WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.userId);
  res.json(u || null);
});

// ── deshacer una importacion ──
router.delete('/:id', (req, res) => {
  const imp = db.prepare('SELECT * FROM importaciones WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!imp) return res.status(404).json({ error: 'Importacion no encontrada.' });

  const ids = JSON.parse(imp.ids);
  let borrados = 0, conVentas = 0;

  ids.forEach(function (id) {
    if (imp.tipo === 'productos') {
      const vendido = db.prepare('SELECT COUNT(*) AS n FROM venta_items WHERE producto_id = ?').get(id);
      if (vendido.n > 0) { conVentas++; return; }
      db.prepare('DELETE FROM productos WHERE id = ? AND user_id = ?').run(id, req.userId);
    } else {
      const conVenta = db.prepare('SELECT COUNT(*) AS n FROM ventas WHERE cliente_id = ?').get(id);
      if (conVenta.n > 0) { conVentas++; return; }
      db.prepare('DELETE FROM clientes WHERE id = ? AND user_id = ?').run(id, req.userId);
    }
    borrados++;
  });

  if (imp.gasto_id) db.prepare('DELETE FROM gastos WHERE id = ? AND user_id = ?').run(imp.gasto_id, req.userId);
  db.prepare('DELETE FROM importaciones WHERE id = ?').run(imp.id);

  res.json({ borrados: borrados, conVentas: conVentas });
});

module.exports = router;
