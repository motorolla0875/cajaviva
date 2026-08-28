const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const CARPETA = path.join(__dirname, '..', 'public', 'fotos');
if (!fs.existsSync(CARPETA)) fs.mkdirSync(CARPETA, { recursive: true });

try { db.exec('ALTER TABLE productos ADD COLUMN foto_mini TEXT'); } catch (e) {}

// el navegador ya manda la imagen chica y comprimida
const subir = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }
});

function guardarArchivo(buffer, nombre) {
  fs.writeFileSync(path.join(CARPETA, nombre), buffer);
}

// ── subir la foto de un producto ──
router.post('/producto/:id', subir.fields([{ name: 'grande' }, { name: 'mini' }]), (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  if (!req.files || !req.files.grande) return res.status(400).json({ error: 'No llego la imagen.' });

  // borrar las anteriores
  [p.foto_url, p.foto_mini].forEach(function (f) {
    if (!f) return;
    const ruta = path.join(CARPETA, path.basename(f));
    if (fs.existsSync(ruta)) { try { fs.unlinkSync(ruta); } catch (e) {} }
  });

  const base = uuidv4();
  const grande = base + '.webp';
  const mini = base + '-m.webp';

  guardarArchivo(req.files.grande[0].buffer, grande);
  if (req.files.mini) guardarArchivo(req.files.mini[0].buffer, mini);

  db.prepare('UPDATE productos SET foto_url = ?, foto_mini = ? WHERE id = ?')
    .run('/fotos/' + grande, req.files.mini ? '/fotos/' + mini : null, p.id);

  res.json({ foto: '/fotos/' + grande, mini: req.files.mini ? '/fotos/' + mini : null });
});

// ── borrar la foto ──
router.delete('/producto/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const p = db.prepare('SELECT * FROM productos WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado.' });

  [p.foto_url, p.foto_mini].forEach(function (f) {
    if (!f) return;
    const ruta = path.join(CARPETA, path.basename(f));
    if (fs.existsSync(ruta)) { try { fs.unlinkSync(ruta); } catch (e) {} }
  });

  db.prepare('UPDATE productos SET foto_url = NULL, foto_mini = NULL WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ── cuanto espacio ocupan ──
router.get('/uso', (req, res) => {
  const conFoto = db.prepare('SELECT COUNT(*) AS n FROM productos WHERE user_id = ? AND foto_url IS NOT NULL').get(req.userId);
  res.json({ conFoto: conFoto.n });
});


// ── comprobante de pago de un pedido (publico) ──
router.post('/comprobante/:pedidoId', subir.single('foto'), (req, res) => {
  const ped = db.prepare('SELECT * FROM pedidos_web WHERE id = ?').get(req.params.pedidoId);
  if (!ped) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'No llego la imagen.' });

  const nombre = uuidv4() + '-comp.webp';
  guardarArchivo(req.file.buffer, nombre);

  try { db.exec('ALTER TABLE pedidos_web ADD COLUMN comprobante TEXT'); } catch (e) {}
  try { db.exec("ALTER TABLE pedidos_web ADD COLUMN pago_estado TEXT NOT NULL DEFAULT 'pendiente'"); } catch (e) {}

  db.prepare("UPDATE pedidos_web SET comprobante = ?, pago_estado = 'enviado' WHERE id = ?")
    .run('/fotos/' + nombre, ped.id);

  res.json({ ok: true });
});


// ── comprobante de seña de un turno (publico) ──
router.post('/sena/:turnoId', subir.single('foto'), (req, res) => {
  const t = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.turnoId);
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'No llego la imagen.' });

  const nombre = uuidv4() + '-sena.webp';
  guardarArchivo(req.file.buffer, nombre);

  db.prepare("UPDATE turnos SET comprobante = ?, sena_estado = 'enviado' WHERE id = ?")
    .run('/fotos/' + nombre, t.id);

  res.json({ ok: true });
});


// ── banner del catalogo ──
router.post('/banner', subir.single('foto'), (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  if (!req.file) return res.status(400).json({ error: 'No llego la imagen.' });

  const n = db.prepare('SELECT banner FROM negocio WHERE user_id = ?').get(req.userId);
  if (n && n.banner) {
    const ruta = path.join(CARPETA, path.basename(n.banner));
    if (fs.existsSync(ruta)) { try { fs.unlinkSync(ruta); } catch (e) {} }
  }

  const nombre = uuidv4() + '-banner.webp';
  guardarArchivo(req.file.buffer, nombre);
  db.prepare('UPDATE negocio SET banner = ? WHERE user_id = ?').run('/fotos/' + nombre, req.userId);

  res.json({ banner: '/fotos/' + nombre });
});

router.delete('/banner', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  const n = db.prepare('SELECT banner FROM negocio WHERE user_id = ?').get(req.userId);
  if (n && n.banner) {
    const ruta = path.join(CARPETA, path.basename(n.banner));
    if (fs.existsSync(ruta)) { try { fs.unlinkSync(ruta); } catch (e) {} }
  }
  db.prepare('UPDATE negocio SET banner = NULL WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});


// ── comprobante de una reserva (publico) ──
router.post('/reserva/:id', subir.single('foto'), (req, res) => {
  const r = db.prepare('SELECT * FROM reservas WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
  if (!req.file) return res.status(400).json({ error: 'No llego la imagen.' });

  const nombre = uuidv4() + '-res.webp';
  guardarArchivo(req.file.buffer, nombre);

  db.prepare("UPDATE reservas SET comprobante = ?, sena_estado = 'enviado' WHERE id = ?")
    .run('/fotos/' + nombre, r.id);

  res.json({ ok: true });
});

module.exports = router;
