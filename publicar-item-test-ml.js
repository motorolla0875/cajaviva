const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'cajaviva.db'));

async function main() {
  const c = db.prepare('SELECT access_token FROM mercadolibre_conexion LIMIT 1').get();
  if (!c) { console.log('No hay ninguna cuenta de MercadoLibre conectada.'); return; }
  const token = c.access_token;

  // 1) buscamos una categoria valida para el titulo (asi como lo hace la web)
  const rCat = await fetch('https://api.mercadolibre.com/sites/MLA/domain_discovery/search?q=' + encodeURIComponent('producto generico'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  const categorias = await rCat.json();
  const categoryId = (categorias && categorias[0] && categorias[0].category_id) || 'MLA1574'; // "Otras categorias" como respaldo

  console.log('Usando categoria:', categoryId);

  // 2) creamos la publicacion
  const body = {
    title: 'Item de Prueba - Por favor, NO OFERTAR',
    category_id: categoryId,
    price: 3500,
    currency_id: 'ARS',
    available_quantity: 10,
    buying_mode: 'buy_it_now',
    listing_type_id: 'gold_special',
    condition: 'new',
    description: { plain_text: 'Esta es una publicacion de prueba para probar una integracion. No comprar en serio.' },
    pictures: [{ source: 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/6210014/logo-ML-notification.png' }]
  };

  const r = await fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  const d = await r.json();

  if (!r.ok) {
    console.log('Error al crear la publicacion:');
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  console.log('\n=== Publicacion creada con exito ===');
  console.log('ID:', d.id);
  console.log('Link:', d.permalink);
}

main().catch((e) => console.error('Error:', e.message));
