#!/usr/bin/env node
// Experimento SEO: guías automáticas en tujuego.app/directorio/
// Busca preguntas reales que la gente escribe en Google (autocompletado), descarta las que
// dominan los sitios grandes, escribe una guía original con Gemini, la enlaza con las de su
// misma categoría y regenera todas las páginas + el sitemap.
//
// Sin dependencias (Node 18+). Variables (en /root/tujuego.env):
//   GROQ_API_KEY     clave de Groq (gratis, console.groq.com). Si está, se usa Groq para escribir
//   XAI_API_KEY      clave de Grok (xAI), pago
//   XAI_MODELO       opcional; si no está, elige solo el Grok "fast" más nuevo
//   GEMINI_API_KEY   clave de Gemini (se usa si no hay clave de Grok)
//   GEMINI_MODELO    opcional; si no está, usa el modelo Flash más nuevo que ofrezca Google
//   DIR_POR_DIA      cuántas guías por día (por defecto 4)
//   DIR_DATOS        dónde guardar las guías (por defecto /var/lib/tujuego/directorio)
//   DIR_WEB          carpeta pública (por defecto /var/www/tujuego/directorio)
//
// Uso:
//   node directorio.js            queda corriendo y publica DIR_POR_DIA guías por día
//   node directorio.js --una      publica una guía ahora y termina
//   node directorio.js --ideas    muestra las búsquedas candidatas sin publicar nada
//   node directorio.js --paginas  solo vuelve a generar las páginas
//   node directorio.js --visitas  cuenta visitas de personas a /directorio/ (log de nginx)
//   node directorio.js --lista    lista las guías publicadas
//   node directorio.js --borrar X borra la guía cuyo nombre contiene X

const fs = require('fs');
const path = require('path');

const KEY = process.env.GEMINI_API_KEY || '';
// Proveedores compatibles con el formato de OpenAI. Se usa el primero que tenga clave.
const PROV = process.env.GROQ_API_KEY
  ? { nombre: 'Groq', url: 'https://api.groq.com/openai/v1', key: process.env.GROQ_API_KEY, modelo: process.env.GROQ_MODELO || '',
      orden: [/gpt-oss-120b/, /llama-4-maverick/, /llama-3\.3-70b/, /kimi/, /qwen/, /gpt-oss-20b/, /llama/], fuera: /whisper|guard|tts|playai|compound|vision|distil/ }
  : process.env.XAI_API_KEY
  ? { nombre: 'Grok', url: 'https://api.x.ai/v1', key: process.env.XAI_API_KEY, modelo: process.env.XAI_MODELO || '',
      orden: [/fast/, /mini/, /grok/], fuera: /image|vision|imagine|video|tts|voice|code/ }
  : null;
const XAI = !!PROV; // (nombre viejo: "hay proveedor OpenAI-compatible")
let MODELO = process.env.GEMINI_MODELO || ''; // si está vacío, elige solo el Flash más nuevo disponible
let MODELOS = [];
const POR_DIA = Math.max(1, Math.min(10, +process.env.DIR_POR_DIA || 4));
// Configuración del sitio: por defecto tujuego. Otro sitio pasa DIR_CONFIG=/ruta/config.json
const CFG = Object.assign({
  sitio: 'https://tujuego.app', base: '/directorio', marca: 'tujuego', marcaSub: 'guías', autor: 'tujuego', icono: '/icon.png',
  datos: '/var/lib/tujuego/directorio', web: '/var/www/tujuego/directorio',
  colores: { papel: '#f7f4fc', tinta: '#2e1650', tinta2: '#5b3d86', acento: '#ff4f8b', linea: '#e6def3', promo: '#2e1650', promoLink: '#ffd23f' },
  fuente: 'Bricolage Grotesque', fuenteUrl: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&display=swap',
  promo: '¿Buscás un regalo distinto? Hacé un <a href="/">juego para el celular con la foto de quien quieras</a>.',
  portadaTitulo: 'Guías prácticas: recetas, mascotas, plantas, hogar y autos',
  portadaDesc: 'Respuestas claras a las dudas de todos los días: recetas fáciles, cuidado de mascotas y plantas, trucos para la casa y el auto.',
  contexto: '', // texto extra para la IA (qué es el sitio, qué producto recomendar)
  excluir: '',  // palabras extra a descartar (regex)
  grandes: [],
  categorias: null,
}, process.env.DIR_CONFIG ? JSON.parse(fs.readFileSync(process.env.DIR_CONFIG, 'utf8')) : {});
const DATOS = process.env.DIR_DATOS || CFG.datos;
const WEB = process.env.DIR_WEB || CFG.web;
const SITIO = CFG.sitio;
const BASE = CFG.base;
const MOCK = !!process.env.DIR_MOCK; // para probar sin internet

