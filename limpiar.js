// borra cuentas que nunca cargaron nada y tienen mas de 7 dias
const db = require('./db');

const SQL = `
  SELECT id FROM users u
  WHERE u.username IS NULL
    AND NOT EXISTS (SELECT 1 FROM productos p WHERE p.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM ventas v WHERE v.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM clientes c WHERE c.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM gastos g WHERE g.user_id = u.id)
    AND u.created_at < datetime('now','-7 days')
`;

const vacias = db.prepare(SQL).all();
const soloVer = process.argv.indexOf('--ver') !== -1;

console.log('Cuentas vacias de mas de 7 dias:', vacias.length);

if (soloVer) {
  console.log('(modo consulta: no se borro nada)');
} else {
  const borrar = db.prepare('DELETE FROM users WHERE id = ?');
  vacias.forEach(function (u) { borrar.run(u.id); });
  console.log('Borradas:', vacias.length);
}
