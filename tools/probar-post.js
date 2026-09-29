// POSTs inofensivos (acción inexistente → "Acción desconocida", no escribe
// nada, no toca el gate) siguiendo los redirects como un navegador: tras un
// 302, el siguiente salto va por GET. Registra la cadena y, si el cuerpo final
// no es JSON, sus primeros caracteres (una respuesta así no trae datos).
//
// Con esto se cazó el REBOTE DEL ECHO en un POST (30/09/2026): 302 /exec →
// 302 echo → 302 /exec (GET, sin parámetros) → 200 "OK" en texto plano, que
// es la respuesta de doGet sin action. Pasa en ~1 de cada 20 POST.
// Uso: node tools/probar-post.js [cantidad]   (por defecto 15)
const EXEC = 'https://script.google.com/macros/s/AKfycbwxvvZZKtVbho8D0-gJexf8apr8I6miKKDYj57R8FINWYq8N489ztlHxt8ScQRFDXiF1w/exec';
const N = Number(process.argv[2] || 15);
(async () => {
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    const saltos = [];
    let url = new URL(EXEC), opts = { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'pingDiagnostico' }), redirect: 'manual' };
    let r;
    for (let k = 0; k < 10; k++) {
      r = await fetch(url, opts);
      const loc = r.headers.get('location');
      saltos.push(r.status + '@' + url.host.split('.')[1] + url.pathname.split('/').map(p => (p.length > 20 ? '…' : p)).join('/') +
        (url.search ? '?[' + [...url.searchParams.keys()].join(',') + ']' : ''));
      if (!loc || r.status < 300 || r.status >= 400) break;
      await r.arrayBuffer().catch(() => {});
      url = new URL(loc, url);
      opts = { method: 'GET', redirect: 'manual' };
    }
    const txt = await r.text();
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    let forma;
    try { JSON.parse(txt); forma = 'JSON ' + txt.slice(0, 60); } catch (_) { forma = 'NO-JSON ct=' + ct + ' len=' + txt.length + ' inicio=' + JSON.stringify(txt.slice(0, 20)); }
    console.log((Date.now() - t0) + 'ms | ' + saltos.join(' → ') + ' | ' + forma);
  }
})();
