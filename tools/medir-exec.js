// Medición del /exec real (ver CLAUDE.md → "Transporte y reintentos").
// Sigue los redirects A MANO para registrar cada salto: así se vio que el 404
// sale del echo de googleusercontent y nunca del /exec.
// Guarda SOLO metadatos (status, host, content-type, <title>, tamaño, tiempos):
// nunca el cuerpo de una respuesta. Sin cookies, igual que el front.
//
// Uso (desde la raíz del repo; tarda ~20 min y hace ~140 lecturas):
//   node tools/medir-exec.js && node tools/resumir.js
// Con GATE_ENFORCE_READS='1' las lecturas piden token de gate. Pasalo por
// variable de entorno (nunca por argumento, que queda en el historial):
//   read -rs ARR_GATE_TOKEN && export ARR_GATE_TOKEN && node tools/medir-exec.js
// El token no se escribe en la salida ni se imprime.
// Salida: tools/medicion.jsonl (una línea por pedido; ignorado por git).
const fs = require('fs');
const path = require('path');
const EXEC = 'https://script.google.com/macros/s/AKfycbwxvvZZKtVbho8D0-gJexf8apr8I6miKKDYj57R8FINWYq8N489ztlHxt8ScQRFDXiF1w/exec';
const OUT = path.join(__dirname, 'medicion.jsonl');
const TOKEN = process.env.ARR_GATE_TOKEN || '';
fs.writeFileSync(OUT, '');

async function medir(fase, grupo, qs) {
  const reg = { fase, grupo, accion: qs.split('&')[0].replace('action=', ''), inicio: Date.now() };
  try {
    const t0 = Date.now();
    // Cadena completa de saltos, como la sigue el navegador (hasta 10).
    // De cada salto: status, host, ruta con los ids tapados, NOMBRES de los
    // parámetros (nunca valores) y tiempo.
    reg.saltos = [];
    let url = new URL(EXEC + '?' + qs + (TOKEN ? '&t=' + encodeURIComponent(TOKEN) : ''));
    let final;
    for (let i = 0; i < 10; i++) {
      const th = Date.now();
      const r = await fetch(url, { redirect: 'manual', cache: 'no-store' });
      const loc = r.headers.get('location');
      reg.saltos.push({
        s: r.status, host: url.host,
        path: url.pathname.split('/').map(p => (p.length > 20 ? '…' : p)).join('/'),
        params: [...url.searchParams.keys()].join(','),
        ms: Date.now() - th,
      });
      if (!loc || r.status < 300 || r.status >= 400) { final = r; break; }
      await r.arrayBuffer().catch(() => {});
      url = new URL(loc, url);
    }
    if (!final) throw new Error('más de 10 redirects');
    reg.s1 = reg.saltos[0].s;
    reg.nSaltos = reg.saltos.length;
    reg.cadena = reg.saltos.map(h => h.s + '@' + h.host.split('.')[1] + h.path).join(' → ');
    reg.multiCuenta = reg.saltos.some(h => /\/u\/\d+\//.test(h.path));
    reg.sFinal = final.status;
    reg.ct = (final.headers.get('content-type') || '').split(';')[0];
    const txt = await final.text();
    reg.bytes = txt.length;
    reg.forma = txt.startsWith('FECHA') ? 'csv' : txt.startsWith('{') ? 'json' : /^\s*</.test(txt) ? 'html' : 'otro';
    if (reg.forma === 'html') reg.title = ((txt.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().slice(0, 120);
    if (reg.forma === 'json') { try { const j = JSON.parse(txt); reg.jsonOk = j.ok; if (j.ok === false) reg.jsonError = String(j.error).slice(0, 80); } catch (_) { reg.forma = 'json-roto'; } }
    reg.ms = Date.now() - t0;
  } catch (e) {
    reg.excepcion = String(e.message || e).slice(0, 120);
    reg.ms = Date.now() - reg.inicio;
  }
  fs.appendFileSync(OUT, JSON.stringify(reg) + '\n');
  return reg;
}

// La carga real del dashboard (la misma en el front de antes y después de la
// etapa 3; lo que cambió es que ahora cada pedido lleva el token):
//  arranque: loadData + loadLocalesBase (si no es Global) + loadSupervisors, en paralelo
//  al llegar el CSV: loadNotas + loadFotos + loadLocalData, en paralelo
async function cargaDashboard(fase, grupo, zona) {
  const ola1 = zona === 'all'
    ? ['action=getVisitas&all=1&_t=' + Date.now(), 'action=getSupervisors']
    : ['action=getVisitas&supervisor=' + zona + '&_t=' + Date.now(), 'action=getLocalesBase&supervisor=' + zona, 'action=getSupervisors'];
  const r1 = await Promise.all(ola1.map(qs => medir(fase, grupo, qs)));
  // el front solo dispara la ola 2 si getVisitas salió bien
  if (r1[0].forma !== 'csv') return;
  await Promise.all(['action=getNotas', 'action=getFotos', 'action=getLocalData'].map(qs => medir(fase, grupo, qs)));
}

(async () => {
  const log = m => console.log(new Date().toISOString().slice(11, 19), m);
  log('secuencial getSupervisors x30');
  for (let i = 0; i < 30; i++) await medir('secuencial', 'seq-sup', 'action=getSupervisors');
  log('secuencial getVisitas&all=1 x30');
  for (let i = 0; i < 30; i++) await medir('secuencial', 'seq-vis', 'action=getVisitas&all=1&_t=' + Date.now());
  log('ráfagas: 5 cargas de supervisor y 5 Global, una por vez');
  for (let i = 0; i < 5; i++) {
    await cargaDashboard('paralelo-1', 'sup-' + i, 'artucastro');
    await cargaDashboard('paralelo-1', 'glob-' + i, 'all');
  }
  log('ráfagas: 3 dashboards Global a la vez, x2');
  for (let i = 0; i < 2; i++) {
    await Promise.all([0, 1, 2].map(k => cargaDashboard('paralelo-3', 'multi-' + i + '-' + k, 'all')));
  }
  log('fin');
})();
