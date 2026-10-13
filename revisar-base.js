// Revisa que todas las consultas de la app funcionen con la base actual (no cambia nada).
// Uso: node revisar-base.js .
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const dir = process.argv[2], db = new DatabaseSync(path.join(dir, process.argv[3] || 'cajaviva.db'));
const files = [];
(function walk(d){ for (const f of fs.readdirSync(d)) { if (f === 'node_modules' || f === 'public' || f.startsWith('migrar') || f.startsWith('.')) continue; const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } })(dir);
const errs = {}; let n = 0;
const alVuelo = new Set(); for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) alVuelo.add(m[1]);  // tablas que la app crea sola cuando las usa
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /prepare\(\s*(`([^`]*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g; let m;
  while ((m = re.exec(s))) {
    let sql = m[2] ?? m[3] ?? m[4];
    if (/\$\{|\\/.test(sql)) continue;
    n++;
    try { db.prepare(sql); } catch (e) { if (/incomplete input/.test(e.message)) continue; const t = (e.message.match(/no such table: (\w+)/) || [])[1]; if (t && alVuelo.has(t)) continue; const k = e.message; (errs[k] = errs[k] || []).push(path.relative(dir, f)); }
  }
}
console.log('consultas probadas:', n, Object.keys(errs).length ? '' : '- todo OK');
for (const [k, v] of Object.entries(errs)) console.log('ERROR', k, '→', [...new Set(v)].join(', '));
