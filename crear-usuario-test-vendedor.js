require('dotenv').config();
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

  console.log('Creando usuario de test VENDEDOR nuevo...');
  const vendedor = await crearUsuarioTest(c.access_token);
  console.log('\n=== GUARDA ESTOS DATOS ===');
  console.log('VENDEDOR NUEVO -> id:', vendedor.id, '| nickname:', vendedor.nickname, '| password:', vendedor.password);
}

main().catch((e) => console.error('Error:', e.message));
