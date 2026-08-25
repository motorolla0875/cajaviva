const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// datos extra del cheque
try { db.exec('ALTER TABLE cheques ADD COLUMN numero TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE cheques ADD COLUMN banco TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE cheques ADD COLUMN rechazado INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

function hoyISO() { return new Date().toISOString().slice(0, 10); }

// ── listar ──
router.get('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const estado = req.query.estado || 'pendientes';
  let cond = '';
  if (estado === 'pendientes') cond = 'AND ch.acreditado = 0 AND ch.rechazado = 0';
  else if (estado === 'acreditados') cond = 'AND ch.acreditado = 1';
  else if (estado === 'rechazados') cond = 'AND ch.rechazado = 1';

  const filas = db.prepare(`
    SELECT ch.*, c.nombre AS cliente_nombre
    FROM cheques ch
    LEFT JOIN clientes c ON c.id = ch.cliente_id
    WHERE ch.user_id = ? ${cond}
    ORDER BY ch.fecha_cobro ASC
  `).all(req.userId);

  const hoy = hoyISO();
  const resumen = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN acreditado = 0 AND rechazado = 0 THEN monto ELSE 0 END), 0) AS pendiente,
      COALESCE(SUM(CASE WHEN acreditado = 0 AND rechazado = 0 AND fecha_cobro <= ? THEN monto ELSE 0 END), 0) AS vencidos,
      COUNT(CASE WHEN acreditado = 0 AND rechazado = 0 THEN 1 END) AS cantidad
    FROM cheques WHERE user_id = ?
  `).get(hoy, req.userId);

  res.json({ items: filas, resumen: resumen, hoy: hoy });
});

// ── crear ──
router.post('/', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const monto = parseFloat(req.body?.monto);
  if (isNaN(monto) || monto <= 0) return res.status(400).json({ error: 'Poné un monto valido.' });
  if (!req.body?.fechaCobro) return res.status(400).json({ error: 'Poné la fecha de cobro.' });

  const clienteId = req.body?.clienteId || null;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO cheques (id, user_id, cliente_id, venta_id, monto, fecha_cobro, nota, numero, banco)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, clienteId, req.body?.ventaId || null, monto,
         req.body.fechaCobro, req.body?.nota || null,
         req.body?.numero || null, req.body?.banco || null);

  // si viene de un cliente, le baja la deuda
  if (clienteId && req.body?.bajaDeuda) {
    db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id = ? AND user_id = ?')
      .run(monto, clienteId, req.userId);
    db.prepare(`
      INSERT INTO pagos_cliente (id, user_id, cliente_id, monto, fecha, nota, tipo)
      VALUES (?, ?, ?, ?, ?, ?, 'pago')
    `).run(uuidv4(), req.userId, clienteId, monto, hoyISO(),
           'Cheque ' + (req.body?.numero || '') + ' al ' + req.body.fechaCobro);
  }

  res.json({ id: id });
});

// ── acreditar: la plata entra a la caja ──
router.post('/:id/acreditar', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const ch = db.prepare('SELECT * FROM cheques WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!ch) return res.status(404).json({ error: 'Cheque no encontrado.' });
  if (ch.acreditado) return res.status(400).json({ error: 'Ese cheque ya esta acreditado.' });

  db.prepare('UPDATE cheques SET acreditado = 1, rechazado = 0 WHERE id = ?').run(ch.id);
  res.json({ ok: true });
});

// ── rechazado: vuelve la deuda ──
router.post('/:id/rechazar', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });

  const ch = db.prepare('SELECT * FROM cheques WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!ch) return res.status(404).json({ error: 'Cheque no encontrado.' });

  db.prepare('UPDATE cheques SET rechazado = 1, acreditado = 0 WHERE id = ?').run(ch.id);

  if (ch.cliente_id) {
    db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id = ?').run(ch.monto, ch.cliente_id);
    db.prepare(`
      INSERT INTO pagos_cliente (id, user_id, cliente_id, monto, fecha, nota, tipo)
      VALUES (?, ?, ?, ?, ?, 'Cheque rechazado', 'devolucion')
    `).run(uuidv4(), req.userId, ch.cliente_id, ch.monto, hoyISO());
  }

  res.json({ ok: true });
});

// ── volver a pendiente ──
router.post('/:id/pendiente', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('UPDATE cheques SET acreditado = 0, rechazado = 0 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── borrar ──
router.delete('/:id', (req, res) => {
  if (req.esEmpleado) return res.status(403).json({ error: 'Solo el dueño.' });
  db.prepare('DELETE FROM cheques WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

module.exports = router;
