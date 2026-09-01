const express = require('express');
const db = require('../db');

const router = express.Router();

try { db.exec("ALTER TABLE negocio ADD COLUMN pais TEXT NOT NULL DEFAULT 'AR'"); } catch (e) {}
try { db.exec("ALTER TABLE negocio ADD COLUMN zona_horaria TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires'"); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN direccion TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE negocio ADD COLUMN telefono TEXT'); } catch (e) {}

const CAPS = ['cap_mostrador', 'cap_reparto', 'cap_peso', 'cap_vencimientos',
              'cap_variantes', 'cap_recetas', 'cap_turnos', 'cap_alquiler', 'cap_canchas', 'cap_mesas'];

// que capacidades prende cada rubro
const RUBROS = {
  kiosco:        ['cap_mostrador', 'cap_vencimientos'],
  almacen:       ['cap_mostrador', 'cap_reparto', 'cap_vencimientos'],
  minimercado:   ['cap_mostrador', 'cap_vencimientos'],
  libreria:      ['cap_mostrador'],
  ferreteria:    ['cap_mostrador', 'cap_reparto'],
  bazar:         ['cap_mostrador'],
  regalos:       ['cap_mostrador'],
  petshop:       ['cap_mostrador'],
  repuestos:     ['cap_mostrador', 'cap_reparto'],
  distribuidora: ['cap_mostrador', 'cap_reparto'],
  verduleria:    ['cap_mostrador', 'cap_peso'],
  carniceria:    ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  fiambreria:    ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  dietetica:     ['cap_mostrador', 'cap_peso'],
  panaderia:     ['cap_mostrador', 'cap_vencimientos'],
  farmacia:      ['cap_mostrador', 'cap_vencimientos'],
  perfumeria:    ['cap_mostrador', 'cap_vencimientos'],
  ropa:          ['cap_mostrador', 'cap_variantes'],
  calzado:       ['cap_mostrador', 'cap_variantes'],
  rotiseria:     ['cap_mostrador', 'cap_recetas'],
  cafeteria:     ['cap_mostrador', 'cap_recetas'],
  peluqueria:    ['cap_mostrador', 'cap_turnos'],
  barberia:      ['cap_mostrador', 'cap_turnos'],
  estetica:      ['cap_mostrador', 'cap_turnos'],
  consultorio:   ['cap_turnos'],
  gomeria:       ['cap_mostrador', 'cap_turnos'],
  lavadero:      ['cap_mostrador', 'cap_turnos'],
  taller:        ['cap_mostrador', 'cap_turnos'],
  bijouterie:    ['cap_mostrador'],
  jugueteria:    ['cap_mostrador'],
  electronica:   ['cap_mostrador'],
  pinturería:    ['cap_mostrador'],
  corralon:      ['cap_mostrador', 'cap_reparto'],
  forrajeria:    ['cap_mostrador', 'cap_reparto'],
  vivero:        ['cap_mostrador'],
  tabaqueria:    ['cap_mostrador', 'cap_vencimientos'],
  vinoteca:      ['cap_mostrador', 'cap_vencimientos'],
  pescaderia:    ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  polleria:      ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  granja:        ['cap_mostrador', 'cap_peso', 'cap_vencimientos'],
  almacen_natural: ['cap_mostrador', 'cap_peso'],
  lenceria:      ['cap_mostrador', 'cap_variantes'],
  deportiva:     ['cap_mostrador', 'cap_variantes'],
  blanqueria:    ['cap_mostrador', 'cap_variantes'],
  marroquineria: ['cap_mostrador', 'cap_variantes'],
  uniformes:     ['cap_mostrador', 'cap_variantes'],
  pizzeria:      ['cap_mostrador', 'cap_recetas'],
  heladeria:     ['cap_mostrador', 'cap_recetas'],
  foodtruck:     ['cap_mostrador', 'cap_recetas'],
  bar:           ['cap_mostrador', 'cap_recetas'],
  casa_comidas:  ['cap_mostrador', 'cap_recetas'],
  manicura:      ['cap_mostrador', 'cap_turnos'],
  tatuajes:      ['cap_mostrador', 'cap_turnos'],
  masajes:       ['cap_mostrador', 'cap_turnos'],
  odontologia:   ['cap_turnos'],
  kinesiologia:  ['cap_turnos'],
  nutricion:     ['cap_turnos'],
  psicologia:    ['cap_turnos'],
  veterinaria:   ['cap_mostrador', 'cap_turnos'],
  fotografia:    ['cap_mostrador', 'cap_turnos'],
  canchas:       ['cap_turnos'],
  clases:        ['cap_turnos'],
  entrenador:    ['cap_turnos'],
  costurera:     ['cap_mostrador', 'cap_turnos'],
  chapa:         ['cap_mostrador', 'cap_turnos'],
  soda:          ['cap_mostrador', 'cap_reparto'],
  gas:           ['cap_mostrador', 'cap_reparto'],
  hielo:         ['cap_mostrador', 'cap_reparto'],
  lacteos:       ['cap_mostrador', 'cap_reparto', 'cap_vencimientos'],
  panaderia_reparto: ['cap_mostrador', 'cap_reparto', 'cap_vencimientos'],
  diarios:       ['cap_mostrador', 'cap_reparto'],
  'leña':        ['cap_mostrador', 'cap_reparto'],
  mayorista:     ['cap_mostrador', 'cap_reparto'],
  restaurante:      ['cap_mostrador', 'cap_mesas', 'cap_recetas'],
  bar_salon:        ['cap_mostrador', 'cap_mesas'],
  pizzeria_salon:   ['cap_mostrador', 'cap_mesas', 'cap_recetas'],
  parrilla:         ['cap_mostrador', 'cap_mesas', 'cap_recetas'],
  cafeteria_salon:  ['cap_mostrador', 'cap_mesas'],
  heladeria_salon:  ['cap_mostrador', 'cap_mesas'],
  resto_bar:        ['cap_mostrador', 'cap_mesas'],
  cabanas:       ['cap_mostrador', 'cap_alquiler'],
  padel:         ['cap_mostrador', 'cap_canchas'],
  futbol5:       ['cap_mostrador', 'cap_canchas'],
  tenis:         ['cap_mostrador', 'cap_canchas'],
  salas:         ['cap_mostrador', 'cap_canchas'],
  hotel:         ['cap_mostrador', 'cap_alquiler'],
  salon:         ['cap_mostrador', 'cap_alquiler'],
  canchas_alq:   ['cap_mostrador', 'cap_canchas'],
  equipos:       ['cap_mostrador', 'cap_alquiler'],
  vehiculos:     ['cap_mostrador', 'cap_alquiler'],
  eventos:       ['cap_mostrador', 'cap_alquiler'],
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


// ── datos del negocio: pais, zona, contacto ──
router.put('/datos', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const b = req.body || {};

  db.prepare(`
    UPDATE negocio SET
      pais = COALESCE(?, pais),
      zona_horaria = COALESCE(?, zona_horaria),
      direccion = COALESCE(?, direccion),
      telefono = COALESCE(?, telefono)
    WHERE user_id = ?
  `).run(b.pais || null, b.zonaHoraria || null, b.direccion || null, b.telefono || null, req.userId);

  res.json(db.prepare('SELECT * FROM negocio WHERE user_id = ?').get(req.userId));
});

module.exports = router;
