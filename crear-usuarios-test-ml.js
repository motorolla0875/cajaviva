const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'cajaviva.db'));

async function crearUsuarioTest(token) {
  const r = await fetch('https://api.mercadolibre.com/users/test_user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ site_id: 'MLA' })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d;
}

async function main() {
  const c = db.prepare('SELECT access_token FROM mercadolibre_conexion LIMIT 1').get();
  if (!c) { console.log('No hay ninguna cuenta de MercadoLibre conectada todavia.'); return; }

  console.log('Creando usuario de test VENDEDOR...');
  const vendedor = await crearUsuarioTest(c.access_token);
  console.log(JSON.stringify(vendedor, null, 2));

  console.log('\nCreando usuario de test COMPRADOR...');
  const comprador = await crearUsuarioTest(c.access_token);
  console.log(JSON.stringify(comprador, null, 2));

  console.log('\n\n=== GUARDA ESTOS DATOS, NO SE PUEDEN VOLVER A VER ===');
  console.log('VENDEDOR -> id:', vendedor.id, '| nickname:', vendedor.nickname, '| password:', vendedor.password);
  console.log('COMPRADOR -> id:', comprador.id, '| nickname:', comprador.nickname, '| password:', comprador.password);
}

main().catch((e) => console.error('Error:', e.message));