// Categorías y semillas. Nada de salud humana ni dinero: Google es muy exigente con esos temas.
const CATEGORIAS = CFG.categorias || {
  recetas: { nombre: 'Recetas', desc: 'Recetas fáciles y caseras explicadas paso a paso.', semillas: ['receta de', 'como hacer', 'se puede congelar', 'con que acompañar', 'como cocinar', 'receta facil de'] },
  mascotas: { nombre: 'Mascotas', desc: 'Cuidados, comida y costumbres de perros, gatos y otras mascotas.', semillas: ['mi perro', 'mi gato', 'cuanto vive un', 'que come un', 'como cuidar un', 'por que mi gato'] },
  plantas: { nombre: 'Plantas', desc: 'Cómo cuidar, regar y reproducir plantas de interior y de jardín.', semillas: ['como cuidar', 'cuando plantar', 'como hacer esquejes de', 'por que se ponen amarillas las hojas de', 'cada cuanto regar'] },
  hogar: { nombre: 'Hogar', desc: 'Trucos de limpieza, orden y arreglos simples para la casa.', semillas: ['como limpiar', 'como sacar manchas de', 'como sacar olor a', 'truco para', 'como destapar'] },
  autos: { nombre: 'Autos', desc: 'Mantenimiento básico y dudas comunes sobre el auto.', semillas: ['por que mi auto', 'cada cuanto cambiar', 'que significa la luz de', 'como saber si', 'cuanto dura'] },
};

// Sitios que, si dominan una búsqueda, la hacen difícil de ganar
const GRANDES = CFG.grandes.concat(['wikipedia.', 'youtube.', 'cookpad.', 'paulinacocina.', 'recetasgratis.', 'clarin.', 'infobae.', 'lanacion.', 'pagina12.', 'tn.com.ar',
  'mercadolibre.', 'amazon.', 'reddit.', 'facebook.', 'instagram.', 'tiktok.', 'pinterest.', 'bbc.', 'elmundo.', 'elpais.', 'directoalpaladar.',
  'kiwilimon.', 'mayoclinic.', 'purina.', 'royalcanin.', 'expertoanimal.', 'leroymerlin.', 'xataka.', 'motor.es', 'autobild.']);

