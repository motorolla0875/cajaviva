const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');

const router = express.Router();

function hoyISO(userId) {
  if (userId && db.hoyEn) return db.hoyEn(userId);
  return new Date().toISOString().slice(0, 10);
}

// ── ventas del periodo en Excel ──
router.get('/ventas', async (req, res) => {
  const desde = req.query.desde || hoyISO(req.userId);
  const hasta = req.query.hasta || hoyISO(req.userId);

  const ventas = db.prepare(`
    SELECT v.fecha, v.created_at, v.total, v.costo_total, v.medio_pago,
           v.estado, v.notas, c.nombre AS cliente, e.nombre AS empleado
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN empleados e ON e.id = v.empleado_id
    WHERE v.user_id = ? AND v.fecha BETWEEN ? AND ?
    ORDER BY v.created_at
  `).all(req.userId, desde, hasta);

  const gastos = db.prepare(`
    SELECT fecha, monto, descripcion, categoria, created_at
    FROM gastos WHERE user_id = ? AND fecha BETWEEN ? AND ?
    ORDER BY created_at
  `).all(req.userId, desde, hasta);

  const neg = db.prepare('SELECT nombre FROM negocio WHERE user_id = ?').get(req.userId);

  const libro = new ExcelJS.Workbook();
  libro.creator = 'CajaViva';
  libro.created = new Date();

  // ── hoja de ventas ──
  const hv = libro.addWorksheet('Ventas');

  hv.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Cliente', key: 'cliente', width: 22 },
    { header: 'Como pago', key: 'medio', width: 14 },
    { header: 'Total', key: 'total', width: 13 },
    { header: 'Costo', key: 'costo', width: 13 },
    { header: 'Ganancia', key: 'ganancia', width: 13 },
    { header: 'Estado', key: 'estado', width: 12 },
    { header: 'Atendio', key: 'empleado', width: 18 },
    { header: 'Notas', key: 'notas', width: 30 }
  ];

  const MEDIOS = {
    efectivo: 'Efectivo', transferencia: 'Transferencia',
    cuenta_corriente: 'Fiado', tarjeta: 'Tarjeta'
  };

  ventas.forEach(function (v) {
    hv.addRow({
      fecha: v.fecha,
      hora: (v.created_at || '').slice(11, 16),
      cliente: v.cliente || '',
      medio: MEDIOS[v.medio_pago] || v.medio_pago || '',
      total: v.total,
      costo: v.costo_total || 0,
      ganancia: v.total - (v.costo_total || 0),
      estado: v.estado === 'cobrada' ? 'Cobrada' : v.estado,
      empleado: v.empleado || '',
      notas: v.notas || ''
    });
  });

  // ── hoja de gastos ──
  const hg = libro.addWorksheet('Gastos');
  hg.columns = [
    { header: 'Fecha', key: 'fecha', width: 12 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'En que', key: 'motivo', width: 30 },
    { header: 'Categoria', key: 'categoria', width: 16 },
    { header: 'Monto', key: 'monto', width: 13 }
  ];

  gastos.forEach(function (g) {
    hg.addRow({
      fecha: g.fecha,
      hora: (g.created_at || '').slice(11, 16),
      motivo: g.descripcion || '',
      categoria: g.categoria || '',
      monto: g.monto
    });
  });

  // ── hoja de resumen ──
  const hr = libro.addWorksheet('Resumen');

  const vendido = ventas.reduce(function (a, v) { return a + (v.estado !== 'anulada' ? v.total : 0); }, 0);
  const costo = ventas.reduce(function (a, v) { return a + (v.estado !== 'anulada' ? (v.costo_total || 0) : 0); }, 0);
  const gastado = gastos.reduce(function (a, g) { return a + g.monto; }, 0);

  hr.columns = [
    { header: '', key: 'que', width: 26 },
    { header: '', key: 'cuanto', width: 16 }
  ];

  hr.addRow({ que: neg ? neg.nombre : 'Mi negocio' });
  hr.addRow({ que: 'Del ' + desde + ' al ' + hasta });
  hr.addRow({});
  hr.addRow({ que: 'Ventas', cuanto: ventas.filter(function (v) { return v.estado !== 'anulada'; }).length });
  hr.addRow({ que: 'Vendido', cuanto: vendido });
  hr.addRow({ que: 'Costo de lo vendido', cuanto: costo });
  hr.addRow({ que: 'Ganancia bruta', cuanto: vendido - costo });
  hr.addRow({ que: 'Gastos', cuanto: gastado });
  hr.addRow({ que: 'Balance', cuanto: vendido - costo - gastado });

  // formato
  [hv, hg].forEach(function (h) {
    h.getRow(1).font = { bold: true };
    h.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D9E75' } };
    h.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  hr.getRow(1).font = { bold: true, size: 13 };
  hr.getRow(9).font = { bold: true };

  ['E', 'F', 'G'].forEach(function (c) { hv.getColumn(c).numFmt = '#,##0.00'; });
  hg.getColumn('E').numFmt = '#,##0.00';
  hr.getColumn('B').numFmt = '#,##0.00';

  const nombre = 'cajaviva-' + desde + '-al-' + hasta + '.xlsx';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + nombre + '"');

  await libro.xlsx.write(res);
  res.end();
});


