// Calculadora de precios y ganancia (CajaViva). Todo funciona sin internet; el historial queda en este navegador.
const $ = (id) => document.getElementById(id);
const num = (v) => { v = String(v || '').trim().replace(/\$/g, '').replace(/\s/g, ''); if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.'); else v = v.replace(/[.,]/g, (m, i, s) => (s.slice(i + 1).length === 3 ? '' : '.')); const n = parseFloat(v); return isFinite(n) ? n : 0; };
const pesos = (n) => '$ ' + (Math.round(n * 100) / 100).toLocaleString('es-AR', { maximumFractionDigits: n % 1 ? 2 : 0 });
const pct = (n) => (isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('es-AR') : '—') + '%';
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const leer = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };

let modo = leer('modo', 'precio');
function cambiarModo(m) {
  modo = m; guardar('modo', m);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.modo === m));
  $('m-precio').hidden = m !== 'precio'; $('m-ganancia').hidden = m !== 'ganancia';
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => cambiarModo(b.dataset.modo)));

// ---- Sacar el precio ----
function calcPrecio() {
  const costo = num($('p-costo').value), p = num($('p-pct').value), tipo = document.querySelector('input[name=tipo]:checked').value, red = +$('p-red').value;
  const res = $('p-res');
  if (tipo === 'margen' && p >= 100) { res.classList.add('mal'); res.querySelector('b').textContent = '—'; res.querySelector('em').textContent = 'Sobre el precio tiene que ser menos de 100%'; return null; }
  res.classList.remove('mal');
  let precio = tipo === 'margen' ? costo / (1 - p / 100) : costo * (1 + p / 100);
  if (red > 1 && precio > 0) precio = Math.ceil(precio / red) * red;
  const gan = precio - costo;
  res.querySelector('b').textContent = pesos(precio);
  res.querySelector('em').textContent = `Ganás ${pesos(gan)} por unidad` + (precio > 0 ? ` (${pct(gan / costo * 100)} sobre el costo, ${pct(gan / precio * 100)} sobre el precio)` : '');
  $('p-ayuda').textContent = tipo === 'margen'
    ? `"Sobre el precio": de cada ${pesos(100)} que cobrás, ${pesos(p || 0)} son ganancia.`
    : `"Sobre el costo": le sumás el ${p || 0}% a lo que te costó.`;
  return costo > 0 ? { t: 'precio', costo, p, tipo, red, precio } : null;
}
// ---- Ver mi ganancia ----
function calcGanancia() {
  const costo = num($('g-costo').value), precio = num($('g-precio').value), cant = num($('g-cant').value);
  const gan = precio - costo, res = $('g-res');
  res.classList.toggle('mal', precio > 0 && gan < 0);
  res.querySelector('small').textContent = gan < 0 && precio > 0 ? 'Perdés por unidad' : 'Ganás por unidad';
  res.querySelector('b').textContent = pesos(Math.abs(gan));
  res.querySelector('em').innerHTML = cant > 0 && precio > 0 ? `${gan < 0 ? 'Perdés' : 'Ganás'} ${pesos(Math.abs(gan * cant))} por mes vendiendo ${cant.toLocaleString('es-AR')}` : '&nbsp;';
  $('g-rec').textContent = costo > 0 ? pct(gan / costo * 100) : '—';
  $('g-mar').textContent = precio > 0 ? pct(gan / precio * 100) : '—';
  return costo > 0 && precio > 0 ? { t: 'ganancia', costo, precio, cant } : null;
}

// ---- Historial ----
let hist = leer('hist', []);
let tmr;
function anotar(x) {
  if (!x) return;
  clearTimeout(tmr);
  tmr = setTimeout(() => {
    const clave = JSON.stringify(x);
    hist = [x, ...hist.filter((h) => JSON.stringify(h) !== clave)].slice(0, 6);
    guardar('hist', hist); pintarHist();
  }, 1500);
}
function pintarHist() {
  $('hist').hidden = !hist.length;
  $('lista').innerHTML = '';
  hist.forEach((h) => {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('b');
    if (h.t === 'precio') { a.textContent = `Costo ${pesos(h.costo)} + ${h.p}%`; b.textContent = pesos(h.precio); }
    else { a.textContent = `${pesos(h.costo)} → ${pesos(h.precio)}`; b.textContent = pesos(h.precio - h.costo); }
    li.append(a, b);
    li.addEventListener('click', () => {
      if (h.t === 'precio') { cambiarModo('precio'); $('p-costo').value = h.costo; $('p-pct').value = h.p; document.querySelector(`input[name=tipo][value=${h.tipo}]`).checked = true; $('p-red').value = h.red; calcPrecio(); }
      else { cambiarModo('ganancia'); $('g-costo').value = h.costo; $('g-precio').value = h.precio; $('g-cant').value = h.cant || ''; calcGanancia(); }
    });
    $('lista').appendChild(li);
  });
}
$('borrar').addEventListener('click', () => { hist = []; guardar('hist', hist); pintarHist(); });

['p-costo', 'p-pct', 'p-red'].forEach((id) => $(id).addEventListener('input', () => anotar(calcPrecio())));
document.querySelectorAll('input[name=tipo]').forEach((r) => r.addEventListener('change', () => anotar(calcPrecio())));
['g-costo', 'g-precio', 'g-cant'].forEach((id) => $(id).addEventListener('input', () => anotar(calcGanancia())));

cambiarModo(modo); calcPrecio(); calcGanancia(); pintarHist();
setTimeout(() => (modo === 'precio' ? $('p-costo') : $('g-costo')).focus(), 50);