fs.mkdirSync(DATOS, { recursive: true });
const ARCH = path.join(DATOS, 'guias.json');
const ARCH_USADAS = path.join(DATOS, 'busquedas-usadas.json');
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const guardar = (f, d) => { fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 1)); fs.renameSync(f + '.tmp', f); };
const log = (...a) => console.log(new Date().toISOString().slice(0, 16), ...a);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const azar = a => a[Math.floor(Math.random() * a.length)];
const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const CORTAS = new Set(['a', 'al', 'de', 'del', 'el', 'la', 'las', 'los', 'en', 'y', 'o', 'para', 'por', 'con', 'un', 'una', 'que', 'su', 'tu']);
const slugDe = s => { const w = norm(s).replace(/ñ/g, 'n').split(' ').filter(Boolean).slice(0, 9); while (w.length > 3 && CORTAS.has(w[w.length - 1])) w.pop(); return w.join('-'); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 1. Buscar ideas: autocompletado de Google ----------
async function sugerencias(q) {
  if (MOCK) return [q + ' facil', q + ' casera paso a paso', q + ' sin horno'];
  const u = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=es&gl=ar&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return [];
  const t = Buffer.from(await r.arrayBuffer()).toString('latin1');
  try { return JSON.parse(t)[1] || []; } catch { return []; }
}

async function ideas(cat, cuantas = 25) {
  const usadas = new Set(leer(ARCH_USADAS, []));
  const hechas = new Set(leer(ARCH, []).map(g => norm(g.busqueda)));
  const out = new Map();
  const semillas = CATEGORIAS[cat].semillas.slice().sort(() => Math.random() - .5).slice(0, 3);
  for (const s of semillas) {
    const extra = ['', ' ' + azar('abcdefghijlmnoprstv'.split('')), ' ' + azar('abcdefghijlmnoprstv'.split(''))];
    for (const e of extra) {
      for (const sug of await sugerencias(s + e)) {
        const n = norm(sug);
        // búsquedas largas (4+ palabras) = más específicas y con menos competencia
        if (n.split(' ').length < 4 || n.length > 80 || usadas.has(n) || hechas.has(n)) continue;
        if (/\b(precio|comprar|venta|online gratis|pdf|descargar|cerca de mi|hoy|letra|cancion|acordes|lyrics|serie|pelicula|capitulo|meme|cuento|frases|imagenes|dibujo|tiktok|youtube|wikipedia)\b/.test(n)) continue;
        if (CFG.excluir && new RegExp(CFG.excluir).test(n)) continue;
        out.set(n, sug);
      }
      await dormir(400);
    }
    if (out.size >= cuantas) break;
  }
  return [...out.values()].slice(0, cuantas);
}

// ---------- 2. Gemini ----------
// ---------- Groq / Grok (formato OpenAI) ----------
async function elegirGrok() {
  if (PROV.modelo) return PROV.modelo;
  const r = await fetch(PROV.url + '/models', { headers: { Authorization: 'Bearer ' + PROV.key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(PROV.nombre + ' ' + r.status + ' ' + JSON.stringify(j).slice(0, 160));
  const ids = (j.data || []).map(m => m.id).filter(id => !PROV.fuera.test(id));
  const pos = id => { const k = PROV.orden.findIndex(rx => rx.test(id)); return k < 0 ? 99 : k; };
  ids.sort((a, b) => pos(a) - pos(b) || b.localeCompare(a));
  if (!ids.length) throw new Error('No encontré modelos de ' + PROV.nombre + ' para esta clave');
  PROV.modelo = ids[0]; log('modelo de ' + PROV.nombre + ':', PROV.modelo);
  return PROV.modelo;
}
async function grok(texto, { json = false } = {}) {
  await elegirGrok();
  for (let i = 0; i < 4; i++) {
    const r = await fetch(PROV.url + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + PROV.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: PROV.modelo, temperature: 0.8, max_tokens: 6000, messages: [{ role: 'user', content: texto }], ...(json ? { response_format: { type: 'json_object' } } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    log(PROV.nombre + ' respondió', r.status, JSON.stringify(j.error || j).slice(0, 180));
    if (r.status === 429 || r.status >= 500) { await dormir(60000 * (i + 1)); continue; }
    throw new Error(PROV.nombre + ' ' + r.status);
  }
  throw new Error(PROV.nombre + ' no respondió');
}

// Busca en la lista de Google el modelo "flash" más nuevo (los viejos se dan de baja)
async function elegirModelo(forzar = false) {
  if (MODELO && !forzar) return MODELO;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${KEY}`);
  const j = await r.json().catch(() => ({}));
  const ver = n => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
  const lista = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|audio|live|thinking|exp/.test(n));
  lista.sort((a, b) => (+ver(b) - +ver(a)) || (/preview/.test(a) - /preview/.test(b)) || a.length - b.length);
  // de reserva, los "lite" (más baratos, suelen tener cuota gratis)
  const lite = (j.models || []).map(m => m.name.replace('models/', '')).filter(n => /^gemini-[\d.]+-flash-lite$/.test(n)).sort((a, b) => +ver(b) - +ver(a));
  MODELOS = [...lista, ...lite];
  if (!MODELOS.length) throw new Error('No encontré modelos de Gemini disponibles para esta clave (' + (j.error && j.error.message || r.status) + ')');
  MODELO = MODELOS[0]; log('modelo de Gemini:', MODELO);
  return MODELO;
}

async function gemini(partes, { json = false, buscar = false } = {}) {
  await elegirModelo();
  const cuerpo = { contents: [{ role: 'user', parts: [{ text: partes }] }], generationConfig: { temperature: json ? 0.8 : 0.2 } };
  if (json) cuerpo.generationConfig.responseMimeType = 'application/json';
  if (buscar) cuerpo.tools = [{ google_search: {} }];
  for (let i = 0; i < 6; i++) {
    const u = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${KEY}`;
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    log('Gemini respondió', r.status, (j.error && j.error.message || '').slice(0, 160));
    if (r.status === 404 && i === 0) { await elegirModelo(true); continue; } // modelo dado de baja: buscar otro
    const msj = (j.error && j.error.message) || '';
    if (r.status === 429 && /quota|billing/i.test(msj)) {
      // sin cuota para este modelo (o para la búsqueda en Google): probar con el siguiente
      if (buscar) throw Object.assign(new Error('sin cuota para buscar en Google'), { cuota: true });
      const sig = MODELOS[MODELOS.indexOf(MODELO) + 1];
      if (sig) { MODELO = sig; log('probando con', MODELO); continue; }
      throw Object.assign(new Error('Gemini sin cuota: hay que activar la facturación en Google AI Studio'), { cuota: true });
    }
    if (r.status === 429 || r.status >= 500) { await dormir(20000 * (i + 1)); continue; }
    throw new Error('Gemini ' + r.status);
  }
  throw new Error('Gemini no respondió');
}
const textoDe = j => ((j.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');

// ---------- 3. ¿Se puede competir? Mira quién aparece hoy en Google ----------
async function competencia(busqueda) {
  if (MOCK) return { grandes: 0, fuentes: [] };
  if (XAI) throw Object.assign(new Error('con ' + PROV.nombre + ' no se revisa Google'), { cuota: true });
  const j = await gemini(`Buscá en Google: "${busqueda}" (Argentina). Respondé solo "ok".`, { buscar: true });
  const chunks = (j.candidates || [])[0]?.groundingMetadata?.groundingChunks || [];
  const fuentes = chunks.map(c => (c.web && (c.web.title || c.web.domain || '')) || '').filter(Boolean).map(s => s.toLowerCase());
  const grandes = fuentes.filter(f => GRANDES.some(g => f.includes(g))).length;
  return { grandes, fuentes };
}

// ¿Es una duda práctica real de esa categoría? (descarta canciones, nombres, cosas sin sentido)
async function esApta(b, cat) {
  if (MOCK) return true;
  const pr = `Búsqueda de Google: "${b}". Categoría del sitio: ${CATEGORIAS[cat].nombre} (${CATEGORIAS[cat].desc}).
¿Es una duda práctica real que se pueda responder con una guía útil de esa categoría? Respondé NO si es sobre una canción, letra, película, serie, persona famosa, marca puntual, noticia, algo sin sentido, o si no encaja en la categoría.
Respondé solo JSON: {"apta": true o false, "motivo": "breve"}`;
  try {
    const t = XAI ? await grok(pr, { json: true }) : textoDe(await gemini(pr, { json: true }));
    const j = JSON.parse(t.trim().replace(/^```(json)?/, '').replace(/```$/, ''));
    if (!j.apta) log(`  descartada: "${b}" (${j.motivo || 'no encaja'})`);
    return !!j.apta;
  } catch (e) { return false; }
}

async function elegirBusqueda(cat) {
  const lista = await ideas(cat);
  const usadas = leer(ARCH_USADAS, []);
  for (const b of lista.slice(0, 8)) {
    usadas.push(norm(b)); guardar(ARCH_USADAS, usadas.slice(-3000));
    if (!(await esApta(b, cat))) continue;
    try {
      const c = await competencia(b);
      log(`  "${b}" → ${c.grandes} sitios grandes de ${c.fuentes.length}`);
      if (c.grandes <= 1) return b;
    } catch (e) {
      if (e.cuota) { log('  (sin revisar Google: se usa igual porque es una búsqueda larga)'); return b; }
      log('  no se pudo medir competencia:', e.message); throw e;
    }
  }
  return null;
}

// ---------- 4. Escribir la guía ----------
function promptGuia(busqueda, cat, existentes) {
  return `Sos un redactor experto que escribe guías prácticas en español de Argentina (voseo natural, claro y cálido, sin exagerar).
Escribí una guía ORIGINAL y realmente útil que responda a la búsqueda: "${busqueda}".
Categoría: ${CATEGORIAS[cat].nombre}.

Reglas:
- Empezá respondiendo directo en 2 o 3 frases (lo que la persona quiere saber), después desarrollá.
- Entre 700 y 1100 palabras en total. Nada de relleno ni frases genéricas tipo "en este artículo veremos".
- Datos correctos y prudentes. Si no estás seguro de un dato, no lo inventes. No cites estudios ni cifras que no puedas respaldar.
- En temas de mascotas, si hay síntomas o algo de salud, recomendá consultar al veterinario.
${CFG.contexto ? '- Contexto del sitio: ' + CFG.contexto : ''}
- Usá ingredientes, productos y medidas comunes en Argentina.
- No menciones que sos una IA. No uses emojis.
- No repitas estas guías que ya existen en el sitio: ${existentes.slice(0, 40).join(' | ') || 'ninguna'}.

Devolvé SOLO un JSON con esta forma:
{
 "titulo": "título claro con la búsqueda, máximo 65 caracteres",
 "descripcion": "meta descripción atractiva, máximo 155 caracteres",
 "respuesta": "respuesta directa en 2 o 3 frases",
 "etiquetas": ["5 palabras clave cortas en minúscula"],
 "secciones": [ { "h2": "subtítulo", "html": "párrafos <p>, listas <ul><li> u <ol><li>, y <strong>. Sin otras etiquetas." } ],
 "preguntas": [ { "p": "pregunta frecuente", "r": "respuesta corta" } ],
 "receta": ${cat === 'recetas' ? '{ "porciones": "4", "tiempo_min": 30, "ingredientes": ["..."], "pasos": ["..."] }' : 'null'}
}
Entre 4 y 6 secciones y entre 3 y 5 preguntas.`;
}

const PERMITIDAS = /<(?!\/?(p|ul|ol|li|strong|em|br)\b)[^>]*>/gi;
async function escribir(busqueda, cat) {
  const guias = leer(ARCH, []);
  let d;
  if (MOCK) {
    d = { titulo: 'Guía de prueba: ' + busqueda, descripcion: 'Descripción de prueba para ' + busqueda, respuesta: 'Respuesta directa de prueba.', etiquetas: busqueda.split(' ').slice(0, 5),
      secciones: [{ h2: 'Paso a paso', html: '<p>Texto de prueba.</p><ol><li>Uno</li><li>Dos</li></ol>' }, { h2: 'Consejos', html: '<p>Más texto.</p>' }],
      preguntas: [{ p: '¿Se puede hacer antes?', r: 'Sí.' }], receta: cat === 'recetas' ? { porciones: '4', tiempo_min: 20, ingredientes: ['1 melón', '200 g de jamón crudo'], pasos: ['Cortar', 'Servir'] } : null };
  } else {
    const pr = promptGuia(busqueda, cat, guias.filter(g => g.cat === cat).map(g => g.titulo));
    const t = XAI ? await grok(pr, { json: true }) : textoDe(await gemini(pr, { json: true }));
    d = JSON.parse(t.trim().replace(/^```(json)?/, '').replace(/```$/, ''));
  }
  if (!d.titulo || !Array.isArray(d.secciones) || d.secciones.length < 2) throw new Error('Gemini devolvió una guía incompleta');
  let slug = slugDe(d.titulo) || slugDe(busqueda);
  while (guias.some(g => g.slug === slug)) slug += '-2';
  const g = {
    slug, cat, busqueda, titulo: String(d.titulo).slice(0, 90), descripcion: String(d.descripcion || d.respuesta || '').slice(0, 170),
    respuesta: String(d.respuesta || ''), etiquetas: (d.etiquetas || []).map(norm).filter(Boolean).slice(0, 8),
    secciones: d.secciones.slice(0, 8).map(s => ({ h2: String(s.h2 || ''), html: String(s.html || '').replace(PERMITIDAS, '') })),
    preguntas: (d.preguntas || []).slice(0, 6).map(q => ({ p: String(q.p || ''), r: String(q.r || '') })),
    receta: cat === 'recetas' && d.receta ? d.receta : null,
    fecha: new Date().toISOString(),
  };
  guias.push(g); guardar(ARCH, guias);
  return g;
}

// ---------- 5. Enlaces entre guías (misma categoría, temas parecidos) ----------
function palabras(g) { return new Set([...g.etiquetas, ...norm(g.titulo).split(' ')].filter(w => w.length > 3)); }
function relacionadas(g, guias, n = 4) {
  const a = palabras(g);
  return guias.filter(x => x.cat === g.cat && x.slug !== g.slug)
    .map(x => { const b = palabras(x); let c = 0; a.forEach(w => b.has(w) && c++); return { x, s: c / (a.size + b.size - c || 1) + Math.random() * 0.01 }; })
    .sort((p, q) => q.s - p.s).slice(0, n).map(o => o.x);
}

// ---------- 6. Páginas ----------
const K = CFG.colores;
const CSS = `:root{--papel:${K.papel};--uva:${K.tinta};--uva2:${K.tinta2};--chicle:${K.acento};--linea:${K.linea}}
*{box-sizing:border-box}body{margin:0;background:var(--papel);color:var(--uva);font:17px/1.7 '${CFG.fuente}',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--uva2)}.ancho{width:min(760px,100% - 32px);margin-inline:auto}
header.top{background:#fff;border-bottom:2px solid var(--linea)}header.top .ancho{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;width:min(1000px,100% - 32px)}
.marca{font-weight:800;text-decoration:none;color:var(--uva);font-size:20px}.marca span{color:var(--chicle)}
header.top nav{display:flex;gap:16px;flex-wrap:wrap;font-size:15px}header.top nav a{text-decoration:none;color:var(--uva2)}
.migas{font-size:14px;margin:22px 0 6px;color:var(--uva2)}.migas a{text-decoration:none}
h1{font-size:clamp(28px,5vw,40px);line-height:1.15;margin:8px 0 14px}h2{font-size:24px;line-height:1.25;margin:34px 0 8px}
.resp{background:#fff;border:2px solid var(--linea);border-left:6px solid var(--chicle);border-radius:14px;padding:16px 18px;font-size:18px}
.fecha{font-size:14px;color:var(--uva2)}li{margin:4px 0}
.ficha{background:#fff;border:2px solid var(--linea);border-radius:14px;padding:6px 20px 14px;margin-top:26px}
details{background:#fff;border:2px solid var(--linea);border-radius:12px;padding:12px 16px;margin:10px 0}summary{font-weight:700;cursor:pointer}
.rel{display:grid;gap:10px;margin:14px 0 0;padding:0;list-style:none}.rel a{display:block;background:#fff;border:2px solid var(--linea);border-radius:12px;padding:12px 16px;text-decoration:none;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;padding:0;list-style:none}.grid a{display:block;height:100%;background:#fff;border:2px solid var(--linea);border-radius:14px;padding:16px;text-decoration:none}
.grid b{display:block;color:var(--uva);font-size:18px}.grid small{color:var(--uva2)}
footer{margin:60px auto 40px;font-size:14px;color:var(--uva2);border-top:2px solid var(--linea);padding-top:20px}
.promo{margin-top:40px;background:${K.promo};color:#fff;border-radius:16px;padding:18px 20px}.promo a{color:${K.promoLink};font-weight:700}`;

function plantilla({ titulo, desc, url, cuerpo, ld = [], indexar = true }) {
  const cats = Object.entries(CATEGORIAS).map(([k, c]) => `<a href="${BASE}/${k}/">${c.nombre}</a>`).join('');
  return `<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITIO}${url}">
${indexar ? '' : '<meta name="robots" content="noindex">'}<meta property="og:type" content="article"><meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITIO}${url}"><meta property="og:locale" content="es_AR">
<link rel="icon" href="${CFG.icono}">${CFG.fuenteUrl ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${CFG.fuenteUrl}" rel="stylesheet">` : ''}
<style>${CSS}</style>${ld.map(x => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`).join('')}</head>
<body><header class="top"><div class="ancho"><a class="marca" href="${BASE}/">${CFG.marca} <span>${CFG.marcaSub}</span></a><nav>${cats}</nav></div></header>
<main class="ancho">${cuerpo}</main>
<footer class="ancho">Guías prácticas de <a href="/">${SITIO.replace('https://', '')}</a> · <a href="${BASE}/">Todas las guías</a></footer></body></html>`;
}

function paginaGuia(g, guias) {
  const c = CATEGORIAS[g.cat]; const url = `${BASE}/${g.cat}/${g.slug}/`;
  const rel = relacionadas(g, guias);
  const fecha = new Date(g.fecha).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
  const receta = g.receta && Array.isArray(g.receta.ingredientes) ? `<section class="ficha"><h2>Ingredientes</h2><ul>${g.receta.ingredientes.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
    ${g.receta.tiempo_min ? `<p><strong>Tiempo:</strong> ${esc(g.receta.tiempo_min)} minutos${g.receta.porciones ? ` · <strong>Porciones:</strong> ${esc(g.receta.porciones)}` : ''}</p>` : ''}</section>` : '';
  const cuerpo = `<nav class="migas"><a href="${BASE}/">Guías</a> › <a href="${BASE}/${g.cat}/">${c.nombre}</a></nav>
<article><h1>${esc(g.titulo)}</h1><p class="fecha">Actualizado el ${fecha}</p><p class="resp">${esc(g.respuesta)}</p>${receta}
${g.secciones.map(s => `<h2>${esc(s.h2)}</h2>${s.html}`).join('\n')}
${g.preguntas.length ? `<h2>Preguntas frecuentes</h2>${g.preguntas.map(q => `<details><summary>${esc(q.p)}</summary><p>${esc(q.r)}</p></details>`).join('')}` : ''}
</article>
${rel.length ? `<h2>Te puede servir</h2><ul class="rel">${rel.map(r => `<li><a href="${BASE}/${r.cat}/${r.slug}/">${esc(r.titulo)}</a></li>`).join('')}</ul>` : ''}
<p class="promo">${CFG.promo}</p>`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Guías', item: SITIO + BASE + '/' },
      { '@type': 'ListItem', position: 2, name: c.nombre, item: `${SITIO}${BASE}/${g.cat}/` },
      { '@type': 'ListItem', position: 3, name: g.titulo, item: SITIO + url }] },
    g.receta && Array.isArray(g.receta.pasos)
      ? { '@context': 'https://schema.org', '@type': 'Recipe', name: g.titulo, description: g.descripcion, datePublished: g.fecha, recipeCategory: 'Receta', recipeCuisine: 'Argentina',
          recipeYield: String(g.receta.porciones || ''), totalTime: g.receta.tiempo_min ? `PT${+g.receta.tiempo_min}M` : undefined,
          recipeIngredient: g.receta.ingredientes, recipeInstructions: g.receta.pasos.map(p => ({ '@type': 'HowToStep', text: p })), author: { '@type': 'Organization', name: CFG.autor } }
      : { '@context': 'https://schema.org', '@type': 'Article', headline: g.titulo, description: g.descripcion, datePublished: g.fecha, dateModified: g.fecha, author: { '@type': 'Organization', name: CFG.autor }, publisher: { '@type': 'Organization', name: CFG.autor, logo: { '@type': 'ImageObject', url: SITIO + CFG.icono } }, mainEntityOfPage: SITIO + url },
  ];
  if (g.preguntas.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: g.preguntas.map(q => ({ '@type': 'Question', name: q.p, acceptedAnswer: { '@type': 'Answer', text: q.r } })) });
  return plantilla({ titulo: g.titulo + ' · ' + CFG.marca, desc: g.descripcion, url, cuerpo, ld });
}

function tarjetas(lista) {
  return `<ul class="grid">${lista.map(g => `<li><a href="${BASE}/${g.cat}/${g.slug}/"><b>${esc(g.titulo)}</b><small>${esc(g.descripcion.slice(0, 110))}</small></a></li>`).join('')}</ul>`;
}

function generarPaginas() {
  const guias = leer(ARCH, []).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const escribirArch = (rel, html) => { const f = path.join(WEB, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); };
  // limpiar páginas viejas que ya no existan
  const vivas = new Set(guias.map(g => `${g.cat}/${g.slug}`));
  for (const cat of Object.keys(CATEGORIAS)) {
    const dir = path.join(WEB, cat); if (!fs.existsSync(dir)) continue;
    for (const s of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, s)).isDirectory() && !vivas.has(`${cat}/${s}`)) fs.rmSync(path.join(dir, s), { recursive: true });
  }
  for (const g of guias) escribirArch(`${g.cat}/${g.slug}/index.html`, paginaGuia(g, guias));
  for (const [k, c] of Object.entries(CATEGORIAS)) {
    const l = guias.filter(g => g.cat === k);
    escribirArch(`${k}/index.html`, plantilla({ titulo: `${c.nombre}: guías prácticas · ${CFG.marca}`, desc: c.desc, url: `${BASE}/${k}/`, indexar: l.length >= 3,
      cuerpo: `<nav class="migas"><a href="${BASE}/">Guías</a></nav><h1>${c.nombre}</h1><p>${esc(c.desc)}</p>${l.length ? tarjetas(l) : '<p>Pronto vas a encontrar guías acá.</p>'}` }));
  }
  escribirArch('index.html', plantilla({ titulo: CFG.portadaTitulo + ' · ' + CFG.marca, desc: CFG.portadaDesc, url: `${BASE}/`, indexar: guias.length >= 3,
    cuerpo: `<h1>Guías prácticas</h1><p>${esc(CFG.portadaDesc)}</p>${Object.entries(CATEGORIAS).map(([k, c]) => {
      const l = guias.filter(g => g.cat === k).slice(0, 6);
      return l.length ? `<h2><a href="${BASE}/${k}/">${c.nombre}</a></h2>${tarjetas(l)}` : '';
    }).join('')}` }));
  // sitemap
  const urls = [`${BASE}/`, ...Object.keys(CATEGORIAS).filter(k => guias.filter(g => g.cat === k).length >= 3).map(k => `${BASE}/${k}/`)].map(u => ({ u, f: guias[0]?.fecha }))
    .concat(guias.map(g => ({ u: `${BASE}/${g.cat}/${g.slug}/`, f: g.fecha })));
  escribirArch('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(x => `<url><loc>${SITIO}${x.u}</loc>${x.f ? `<lastmod>${x.f.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`);
  log(`páginas: ${guias.length} guías`);
}

// ---------- 7. Publicar una guía ----------
async function publicarUna() {
  if (!KEY && !XAI && !MOCK) throw new Error('Falta GROQ_API_KEY (o XAI_API_KEY / GEMINI_API_KEY) en /root/tujuego.env');
  const guias = leer(ARCH, []);
  // va rotando categorías: le toca a la que tiene menos guías
  const cat = Object.keys(CATEGORIAS).sort((a, b) => guias.filter(g => g.cat === a).length - guias.filter(g => g.cat === b).length || Math.random() - .5)[0];
  log(`categoría: ${cat}`);
  const b = await elegirBusqueda(cat);
  if (!b) { log('  no encontré una búsqueda ganable esta vez'); return null; }
  log(`  escribiendo: "${b}"`);
  const g = await escribir(b, cat);
  generarPaginas();
  log(`  ✅ publicada: ${SITIO}${BASE}/${g.cat}/${g.slug}/`);
  return g;
}

// ---------- 8. Visitas de personas (log de nginx) ----------
function visitas() {
  const logs = ['/var/log/nginx/access.log', '/var/log/nginx/access.log.1'].filter(f => fs.existsSync(f));
  const bots = /bot|crawl|spider|slurp|facebookexternalhit|preview|curl|wget|python|monitor|headless/i;
  const porDia = {}; const porPag = {}; let google = 0;
  for (const f of logs) for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = l.match(/\[(\d+\/\w+\/\d+):.*?"GET (\/directorio\/[^ ?]*)[^"]*" (\d+) .*?"([^"]*)" "([^"]*)"/);
    if (!m || m[3] !== '200' || bots.test(m[5]) || /\.(xml|png|ico|css|js)$/.test(m[2])) continue;
    porDia[m[1]] = (porDia[m[1]] || 0) + 1; porPag[m[2]] = (porPag[m[2]] || 0) + 1;
    if (/google\./.test(m[4])) google++;
  }
  console.log('Visitas de personas a /directorio/ (últimos días):');
  Object.entries(porDia).forEach(([d, n]) => console.log(`  ${d}: ${n}`));
  console.log(`Llegaron desde Google: ${google}`);
  console.log('Guías más vistas:');
  Object.entries(porPag).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([p, n]) => console.log(`  ${n}  ${p}`));
  console.log(`Guías publicadas: ${leer(ARCH, []).length}`);
}

// ---------- arranque ----------
(async () => {
  const a = process.argv[2];
  if (a === '--paginas') return generarPaginas();
  if (a === '--borrar') { // node directorio.js --borrar <parte-del-slug>
    const q = process.argv[3] || ''; const g = leer(ARCH, []); const quedan = g.filter(x => !q || !x.slug.includes(q));
    if (!q || quedan.length === g.length) return console.log('No encontré esa guía');
    guardar(ARCH, quedan); generarPaginas(); return console.log('Borradas:', g.length - quedan.length);
  }
  if (a === '--lista') return leer(ARCH, []).forEach(g => console.log(`${g.fecha.slice(0, 10)}  ${g.cat}/${g.slug}`));
  if (a === '--visitas') return visitas();
  if (a === '--ideas') { for (const k of Object.keys(CATEGORIAS)) console.log(k, await ideas(k, 8)); return; }
  if (a === '--una') { try { await publicarUna(); } catch (e) { log('error:', e.message); process.exitCode = 1; } return; }
  // modo continuo: reparte las guías del día con horarios variados
  generarPaginas();
  log(`directorio en marcha: ${POR_DIA} guías por día`);
  for (;;) {
    try { await publicarUna(); } catch (e) { log('error:', e.message); }
    const base = 24 * 3600e3 / POR_DIA;
    await dormir(base * (0.75 + Math.random() * 0.5));
  }
})();
