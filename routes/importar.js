const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

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
      db.prepare(`
        INSERT INTO productos (id, user_id, categoria_id, nombre, codigo_barras,
          precio_venta, precio_costo, unidad, stock, stock_minimo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(uuidv4(), req.userId, categoriaId, nombre, codigo, precioVenta, precioCosto, unidad, stock);
      creados++;
    }

    if (stock > 0 && precioCosto > 0) gastoStock += stock * precioCosto;
  });

  if (gastoStock > 0) {
    db.prepare(`
      INSERT INTO gastos (id, user_id, descripcion, monto, fecha, categoria, automatico)
      VALUES (?, ?, 'Mercaderia importada', ?, ?, 'stock', 1)
    `).run(uuidv4(), req.userId, gastoStock, req.body?.fecha || hoyISO());
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
      db.prepare(`
        INSERT INTO clientes (id, user_id, nombre, whatsapp, direccion, notas, saldo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), req.userId, nombre, whatsapp, direccion, notas, saldo);
      creados++;
    }
  });

  res.json({ creados: creados, actualizados: actualizados, errores: errores });
});

module.exports = router;
