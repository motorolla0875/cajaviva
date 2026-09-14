const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'cajaviva.db'));

async function main() {
  const c = db.prepare('SELECT access_token FROM mercadolibre_conexion LIMIT 1').get();
  if (!c) { console.log('No hay ninguna cuenta de MercadoLibre conectada.'); return; }
  const token = c.access_token;

  // 1) buscamos "Otras categorias" recorriendo el arbol, hasta llegar a una hoja (sin hijos)
  let categoryId = null;
  const rNivel = await fetch('https://api.mercadolibre.com/sites/MLA/categories', {
    headers: { Authorization: 'Bearer ' + token }
  });
  let nivel = await rNivel.json();
  if (!Array.isArray(nivel)) {
    console.log('No se pudo traer la lista de categorias. Respuesta:', JSON.stringify(nivel));
    return;
  }
  let actual = nivel.find((cat) => /^otr/i.test(cat.name)) || nivel[0];
  console.log('\nCategorias de primer nivel disponibles:');
  nivel.forEach((cat) => console.log(' -', cat.id, cat.name));
  console.log('\nBuscando en:', actual.id, actual.name);

  for (let vueltas = 0; vueltas < 6; vueltas++) {
    const info = await (await fetch('https://api.mercadolibre.com/categories/' + actual.id, {
      headers: { Authorization: 'Bearer ' + token }
    })).json();
    if (!info.children_categories || info.children_categories.length === 0) { categoryId = actual.id; break; }
    console.log('  subcategorias de', actual.name + ':', info.children_categories.map((c) => c.id + ' ' + c.name).join(' | '));
    actual = info.children_categories.find((cat) => /^otr/i.test(cat.name)) || info.children_categories[0];
  }
  if (!categoryId) categoryId = actual.id;

  console.log('Usando categoria:', categoryId);

  // 2) vemos que atributos son obligatorios en esa categoria, para no chocar con la validacion
  const rAttrs = await fetch('https://api.mercadolibre.com/categories/' + categoryId + '/attributes', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const attrs = await rAttrs.json();
  const obligatorios = (attrs || []).filter((a) => (a.tags && a.tags.required));
  const attributes = obligatorios.map((a) => {
    if (a.value_type === 'number_unit' || a.value_type === 'number') return { id: a.id, value_name: '1' };
    return { id: a.id, value_name: (a.values && a.values[0] && a.values[0].name) || 'Generico' };
  });
  console.log('Atributos obligatorios completados:', attributes.map((a) => a.id).join(', ') || '(ninguno)');

  // 3) creamos la publicacion
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
    pictures: [{ source: 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/6210014/logo-ML-notification.png' }],
    attributes: attributes
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
