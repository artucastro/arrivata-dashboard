// Resume tools/medicion.jsonl (la salida de medir-exec.js): tasa de fallas por
// salto, cadenas de redirects, forma de la respuesta y latencias p50/p95.
// Uso: node tools/resumir.js [archivo.jsonl]
const fs = require('fs');
const path = require('path');
const L = fs.readFileSync(process.argv[2] || path.join(__dirname, 'medicion.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-');
const q = (arr, p) => { if (!arr.length) return '-'; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const bueno = r => (r.accion === 'getVisitas' ? r.forma === 'csv' : r.forma === 'json' && r.jsonOk === true);

function tabla(nombre, grupos) {
  console.log('\n## ' + nombre);
  console.log('grupo | n | OK | 404 final | HTML | excepción | 3+ saltos | p50 ms | p95 ms | máx ms');
  for (const [g, rs] of grupos) {
    const ms = rs.map(r => r.ms);
    console.log([g, rs.length, pct(rs.filter(bueno).length, rs.length),
      pct(rs.filter(r => r.sFinal === 404).length, rs.length),
      pct(rs.filter(r => r.forma === 'html').length, rs.length),
      pct(rs.filter(r => r.excepcion).length, rs.length),
      pct(rs.filter(r => r.nSaltos >= 3).length, rs.length),
      q(ms, 0.5), q(ms, 0.95), Math.max(...ms)].join(' | '));
  }
}
const por = f => { const m = new Map(); L.forEach(r => { const k = f(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return m; };

tabla('Por fase', por(r => r.fase));
tabla('Por fase y acción', por(r => r.fase + ' · ' + r.accion));
tabla('Por cantidad de saltos', por(r => r.nSaltos + ' saltos'));

console.log('\n## Cadenas de saltos distintas (status@host/ruta), con cuántas veces aparecen');
const cad = por(r => r.cadena || ('EXC ' + r.excepcion));
[...cad.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([c, rs]) =>
  console.log(rs.length + ' × ' + c + '  [final: ' + [...new Set(rs.map(r => r.forma + (r.title ? ' "' + r.title + '"' : '')))].join('; ') + ']'));

console.log('\n## Tiempo por salto (p50 / p95 / máx ms), por posición');
for (let i = 0; i < 6; i++) {
  const ms = L.map(r => r.saltos && r.saltos[i] && r.saltos[i].ms).filter(x => x !== undefined);
  if (ms.length) console.log('salto ' + (i + 1) + ': n=' + ms.length + ' · ' + q(ms, 0.5) + ' / ' + q(ms, 0.95) + ' / ' + Math.max(...ms));
}
console.log('\nmulti-cuenta (/u/N/) en algún salto: ' + L.filter(r => r.multiCuenta).length + ' de ' + L.length);
const malos = L.filter(r => !bueno(r));
if (malos.length) {
  console.log('\n## Pedidos que no salieron bien');
  malos.forEach(r => console.log(r.fase + ' · ' + r.grupo + ' · ' + r.accion + ' · ' + (r.cadena || '') + ' · final ' + r.sFinal + ' ' + r.forma +
    (r.title ? ' "' + r.title + '"' : '') + (r.jsonError ? ' error="' + r.jsonError + '"' : '') + (r.excepcion ? ' EXC ' + r.excepcion : '') + ' · ' + r.ms + ' ms'));
}