// ── ticket de una venta en PDF ──
const PDFDocument = require('pdfkit');

router.get('/ticket/:id', (req, res) => {
  const v = db.prepare(`
    SELECT v.*, c.nombre AS cliente, e.nombre AS empleado
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN empleados e ON e.id = v.empleado_id
    WHERE v.id = ? AND v.user_id = ?
  `).get(req.params.id, req.userId);

  if (!v) return res.status(404).json({ error: 'Venta no encontrada.' });

  const items = db.prepare(
    'SELECT nombre, cantidad, precio_unitario, variante_nombre FROM venta_items WHERE venta_id = ?'
  ).all(v.id);

  const neg = db.prepare(
    'SELECT nombre, telefono, direccion FROM negocio WHERE user_id = ?'
  ).get(req.userId);

  function plata(n) {
    return '$' + Math.round(n || 0).toLocaleString('es-AR');
  }

  // ticket angosto, como los de impresora termica
  const doc = new PDFDocument({ size: [226, 800], margin: 14 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    'attachment; filename="ticket-' + v.id.slice(0, 8) + '.pdf"');

  doc.pipe(res);

  const ancho = 226 - 28;

  doc.fontSize(13).font('Helvetica-Bold')
     .text(neg && neg.nombre ? neg.nombre : 'Mi negocio', { align: 'center' });

  if (neg && neg.telefono) {
    doc.fontSize(8).font('Helvetica').text(neg.telefono, { align: 'center' });
  }
  if (neg && neg.direccion) {
    doc.fontSize(8).font('Helvetica').text(neg.direccion, { align: 'center' });
  }

  doc.moveDown(0.6);
  doc.fontSize(8).font('Helvetica')
     .text(v.fecha + '  ' + (v.created_at || '').slice(11, 16), { align: 'center' });

  if (v.cliente) doc.text('Cliente: ' + v.cliente, { align: 'center' });

  doc.moveDown(0.5);
  doc.moveTo(14, doc.y).lineTo(212, doc.y).stroke();
  doc.moveDown(0.5);

  items.forEach(function (i) {
    const nom = i.nombre + (i.variante_nombre ? ' (' + i.variante_nombre + ')' : '');
    const sub = i.cantidad * i.precio_unitario;

    doc.fontSize(9).font('Helvetica').text(nom, { width: ancho });
    doc.fontSize(8).text(
      '   ' + i.cantidad + ' x ' + plata(i.precio_unitario),
      { continued: true, width: ancho }
    );
    doc.text(plata(sub), { align: 'right' });
    doc.moveDown(0.3);
  });

  doc.moveDown(0.3);
  doc.moveTo(14, doc.y).lineTo(212, doc.y).stroke();
  doc.moveDown(0.5);

  doc.fontSize(13).font('Helvetica-Bold')
     .text('TOTAL', { continued: true })
     .text(plata(v.total), { align: 'right' });

  doc.moveDown(0.5);

  const MEDIOS = {
    efectivo: 'Efectivo', transferencia: 'Transferencia',
    cuenta_corriente: 'Fiado', tarjeta: 'Tarjeta'
  };

  doc.fontSize(9).font('Helvetica')
     .text(MEDIOS[v.medio_pago] || v.medio_pago || '', { align: 'center' });

  if (v.empleado) {
    doc.fontSize(8).text('Te atendio: ' + v.empleado, { align: 'center' });
  }

  doc.moveDown(1);
  doc.fontSize(8).text('Gracias por tu compra', { align: 'center' });
  doc.fontSize(7).fillColor('#888').text('CajaViva', { align: 'center' });

  doc.end();
});

module.exports = router;
