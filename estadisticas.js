// Muestra como viene la pagina /empezar y las cuentas nuevas.
// Uso en el servidor:  cd ~/cajaviva && node estadisticas.js
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(__dirname + '/cajaviva.db');
const desde = process.argv[2] || '2026-11-12';

console.log('\n--- CLICS EN /empezar ---');
console.table(db.prepare(`SELECT date(created_at,'-3 hours') AS dia, origen,
  SUM(evento='vista') AS visitas, SUM(evento='web') AS toco_web, SUM(evento='play') AS toco_play
  FROM clics_empezar GROUP BY dia, origen ORDER BY dia DESC`).all());

console.log('\n--- CUENTAS NUEVAS desde ' + desde + ' ---');
console.table(db.prepare(`SELECT date(u.created_at,'-3 hours') AS dia, time(u.created_at,'-3 hours') AS hora,
  CASE WHEN u.username IS NULL THEN 'no' ELSE 'si' END AS usuario, n.nombre AS negocio, n.rubro,
  (SELECT COUNT(*) FROM productos p WHERE p.user_id=u.id) AS productos,
  (SELECT COUNT(*) FROM ventas v WHERE v.user_id=u.id) AS ventas
  FROM users u LEFT JOIN negocio n ON n.user_id=u.id
  WHERE date(u.created_at,'-3 hours') >= ? ORDER BY u.created_at`).all(desde));
