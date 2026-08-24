const express = require('express');
const db = require('../db');

const router = express.Router();

const CAPS = ['cap_mostrador', 'cap_reparto', 'cap_peso', 'cap_vencimientos',
              'cap_variantes', 'cap_recetas', 'cap_turnos'];

// que capacidades prende cada rubro
const RUBROS = {
  kiosco:        ['cap_mostrador'],
  almacen:       ['cap_mostrador', 'cap_reparto'],
  minimercado:   ['cap_mostrador', 'cap_vencimientos'],
  libreria:      ['cap_mostrador'],
  ferreteria:    ['cap_mostrador', 'cap_reparto'],
  bazar:         ['cap_mostrador'],
  regalos:       ['cap_mostrador'],
  petshop:       ['cap_mostrador'],
  repuestos:     ['cap_mostrador', 'cap_reparto'],
  distribuidora: ['cap_reparto'],
  verduleria:    ['cap_mostrador', 'cap_peso'],
  carniceria:    ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  fiambreria:    ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  dietetica:     ['cap_mostrador', 'cap_peso'],
  panaderia:     ['cap_mostrador', 'cap_vencimientos'],
  farmacia:      ['cap_mostrador', 'cap_vencimientos'],
  perfumeria:    ['cap_mostrador'],
  ropa:          ['cap_mostrador', 'cap_variantes'],
  calzado:       ['cap_mostrador', 'cap_variantes'],
  rotiseria:     ['cap_mostrador', 'cap_recetas'],
  cafeteria:     ['cap_mostrador', 'cap_recetas'],
  peluqueria:    ['cap_turnos'],
  taller:        ['cap_mostrador', 'cap_turnos'],
  otro:          ['cap_mostrador']
};

router.get('/', (req, res) => {
  const n = db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId);
  res.json(n || null);
});

// aplica un rubro: prende las capacidades que le corresponden
router.put('/rubro', (req, res) => {
  const rubro = req.body?.rubro;
  if (!RUBROS[rubro]) return res.status(400).json({ error: 'Rubro no valido.' });

  const nombre = (req.body?.nombre || '').trim() || 'Mi negocio';
  const prendidas = RUBROS[rubro];
  const sets = CAPS.map(c => c + ' = ' + (prendidas.indexOf(c) >= 0 ? 1 : 0)).join(', ');

  db.prepare(`UPDATE negocio SET rubro = ?, nombre = ?, ${sets} WHERE user_id = ?`)
    .run(rubro, nombre, req.userId);

  res.json(db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId));
});

// prende o apaga una capacidad suelta, sin cambiar de rubro
router.put('/capacidad', (req, res) => {
  const cap = req.body?.cap;
  if (CAPS.indexOf(cap) < 0) return res.status(400).json({ error: 'Capacidad no valida.' });
  const valor = req.body?.valor ? 1 : 0;

  db.prepare(`UPDATE negocio SET ${cap} = ? WHERE user_id = ?`).run(valor, req.userId);
  res.json(db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId));
});

// cambiar solo el nombre
router.put('/nombre', (req, res) => {
  const nombre = (req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Ponele un nombre al negocio.' });
  db.prepare('UPDATE negocio SET nombre = ? WHERE user_id = ?').run(nombre, req.userId);
  res.json(db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId));
});

module.exports = router;
