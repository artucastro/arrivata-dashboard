// ─────────────────────────────────────────────────────────────
// INSTRUCCIONES PARA CONFIGURAR:
// 1. Abrí el Google Spreadsheet
// 2. Menú: Extensiones → Apps Script
// 3. Borrá el código que haya y pegá TODO este archivo
// 4. Clic en "Guardar"
// 5. Clic en "Implementar" → "Administrar implementaciones"
//    → Editar (lápiz) → Nueva versión → Implementar
// La URL no cambia.
// ─────────────────────────────────────────────────────────────
//
// Modelo multi-supervisor: cada supervisor tiene su PROPIO
// spreadsheet (campo `spreadsheetId`). Este script sigue viviendo
// en un único proyecto (el mismo de siempre, mismo deployment/URL)
// pero abre el spreadsheet de cada supervisor por ID en vez de
// operar siempre sobre el spreadsheet
//  donde está bindeado.
//
// Contrato de las acciones que escriben datos (doPost): siempre
// viajan `username` + `password` del usuario autenticado que hace
// la operación. Si la operación afecta la zona de OTRO supervisor
// (ej. un admin cargando una visita para otra zona), se agrega
// `targetUsername`; si no se manda, el target es el propio usuario.
// ─────────────────────────────────────────────────────────────

function _ok(data) {
  return ContentService.createTextOutput(JSON.stringify(data || { ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function _props() { return PropertiesService.getScriptProperties(); }

function _getSupervisorRaw(username) {
  if (!username) return null;
  const val = _props().getProperty('supervisor|' + username);
  if (!val) return null;
  try { return JSON.parse(val); } catch (_) { return null; }
}

// ── Límite de intentos de login ──────────────────────────────
// 5 fallos por usuario en 15 min. El contador vive en CacheService y la clave
// normaliza el usuario (trim + minúsculas) para que no se esquive cambiando
// mayúsculas. Corre también para usuarios que NO existen: si solo contara los
// existentes, el bloqueo delataría cuáles son. Cada fallo renueva la ventana.
// Limitación conocida: al ser por usuario, alguien puede bloquear a un
// supervisor a propósito durante 15 min (riesgo aceptado; Apps Script no
// expone la IP del que llama, así que no hay con qué acotarlo mejor).
const _LOGIN_MAX_INTENTOS = 5;
const _LOGIN_VENTANA_SEGUNDOS = 15 * 60;
// Mensaje ÚNICO para usuario inexistente y contraseña incorrecta: distinguirlos
// permitía descubrir qué usuarios existen probando nombres.
const _LOGIN_ERROR = 'Usuario o contraseña incorrectos';
const _LOGIN_BLOQUEADO = 'Demasiados intentos. Probá de nuevo en 15 minutos';

function _loginIntentosKey(username) {
  return 'login|' + String(username || '').trim().toLowerCase();
}

// ── Hash de contraseñas ──────────────────────────────────────
// Apps Script no expone bcrypt/scrypt/argon2 ni un PBKDF2 propio, así que se
// itera HMAC-SHA256 (el núcleo de PBKDF2) con salt por usuario. Se hace así y
// no encadenando SHA-256 a mano porque es la construcción estándar, se puede
// nombrar con precisión y reinyecta la contraseña como clave en cada vuelta.
//
// Qué compra y qué NO, sin vueltas:
// - Compra: no hay texto plano guardado, así que una captura de la pantalla de
//   propiedades, un export o un contratista con acceso temporal no entrega
//   contraseñas que los supervisores casi seguro reusan en otro lado. El salt
//   por usuario mata las rainbow tables y evita que se vea de un vistazo que
//   dos supervisores comparten contraseña.
// - NO compra dureza de memoria. SHA-256 es lo más amigable que hay para una
//   GPU. La guía actual de OWASP para PBKDF2-SHA256 son 600.000 iteraciones,
//   que acá serían más de 10 s por login: inalcanzable. Estamos muy por debajo
//   de esa recomendación, y es el techo de la plataforma, no una elección.
// - Contra alguien que YA puede leer Script Properties esto es casi inútil para
//   proteger el sistema: esa misma persona lee GATE_PASSWORD y la
//   ANTHROPIC_API_KEY, y como leer implica escribir, puede crearse un
//   supervisor admin con un hash calculado por ella. Que nadie lea esto como
//   "las contraseñas ya están a salvo": no lo están, y subir N no lo arregla.
// `passwordAlgo` queda guardado en cada registro para poder subir el costo más
// adelante y re-hashear solo, con el mismo mecanismo perezoso de la migración.
//
// Por qué SHA-256 en JS puro y no Utilities (medido en el runtime real, 29/09/2026):
// - Velocidad: Utilities.computeHmacSha256Signature + base64Encode costaban
//   1–5 ms POR ITERACIÓN (cada llamada cruza de V8 al lado Java); 10.000
//   vueltas eran 10–40 s por login. En JS puro son ~0,0065 ms por vuelta.
// - Corrección: computeHmacSha256Signature(string, string) SIN charset
//   convierte todo carácter no ASCII en '?', así que "contraseña" y
//   "contrase?a" (y "contraseüa") daban el mismo hash. Con Charset.UTF_8 o
//   con bytes UTF-8 coincide con esta implementación. Cualquier llamada nueva
//   a Utilities que reciba texto de usuario tiene que pasar Charset.UTF_8.
// Cuando se cambió de construcción había 0 registros hasheados
// (_contarHashesGuardados), así que no hizo falta una ruta legacy.
// OJO con _PASS_ITER: medirlo en el editor con _benchHash() antes de
// deployar; la idea es ~200–300 ms por login en la corrida más lenta.
const _PASS_ALGO = 'hmac-sha256-utf8-js';
const _PASS_ITER = 30000;

function _randomSalt() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// acc = salt; N veces acc = base64(HMAC-SHA256(mensaje = acc, clave = password)),
// con la contraseña en UTF-8. Todo en JS: ver arriba por qué no Utilities.
function _hashPassword(password, salt, iter) {
  const n = iter || _PASS_ITER;
  const prep = _hmacSha256Prep(_utf8Bytes(String(password)));
  let acc = String(salt);
  for (let i = 0; i < n; i++) {
    acc = _base64Js(_hmacSha256Js(prep, _utf8Bytes(acc)));
  }
  return acc;
}

// Correr a mano en el editor (Ejecutar → _benchHash) para elegir _PASS_ITER.
// No es un endpoint: no consume cuota del /exec y se puede repetir. El login
// paga este costo UNA vez; ninguna lectura hashea nunca. La primera línea
// compara en vivo contra Utilities con Charset.UTF_8 (iter=1, clave con ñ y
// tildes). Solo loguea tiempos y el resultado de esa comparación.
function _benchHash() {
  const clave = 'contraseñaDePrueba áéíóú', salt = _randomSalt();
  const ref = Utilities.base64Encode(
    Utilities.computeHmacSha256Signature(salt, clave, Utilities.Charset.UTF_8));
  Logger.log(_hashPassword(clave, salt, 1) === ref ? 'equivalencia OK' : 'equivalencia FALLA');
  [20000, 30000, 40000].forEach(function (n) {
    const t0 = Date.now();
    _hashPassword('contraseñaDePrueba123', _randomSalt(), n);
    const ms = Date.now() - t0;
    Logger.log(n + ' iteraciones → ' + ms + ' ms (' + (ms / n).toFixed(4) + ' ms/iter)');
  });
}

// ── SHA-256 / HMAC en JS puro ────────────────────────────────────────────────
// Lo usa _hashPassword. Verificado contra vectores conocidos y contra
// Utilities + Charset.UTF_8 en el runtime real.
const _SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map(function (k) { return k | 0; });
const _SHA256_IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
].map(function (k) { return k | 0; });

// Procesa un bloque de 64 bytes de `m` desde `off` sobre el estado `st` (8
// enteros de 32 bits, se modifica en el lugar). `W` es un buffer de 64 que se
// reusa entre bloques para no alocar.
function _sha256Bloque(st, m, off, W) {
  for (let i = 0; i < 16; i++) {
    const j = off + i * 4;
    W[i] = ((m[j] & 255) << 24) | ((m[j + 1] & 255) << 16) | ((m[j + 2] & 255) << 8) | (m[j + 3] & 255);
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15], w2 = W[i - 2];
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + _SHA256_K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
}

// Termina un SHA-256 partiendo del estado `st0`, que ya absorbió `prefijo`
// bytes (0 para un hash desde cero, 64 para la mitad de un HMAC). Devuelve el
// estado final; no toca `st0`.
function _sha256Desde(st0, m, prefijo) {
  const st = st0.slice();
  const W = new Array(64);
  const n = m.length;
  const enteros = n - (n % 64);
  for (let off = 0; off < enteros; off += 64) _sha256Bloque(st, m, off, W);
  const resto = n - enteros;
  const cola = new Array(resto < 56 ? 64 : 128).fill(0);
  for (let i = 0; i < resto; i++) cola[i] = m[enteros + i];
  cola[resto] = 0x80;
  const bits = (prefijo + n) * 8;
  const alto = Math.floor(bits / 0x100000000), bajo = bits >>> 0;
  const L = cola.length;
  cola[L - 8] = alto >>> 24; cola[L - 7] = (alto >>> 16) & 255; cola[L - 6] = (alto >>> 8) & 255; cola[L - 5] = alto & 255;
  cola[L - 4] = bajo >>> 24; cola[L - 3] = (bajo >>> 16) & 255; cola[L - 2] = (bajo >>> 8) & 255; cola[L - 1] = bajo & 255;
  for (let off = 0; off < L; off += 64) _sha256Bloque(st, cola, off, W);
  return st;
}

// Estado → 32 bytes CON SIGNO (-128..127), el formato de Utilities.computeDigest.
function _sha256EstadoABytes(st) {
  const out = new Array(32);
  for (let i = 0; i < 8; i++) {
    const w = st[i];
    out[i * 4] = w >> 24;
    out[i * 4 + 1] = (w << 8) >> 24;
    out[i * 4 + 2] = (w << 16) >> 24;
    out[i * 4 + 3] = (w << 24) >> 24;
  }
  return out;
}

// SHA-256 de un array de bytes (con o sin signo). Devuelve bytes con signo.
function _sha256Bytes(bytes) {
  return _sha256EstadoABytes(_sha256Desde(_SHA256_IV, bytes, 0));
}

// String → bytes UTF-8, como hace Utilities con un argumento string. Un
// surrogate suelto va como '?' (0x3F), que es lo que hace Java; en la práctica
// una contraseña tipeada nunca trae uno.
function _utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdfff) out.push(0x3f);
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Base64 estándar con padding, igual que Utilities.base64Encode.
function _base64Js(bytes) {
  let s = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] & 255, b1 = i + 1 < n ? bytes[i + 1] & 255 : 0, b2 = i + 2 < n ? bytes[i + 2] & 255 : 0;
    s += _B64[b0 >> 2] + _B64[((b0 & 3) << 4) | (b1 >> 4)] +
      (i + 1 < n ? _B64[((b1 & 15) << 2) | (b2 >> 6)] : '=') +
      (i + 2 < n ? _B64[b2 & 63] : '=');
  }
  return s;
}

// HMAC-SHA256 con la clave pre-absorbida: los bloques ipad/opad dependen solo
// de la clave (la contraseña, fija durante todo el loop), así que se calculan
// UNA vez. Cada vuelta queda en 2 bloques de compresión. Mismo resultado que
// el HMAC de libro: es solo no repetir trabajo.
function _hmacSha256Prep(clave) {
  let k = clave.length > 64 ? _sha256Bytes(clave) : clave;
  const ipad = new Array(64), opad = new Array(64);
  for (let i = 0; i < 64; i++) {
    const b = i < k.length ? k[i] & 255 : 0;
    ipad[i] = b ^ 0x36; opad[i] = b ^ 0x5c;
  }
  const W = new Array(64);
  const adentro = _SHA256_IV.slice(), afuera = _SHA256_IV.slice();
  _sha256Bloque(adentro, ipad, 0, W);
  _sha256Bloque(afuera, opad, 0, W);
  return { adentro: adentro, afuera: afuera };
}
function _hmacSha256Js(prep, mensaje) {
  const interno = _sha256EstadoABytes(_sha256Desde(prep.adentro, mensaje, 64));
  return _sha256EstadoABytes(_sha256Desde(prep.afuera, interno, 64));
}

// Cuántos registros ya tienen contraseña hasheada. Solo cantidades y sí/no,
// ningún valor. Correr a mano en el editor: sirve para seguir la migración
// perezosa (cada supervisor pasa a hasheado en su primer login) y para saber,
// antes de cambiar la construcción del hash, si hay algo guardado que romper.
function _contarHashesGuardados() {
  const todas = _props().getProperties();
  let sups = 0, conHash = 0, conSalt = 0, conIter = 0, enPlano = 0, ilegibles = 0;
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('supervisor|') !== 0) return;
    sups++;
    let s;
    try { s = JSON.parse(todas[k]); } catch (e) { ilegibles++; return; }
    if (!s || typeof s !== 'object') { ilegibles++; return; }
    if (s.passwordHash) conHash++;
    if (s.passwordSalt) conSalt++;
    if (s.passwordIter) conIter++;
    if (typeof s.password === 'string') enPlano++;
  });
  Logger.log('supervisores: ' + sups);
  Logger.log('con passwordHash: ' + conHash + ' · con passwordSalt: ' + conSalt + ' · con passwordIter: ' + conIter);
  Logger.log('con password en texto plano: ' + enPlano + ' · ilegibles: ' + ilegibles);
  const gate = todas.GATE_PASSWORD;
  let gateHasheado = false;
  try { const g = JSON.parse(gate); gateHasheado = !!(g && typeof g === 'object' && (g.passwordHash || g.passwordSalt)); } catch (e) {}
  Logger.log('GATE_PASSWORD configurada: ' + !!gate + ' · con forma de hash: ' + gateHasheado);
}

// Comparación en tiempo constante: evita filtrar cuántos caracteres del hash
// coincidieron. Con hashes de largo fijo es barato hacerlo bien.
function _igualSeguro(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let dif = 0;
  for (let i = 0; i < sa.length; i++) dif |= (sa.charCodeAt(i) ^ sb.charCodeAt(i));
  return dif === 0;
}

// Devuelve el registro con la contraseña ya hasheada. Se usa tanto al crear un
// supervisor como al migrar uno viejo.
function _conPasswordHasheada(sup, password) {
  const salt = _randomSalt();
  const copia = {};
  Object.keys(sup || {}).forEach(function (k) { copia[k] = sup[k]; });
  delete copia.password; // el texto plano no sobrevive a la migración
  copia.passwordAlgo = _PASS_ALGO;
  copia.passwordSalt = salt;
  copia.passwordIter = _PASS_ITER;
  copia.passwordHash = _hashPassword(password, salt, _PASS_ITER);
  return copia;
}

// Valida usuario/contraseña. Devuelve { sup } si son correctas, o { error }
// (con bloqueado:true si se agotaron los intentos). Es el ÚNICO lugar del
// script donde se compara una contraseña.
function _authSupervisor(username, password) {
  const cache = CacheService.getScriptCache();
  const key = _loginIntentosKey(username);
  const intentos = Number(cache.get(key) || 0);
  if (intentos >= _LOGIN_MAX_INTENTOS) {
    // Ni siquiera se evalúa la contraseña mientras dure el bloqueo.
    return { error: _LOGIN_BLOQUEADO, bloqueado: true };
  }
  const sup = _getSupervisorRaw(username);
  if (!sup || !_passwordCorrecta(sup, password)) {
    cache.put(key, String(intentos + 1), _LOGIN_VENTANA_SEGUNDOS);
    return { error: _LOGIN_ERROR };
  }
  cache.remove(key); // un login exitoso limpia el contador
  // Migración perezosa: si el registro todavía estaba en texto plano, este
  // login acertado es el momento de hashearlo. Nadie queda afuera por la
  // migración y no hace falta un script de conversión aparte.
  const migrado = _migrarPasswordSiHaceFalta(username, sup, password);
  return { sup: migrado || sup };
}

// Valida la contraseña contra el registro, acepte éste el formato nuevo
// (passwordHash + passwordSalt) o el viejo (password en texto plano).
// Mantener la rama vieja es lo que permite la migración perezosa y, de paso,
// es el procedimiento de reset: se borra el hash, se escribe `password` en
// plano y el próximo login lo vuelve a hashear.
function _passwordCorrecta(sup, password) {
  if (sup.passwordHash) {
    return _igualSeguro(sup.passwordHash, _hashPassword(password, sup.passwordSalt, sup.passwordIter));
  }
  if (typeof sup.password === 'string') {
    return String(sup.password) === String(password);
  }
  return false;
}

function _migrarPasswordSiHaceFalta(username, sup, password) {
  if (sup.passwordHash) return null; // ya estaba migrado
  try {
    const hasheado = _conPasswordHasheada(sup, password);
    _props().setProperty('supervisor|' + username, JSON.stringify(hasheado));
    return hasheado;
  } catch (_) {
    return null; // si falla, el login igual es válido; se reintenta la próxima
  }
}

// ── Tokens de sesión ─────────────────────────────────────────
// La identidad de un supervisor logueado viaja como un token opaco con
// vencimiento (1 h), no como su contraseña real. El token se emite en el
// login (doPost) y se guarda en CacheService: token -> perfil del supervisor.
const _TOKEN_TTL_SECONDS = 3600; // igual al VERIFY_TTL_MS del frontend

function _issueToken(username, sup) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('token|' + token, JSON.stringify({
    username: username,
    name: sup.name,
    zona: sup.zona || '',
    isAdmin: sup.isAdmin || false
  }), _TOKEN_TTL_SECONDS);
  return token;
}

// ── Gate de la página ────────────────────────────────────────
// La contraseña compartida que da acceso de solo-lectura al panorama global
// vivía hardcodeada en index.html, o sea a la vista de cualquiera que abriera
// el view-source de la página publicada. Ahora vive en la Script Property
// GATE_PASSWORD y se valida acá.
//
// Rotarla NO requiere redeploy: se edita la property y listo. Los tokens ya
// emitidos siguen valiendo hasta que venzan; para matarlos en el acto se
// incrementa GATE_EPOCH, que va embebido en cada token.
//
// El límite de intentos es GLOBAL, no por usuario, porque el gate no tiene
// usuario y Apps Script no expone la IP del que llama. Por eso el umbral es
// más alto que el del login de supervisor: con 5 globales, cualquiera que
// fallara 5 veces dejaría afuera a todo el mundo durante 15 minutos.
const _GATE_TOKEN_TTL = 21600; // 6 h — el máximo que admite CacheService
const _GATE_MAX_INTENTOS = 20;
const _GATE_VENTANA_SEGUNDOS = 15 * 60;
const _GATE_ERROR = 'Contraseña incorrecta';
const _GATE_BLOQUEADO = 'Demasiados intentos. Probá de nuevo en 15 minutos';
const _GATE_EXPIRADO = 'Sesión vencida — volvé a ingresar la contraseña';

function _gateEpoch() {
  return String(_props().getProperty('GATE_EPOCH') || '1');
}

// Sube el epoch. Si el valor guardado no es un número (editado a mano, vacío),
// cae a un timestamp: lo único que importa es que quede DISTINTO del anterior,
// porque la comparación es por igualdad de string.
function _subirEpoch() {
  const actual = Number(_gateEpoch());
  const nuevo = String(isNaN(actual) ? Date.now() : actual + 1);
  _props().setProperty('GATE_EPOCH', nuevo);
  return nuevo;
}

// El contador va indexado por epoch a propósito. Como el límite es global,
// cualquiera que conozca la URL puede quemar los 20 intentos y dejar afuera a
// todos durante 15 min. Colgándolo del epoch, subir GATE_EPOCH destraba el
// bloqueo al instante — sin redeploy y sin esperar la ventana. Es la salida de
// emergencia de un límite que, por no haber IP en Apps Script, no puede ser
// más fino. La defensa real es que la contraseña sea larga y aleatoria.
function _gateIntentosKey() {
  return 'gatelogin|' + _gateEpoch();
}

// Valida la contraseña del gate y devuelve { token } o { error }.
// Falla CERRADA: si GATE_PASSWORD no está configurada o está vacía, no entra
// nadie. Nunca hay que dejar pasar por "la property todavía no existe".
function _gateLogin(password) {
  const cache = CacheService.getScriptCache();
  const key = _gateIntentosKey();
  const intentos = Number(cache.get(key) || 0);
  if (intentos >= _GATE_MAX_INTENTOS) {
    return { error: _GATE_BLOQUEADO, bloqueado: true };
  }
  const esperada = _props().getProperty('GATE_PASSWORD');
  // Sin property configurada no entra nadie, y se dice con un mensaje distinto
  // para no mandar al admin a buscar una contraseña mal tipeada.
  if (!esperada) {
    return { error: 'El acceso no está configurado. Avisale al administrador.' };
  }
  if (!String(password || '') || !_igualSeguro(esperada, password)) {
    cache.put(key, String(intentos + 1), _GATE_VENTANA_SEGUNDOS);
    return { error: _GATE_ERROR };
  }
  cache.remove(key);
  const token = Utilities.getUuid();
  cache.put('gate|' + token, JSON.stringify({ epoch: _gateEpoch() }), _GATE_TOKEN_TTL);
  return { token: token, ttl: _GATE_TOKEN_TTL };
}

// true si el token de gate existe y su epoch sigue siendo el vigente.
function _gateTokenValido(token) {
  if (!token) return false;
  const raw = CacheService.getScriptCache().get('gate|' + token);
  if (!raw) return false;
  try {
    return JSON.parse(raw).epoch === _gateEpoch();
  } catch (_) {
    return false;
  }
}

// Resuelve la identidad del actor de una operación de escritura: SOLO por
// `token` de sesión. Antes, si no venía token, se aceptaba `username` +
// `password` (compatibilidad con clientes viejos de la migración a tokens).
// Esa rama se eliminó: permitía probar contraseñas contra cualquier escritura
// (ej. saveNota) y saltear así el límite de intentos del login.
// Sin token, o con uno vencido/inválido, responde expired:true — el frontend
// usa ese flag para pedir login de nuevo y reintentar la escritura sola.
// Devuelve { sup, username } o { error, expired }.
function _resolveToken(data) {
  if (data.token) {
    const raw = CacheService.getScriptCache().get('token|' + data.token);
    if (raw) {
      try {
        const t = JSON.parse(raw);
        const sup = _getSupervisorRaw(t.username);
        if (sup) return { sup: sup, username: t.username };
      } catch (_) {}
    }
  }
  return { error: 'Sesión vencida — volvé a iniciar sesión', expired: true };
}

// ── Auth de las LECTURAS ─────────────────────────────────────
// Las lecturas (getVisitas, getNotas, getFotos, getLocalData, getSupervisors,
// getLocalesBase, getFotoData) eran públicas a propósito, para que gerencia
// viera el panorama sin perfil de supervisor. Eso significaba que cualquiera
// con la URL del /exec se bajaba las visitas de todos. Desde 24/09/2026 piden
// token: el del gate (gerencia) o el de supervisor (que ya pasó el gate).
// La intención original se mantiene — gerencia sigue sin necesitar perfil —,
// solo que ahora se autentica. Reabrir estas lecturas es una REGRESIÓN.
//
// El token viaja por querystring (parámetro `t`) y no por header porque
// doGet(e) de Apps Script no puede leer headers HTTP: solo ve e.parameter.
//
// GATE_ENFORCE_READS es la palanca de transición y de rollback:
//   '1'            → lectura sin token rechazada (estado final)
//   ausente o '0'  → lectura sin token permitida (el front viejo sigue vivo
//                    entre el redeploy y el push del front nuevo)
// Ojo con la semántica: un token PRESENTE pero inválido se rechaza SIEMPRE,
// incluso con la palanca en '0'. Así el front nuevo ejercita su camino de
// re-login desde el primer día, y la palanca solo cubre al cliente viejo que
// no manda token.
//
// El flag de la respuesta es `gateExpired`, NO `expired`. Son dos credenciales
// distintas y mezclarlas rompe cosas: `expired` significa "se venció la sesión
// de supervisor", y el front reacciona limpiándola (_postOnce) para pedir
// login y reintentar la escritura. Si una lectura vencida devolviera `expired`,
// un refresh de fondo le voltearía la sesión de escritura a un supervisor que
// está en medio de una carga.
function _resolveReadAuth(e) {
  const tok = (e && e.parameter && e.parameter.t) || '';
  if (tok) {
    // Primero el de gate: es el caso común y evita mirar el cache de tokens de
    // supervisor en cada lectura. El de supervisor es el fallback (dura 1 h
    // contra las 6 h del de gate).
    if (_gateTokenValido(tok)) return { ok: true };
    if (CacheService.getScriptCache().get('token|' + tok)) return { ok: true };
    return { error: _GATE_EXPIRADO, gateExpired: true };
  }
  if (String(_props().getProperty('GATE_ENFORCE_READS') || '0') === '1') {
    return { error: _GATE_EXPIRADO, gateExpired: true };
  }
  return { ok: true };
}

// Admin para las escrituras (doPost). Distingue DOS casos, porque el frontend
// los trata distinto: token ausente o vencido devuelve expired:true (el
// wrapper de escrituras pide login y reintenta solo), mientras que un token
// válido sin permisos es un "No autorizado" liso, que no se arregla
// volviendo a loguearse. Devuelve { sup, username } o { error, expired? }.
function _requireAdmin(data) {
  const auth = _resolveToken(data);
  if (auth.error) return auth;
  if (!auth.sup.isAdmin) return { error: 'No autorizado' };
  return auth;
}

// Busca un username existente comparando normalizado (trim + minúsculas),
// para que "Gonza" no pueda crearse encima de "gonza".
function _buscarUsernameExistente(username) {
  const buscado = String(username || '').trim().toLowerCase();
  if (!buscado) return null;
  const all = _props().getProperties();
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('supervisor|') !== 0) continue;
    const u = keys[i].slice(11);
    if (u.trim().toLowerCase() === buscado) return u;
  }
  return null;
}

// Cuántos supervisores tienen isAdmin. Se usa para no borrar al último.
function _contarAdmins() {
  const all = _props().getProperties();
  return Object.keys(all).filter(function (k) {
    if (k.indexOf('supervisor|') !== 0) return false;
    try { return !!JSON.parse(all[k]).isAdmin; } catch (_) { return false; }
  }).length;
}

// Las cuatro herramientas manuales (restyleSheet, clearVisitRows, removeFilter,
// getDebugLog) aceptaban usuario+contraseña en el querystring, así que la
// contraseña del admin terminaba en el historial del navegador y en los logs de
// Google. Desde 24/09/2026 van por POST con token, como el resto de las
// escrituras. Las ramas GET quedan devolviendo este mensaje en vez de
// desaparecer, para que una URL vieja guardada en favoritos diga qué pasó en
// lugar de fallar de una forma confusa.
const _SOLO_POST = 'Esta herramienta ahora va por POST con token de sesión';

// Resuelve a qué supervisor (dueño de spreadsheet) apunta una operación
// de escritura, validando que quien la pide esté autorizado a hacerlo.
function _resolveTarget(data) {
  const auth = _resolveToken(data);
  if (auth.error) return { error: auth.error, expired: auth.expired };
  const actor = auth.sup;
  const actorUsername = auth.username;
  const targetUsername = data.targetUsername || actorUsername;
  if (targetUsername !== actorUsername && !actor.isAdmin) {
    return { error: 'No autorizado para editar esta zona' };
  }
  const target = targetUsername === actorUsername ? actor : _getSupervisorRaw(targetUsername);
  if (!target) return { error: 'Supervisor destino no encontrado' };
  return { actor: actor, target: target, targetUsername: targetUsername };
}

function _openSpreadsheetForSupervisor(sup) {
  if (sup && sup.spreadsheetId) return SpreadsheetApp.openById(sup.spreadsheetId);
  return SpreadsheetApp.getActiveSpreadsheet(); // fallback legacy
}

// Encuentra la fila de encabezado FECHA en una hoja. Devuelve {headers, hIdx} o null.
function _findHeaderRow(sheet) {
  const values = sheet.getDataRange().getValues();
  const hIdx = values.findIndex(function (r) {
    return String(r[0]).trim().toUpperCase() === 'FECHA';
  });
  if (hIdx === -1) return null;
  return { headers: values[hIdx], hIdx: hIdx };
}

// Normaliza una celda de FECHA a "dd/MM/yyyy": Sheets guarda fechas como
// objeto Date internamente (no como el string que mandó el cliente), así
// que compararlas con === directo nunca matchea. Mismo criterio que usa
// getVisitas (fmtCell) para las fechas que le manda al dashboard.
function _fmtFecha(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return String(v || '').trim();
}

// Arma la fila a escribir (nueva visita o edición de una existente) según
// el orden real de columnas de la hoja. Compartida por saveVisita/updateVisita.
function _buildVisitaRow(headers, data, target) {
  return headers.map(function (h) {
    if (h === 'FECHA') return data.fecha || '';
    if (/^d[iíI][aá]$/i.test(h.trim())) return data.dia || '';
    if (h === 'Local') return data.local || '';
    if (h === 'Ubicación' || h === 'Ubicacion') return data.ubicacion || '';
    if (h === 'Supervisor') return target.name || '';
    if (data.productos && h in data.productos) return data.productos[h];
    return '';
  });
}

// Corre una escritura que no puede pisarse con otra igual (updateVisita,
// savePhoto: las dos son leer-modificar-escribir). A diferencia de saveVisita
// —que ante un lock vencido prefiere seguir sin lock antes que perder una
// visita cargada a mano— acá NO se sigue sin lock: se devuelve un error
// reintentable SIN haber escrito nada.
function _conLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return _ok({ ok: false, error: 'Sistema ocupado, probá de nuevo', busy: true });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// Igual que _buildVisitaRow pero para EDITAR una fila que ya existe: parte de
// los valores que la fila tiene hoy y solo pisa las celdas que el payload trae
// y el encabezado reconoce. Antes se reconstruía la fila entera con
// _buildVisitaRow, así que cualquier columna que este script no conoce (por
// ejemplo una "Observaciones internas" agregada a mano en el Sheet) se
// blanqueaba al editar la visita.
function _mergeVisitaRow(headers, filaActual, data, target) {
  const actualDe = function (i) {
    return (filaActual && i < filaActual.length && filaActual[i] !== undefined) ? filaActual[i] : '';
  };
  return headers.map(function (h, i) {
    const actual = actualDe(i);
    if (h === 'FECHA') return data.fecha || actual;
    if (/^d[iíI][aá]$/i.test(h.trim())) return data.dia || actual;
    if (h === 'Local') return data.local || actual;
    if (h === 'Ubicación' || h === 'Ubicacion') return data.ubicacion || actual;
    if (h === 'Supervisor') return target.name || actual;
    // Los productos que el formulario manejó vienen SIEMPRE en data.productos
    // (los que el supervisor marcó "NO" viajan como ''), así que un producto
    // se puede seguir vaciando. Lo que no está en data.productos es una
    // columna que el formulario no conoce: se deja tal cual estaba.
    if (data.productos && h in data.productos) return data.productos[h];
    return actual;
  });
}

// Borra el contenido (valores Y fórmulas) de las filas de datos de una hoja,
// dejando el header intacto. Hace flush() y relee para confirmar que
// realmente quedó vacío (por si alguna fórmula tipo IMPORTRANGE la repuebla).
function _clearDataRows(sheet) {
  const found = _findHeaderRow(sheet);
  if (!found) return { cleared: false, reason: 'sin header FECHA' };
  const lastRow = sheet.getLastRow();
  const dataStart = found.hIdx + 2; // 1-indexed, fila siguiente al header
  const numCols = Math.max(found.headers.length, sheet.getLastColumn());
  const rowsFound = Math.max(0, lastRow - dataStart + 1);
  if (rowsFound > 0) {
    sheet.getRange(dataStart, 1, rowsFound, numCols).clearContent();
  }
  SpreadsheetApp.flush();
  const after = sheet.getDataRange().getValues();
  const stillHasData = after.slice(found.hIdx + 1).some(function (r) { return String(r[0]).trim() !== ''; });
  return { cleared: true, rowsFound: rowsFound, stillHasData: stillHasData };
}

// Copia el estilo visual (formato de celda, fila congelada, ancho de columnas)
// del header del sheet plantilla (tu propio spreadsheet) a la hoja de un
// supervisor, para que todos los spreadsheets se vean iguales.
// Nota: Range.copyTo() de Apps Script NO funciona entre spreadsheets distintos
// (tira "El intervalo de destino y de origen deben estar en la misma hoja de
// cálculo"), así que copiamos cada propiedad de estilo por separado — esas
// sí devuelven/aceptan valores planos, cruzan spreadsheets sin problema.
function _applyTemplateStyle(targetSheet, numCols) {
  const template = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const found = _findHeaderRow(template);
  const templateHeaderRow = found ? found.hIdx + 1 : 1;
  const src = template.getRange(templateHeaderRow, 1, 1, numCols);
  const dst = targetSheet.getRange(1, 1, 1, numCols);

  dst.setFontWeights(src.getFontWeights());
  dst.setFontStyles(src.getFontStyles());
  dst.setFontLines(src.getFontLines());
  dst.setFontColors(src.getFontColors());
  dst.setFontSizes(src.getFontSizes());
  dst.setFontFamilies(src.getFontFamilies());
  dst.setBackgrounds(src.getBackgrounds());
  dst.setHorizontalAlignments(src.getHorizontalAlignments());
  dst.setVerticalAlignments(src.getVerticalAlignments());
  dst.setWraps(src.getWraps());
  dst.setNumberFormats(src.getNumberFormats());

  targetSheet.setFrozenRows(1); // solo la fila 1 (header) queda fija al bajar
  for (let i = 1; i <= numCols; i++) {
    targetSheet.setColumnWidth(i, template.getColumnWidth(i));
  }

  // NOTA: antes acá se creaba un Filter con createFilter(), pero un Filter
  // activo rompe sheet.appendRow() (queda en no-op sin error) y además puede
  // ocultar filas nuevas si le queda algún criterio aplicado sin querer desde
  // la UI de Sheets. No lo creamos más — quien quiera filtrar puede crear uno
  // manualmente desde Datos → Crear un filtro.
  _removeFilterIfAny(targetSheet);
}

// Saca cualquier Filter activo de la hoja (ver nota en _applyTemplateStyle).
function _removeFilterIfAny(sheet) {
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();
}

// Id de Drive dentro de una URL de foto. Conviven DOS formatos guardados:
//   a) https://script.google.com/macros/s/<dep>/exec?action=getFotoData&id=<id>
//      (las que sube savePhoto, con el <dep> del deployment de ese momento —
//      hay ids de deployments viejos guardados, no solo del actual);
//   b) https://drive.google.com/uc?export=view&id=<id>  (fotos viejas).
// Por eso se compara el ID, nunca la URL entera.
function _fotoIdDeUrl(url) {
  const m = /[?&]id=([A-Za-z0-9_-]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

// Un id de Drive válido es solo [A-Za-z0-9_-]. Se valida ANTES de buscar nada,
// para no llevar caracteres raros a ninguna consulta.
function _esIdDriveValido(id) {
  return /^[A-Za-z0-9_-]{5,200}$/.test(String(id || ''));
}

// ¿Este id figura en alguna propiedad foto|<local>|<fecha>? Recorrer todas las
// propiedades cuesta lo mismo que getNotas/getFotos (medido contra el /exec
// real: la diferencia queda dentro del ruido de red), así que no se cachea.
function _fotoIdRegistrado(fileId) {
  if (!_esIdDriveValido(fileId)) return false;
  const all = _props().getProperties();
  const keys = Object.keys(all);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('foto|') !== 0) continue;
    let urls;
    try { urls = JSON.parse(all[keys[i]]); } catch (_) { continue; }
    if (!Array.isArray(urls)) urls = [urls];
    for (let j = 0; j < urls.length; j++) {
      if (_fotoIdDeUrl(urls[j]) === fileId) return true;
    }
  }
  return false;
}

function _fotoKey(local, fecha) { return 'foto|' + local + '|' + fecha; }

// Lista de URLs guardada bajo una clave foto|… ([] si no hay o está corrupta).
function _leerFotos(key) {
  try {
    const v = JSON.parse(_props().getProperty(key) || '[]');
    return Array.isArray(v) ? v : [v];
  } catch (_) { return []; }
}

// Mueve las fotos de una visita cuando la edición le cambió el local o la
// fecha: la clave es foto|<local>|<fecha>, así que sin esto las fotos quedaban
// colgadas de la clave vieja y desaparecían de la visita.
// Se llama DENTRO del lock de updateVisita. Si la clave nueva ya tiene fotos
// se fusionan (nunca se pisan), y se escribe la nueva ANTES de borrar la
// vieja: si algo falla en el medio, las fotos quedan duplicadas —recuperables—
// en vez de perdidas.
// La NOTA no se toca acá: la migra el frontend (borra la vieja y escribe la
// nueva con saveNota). Los datos del local (localdata|<local>) tampoco: van
// con clave global y sin fecha, así que moverlos puede robarle los datos a
// otra visita del mismo local — queda para la etapa de ids únicos.
function _migrarFotos(origLocal, origFecha, local, fecha) {
  const keyVieja = _fotoKey(origLocal, origFecha);
  const keyNueva = _fotoKey(local, fecha);
  if (keyVieja === keyNueva) return { migradas: 0 };
  const viejas = _leerFotos(keyVieja);
  if (!viejas.length) return { migradas: 0 };
  const nuevas = _leerFotos(keyNueva);
  const fusion = nuevas.concat(viejas.filter(function (u) { return nuevas.indexOf(u) === -1; }));
  _props().setProperty(keyNueva, JSON.stringify(fusion));
  _props().deleteProperty(keyVieja);
  return { migradas: viejas.length };
}

// Junta filas (con encabezado FECHA) de un spreadsheet en canonHeaders/dataRows (por referencia).
function _collectRowsFromSpreadsheet(ss, sheetName, canonHeaders, dataRows) {
  const sheets = sheetName
    ? [ss.getSheetByName(sheetName)].filter(function (s) { return !!s; })
    : ss.getSheets();
  sheets.forEach(function (sh) {
    const values = sh.getDataRange().getValues();
    const hIdx = values.findIndex(function (r) {
      return String(r[0]).trim().toUpperCase() === 'FECHA';
    });
    if (hIdx === -1) return;
    const headers = values[hIdx].map(function (h) { return String(h).trim(); });
    headers.forEach(function (h) { if (h && canonHeaders.indexOf(h) === -1) canonHeaders.push(h); });
    values.slice(hIdx + 1).forEach(function (r) {
      if (String(r[0]).trim() === '') return;
      const map = {};
      headers.forEach(function (h, i) { map[h] = r[i]; });
      dataRows.push(map);
    });
  });
}

// ── GET ───────────────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action || '';

  // ── Login: SOLO por doPost ─────────────────────────────────
  // Antes existía acá una variante GET por compatibilidad con el frontend
  // viejo cacheado. Dejaba la contraseña en el querystring (y por lo tanto en
  // los logs de Google), así que se eliminó. No evalúa credenciales: responde
  // el mismo error genérico siempre.
  if (action === 'login') {
    return _ok({ ok: false, error: 'El login va por POST' });
  }

  // ── Herramientas manuales de admin ────────────────────────
  // Pasaron a POST con token (ver _SOLO_POST). La rama GET queda solo para
  // avisar, así una URL vieja no falla de forma confusa.
  if (action === 'restyleSheet' || action === 'clearVisitRows' ||
      action === 'removeFilter' || action === 'getDebugLog') {
    return _ok({ ok: false, error: _SOLO_POST });
  }

  // ── Lista de supervisores (para el sidebar y panel admin) ──
  if (action === 'getSupervisors') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const all = _props().getProperties();
    const sups = [];
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('supervisor|') !== 0) return;
      try {
        var s = JSON.parse(all[k]);
        sups.push({ username: k.slice(11), name: s.name, zona: s.zona, isAdmin: s.isAdmin || false });
      } catch (_) {}
    });
    return _ok({ ok: true, supervisors: sups });
  }

  // ── Notas ─────────────────────────────────────────────────
  if (action === 'getNotas') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const all = _props().getProperties();
    const notas = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('nota|') === 0) notas[k.slice(5)] = all[k];
    });
    return _ok({ ok: true, notas });
  }

  // ── Datos (base64) de una foto puntual — el script la trae de Drive
  // (autenticado como dueño del archivo) y la devuelve como texto dentro
  // de la respuesta JSON. No se puede devolver el Blob crudo directo desde
  // doGet ("el valor que muestra no es un valor de retorno admitido" — solo
  // se admite TextOutput/HtmlOutput), y el link público de Drive no carga
  // de forma confiable dentro de un <img> embebido.
  if (action === 'getFotoData') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const fileId = e.parameter.id || '';
    if (!fileId) return _ok({ ok: false, error: 'Falta id' });
    // Aunque ahora pide token, sigue sin poder servir cualquier archivo de
    // Drive que la cuenta dueña del script pueda leer: solo los registrados
    // como foto de alguna visita. Si no figura, se corta acá sin tocar Drive.
    if (!_fotoIdRegistrado(fileId)) return _ok({ ok: false, error: 'Foto no encontrada' });
    try {
      const blob = DriveApp.getFileById(fileId).getBlob();
      return _ok({ ok: true, mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) });
    } catch (err) {
      return _ok({ ok: false, error: 'Foto no encontrada' });
    }
  }

  // ── Fotos de un local (?local=X) o de TODOS los locales (sin local) ──
  if (action === 'getFotos') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const local = e.parameter.local || '';
    const all = _props().getProperties();
    if (local) {
      const prefix = 'foto|' + local + '|';
      const fotos = {};
      Object.keys(all).forEach(function (k) {
        if (k.indexOf(prefix) === 0) {
          try { fotos[k.slice(prefix.length)] = JSON.parse(all[k]); } catch (_) {}
        }
      });
      return _ok({ ok: true, fotos });
    }
    // Sin `local`: devolver todas, agrupadas por local y fecha —
    // para poder mostrar el indicador de fotos en cualquier tabla,
    // no solo en el detalle de un local puntual.
    const fotosPorLocal = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('foto|') !== 0) return;
      const rest = k.slice(5); // "<local>|<fecha>"
      const sep = rest.lastIndexOf('|');
      if (sep === -1) return;
      const loc = rest.slice(0, sep);
      const fecha = rest.slice(sep + 1);
      try {
        if (!fotosPorLocal[loc]) fotosPorLocal[loc] = {};
        fotosPorLocal[loc][fecha] = JSON.parse(all[k]);
      } catch (_) {}
    });
    return _ok({ ok: true, fotos: fotosPorLocal });
  }

  // ── Visitas (lectura en vivo, sin caché de "Publicar en la web") ──
  // ?supervisor=<username>  → solo el spreadsheet de ese supervisor
  // ?all=1                  → combina TODOS los spreadsheets de todos los supervisores
  // (sin ninguno de los dos) → fallback legacy: spreadsheet donde está bindeado el script
  if (action === 'getVisitas') {
    // Ojo: esta acción responde CSV, no JSON. El error de auth SÍ sale como
    // JSON, y el cliente los distingue porque un CSV legítimo siempre arranca
    // con la cabecera FECHA y nunca con '{'.
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const supervisorParam = e.parameter.supervisor || '';
    const wantAll = e.parameter.all === '1';
    const sheetName = e.parameter.sheet || '';

    const canonHeaders = [];
    const dataRows = [];

    if (wantAll) {
      const all = _props().getProperties();
      Object.keys(all).forEach(function (k) {
        if (k.indexOf('supervisor|') !== 0) return;
        var sup;
        try { sup = JSON.parse(all[k]); } catch (_) { return; }
        if (!sup.spreadsheetId) return;
        try {
          const ss = SpreadsheetApp.openById(sup.spreadsheetId);
          _collectRowsFromSpreadsheet(ss, sup.sheetName || '', canonHeaders, dataRows);
        } catch (_) { /* spreadsheet inaccesible: se omite */ }
      });
    } else if (supervisorParam) {
      const sup = _getSupervisorRaw(supervisorParam);
      if (sup) {
        const ss = _openSpreadsheetForSupervisor(sup);
        _collectRowsFromSpreadsheet(ss, sheetName || sup.sheetName || '', canonHeaders, dataRows);
      }
    } else {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      _collectRowsFromSpreadsheet(ss, sheetName, canonHeaders, dataRows);
    }

    if (!canonHeaders.length) canonHeaders.push('FECHA');

    const tz = Session.getScriptTimeZone();
    const fmtCell = function (v) {
      if (v instanceof Date) return Utilities.formatDate(v, tz, 'dd/MM/yyyy');
      let s = (v === null || v === undefined) ? '' : String(v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const lines = [canonHeaders.map(fmtCell).join(',')];
    dataRows.forEach(function (map) {
      lines.push(canonHeaders.map(function (h) { return fmtCell(map[h]); }).join(','));
    });

    return ContentService.createTextOutput(lines.join('\n')).setMimeType(ContentService.MimeType.CSV);
  }

  // ── Locales base de un supervisor (para autocompletar Nueva Visita) ──
  if (action === 'getLocalesBase') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const supervisorParam = e.parameter.supervisor || '';
    const val = _props().getProperty('localesbase|' + supervisorParam);
    let locales = [];
    if (val) { try { locales = JSON.parse(val); } catch (_) {} }
    return _ok({ ok: true, locales: locales });
  }

  // ── Datos de locales ──────────────────────────────────────
  if (action === 'getLocalData') {
    const auth = _resolveReadAuth(e);
    if (auth.error) return _ok({ ok: false, error: auth.error, gateExpired: true });
    const all = _props().getProperties();
    const localData = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('localdata|') === 0) {
        try { localData[k.slice(10)] = JSON.parse(all[k]); } catch (_) {}
      }
    });
    return _ok({ ok: true, localData });
  }


  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

// ── POST ──────────────────────────────────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ── Login de supervisor → emite token de sesión ──────────
    // Recibe u/p en el body (no en el querystring). Devuelve un token opaco
    // con TTL de 1 h; el cliente lo guarda y lo reenvía en cada escritura
    // en vez de la contraseña real.
    if (data.action === 'login') {
      const username = data.u || data.username || '';
      const auth = _authSupervisor(username, data.p || data.password || '');
      if (auth.error) return _ok({ ok: false, error: auth.error });
      const sup = auth.sup;
      return _ok({
        ok: true,
        token: _issueToken(username, sup),
        supervisor: {
          name: sup.name, username: username, zona: sup.zona, isAdmin: sup.isAdmin || false
        }
      });
    }

    // ── Gate de la página ────────────────────────────────────
    // Devuelve un token de solo-lectura. No identifica a nadie: solo acredita
    // que quien pregunta conoce la contraseña compartida. Las escrituras
    // siguen exigiendo el token de supervisor, que es cosa aparte.
    if (data.action === 'gateLogin') {
      const g = _gateLogin(data.password || data.p || '');
      if (g.error) return _ok({ ok: false, error: g.error, bloqueado: g.bloqueado || false });
      return _ok({ ok: true, token: g.token, ttl: g.ttl });
    }

    // ── Crear supervisor (solo admin) ────────────────────────
    if (data.action === 'createSupervisor') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const nuevoUsername = String(data.newUsername || '').trim();
      if (!nuevoUsername) return _ok({ ok: false, error: 'Falta el nombre de usuario' });
      if (!String(data.newPassword || '')) return _ok({ ok: false, error: 'Falta la contraseña' });
      // Antes hacía setProperty a secas: crear un supervisor con un usuario que
      // ya existía lo sobrescribía en silencio. Repitiendo el usuario del admin
      // se podía reemplazar su propio registro y quedarse sin acceso de admin.
      const yaExiste = _buscarUsernameExistente(nuevoUsername);
      if (yaExiste) return _ok({ ok: false, error: 'Ese usuario ya existe' });
      // Nace hasheado: el texto plano no llega nunca a Script Properties.
      _props().setProperty('supervisor|' + nuevoUsername, JSON.stringify(
        _conPasswordHasheada({
          name: data.nombre, zona: data.zona || '',
          spreadsheetId: data.spreadsheetId || '', sheetName: data.sheetName || '',
          isAdmin: data.isAdmin || false
        }, data.newPassword)
      ));
      return _ok();
    }

    // ── Eliminar supervisor (solo admin) ─────────────────────
    if (data.action === 'deleteSupervisor') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const aBorrar = String(data.targetUsername || '').trim();
      if (!aBorrar) return _ok({ ok: false, error: 'Falta el usuario a eliminar' });
      // Dos formas de quedarse sin acceso que antes no se controlaban.
      if (aBorrar.toLowerCase() === String(admin.username || '').trim().toLowerCase()) {
        return _ok({ ok: false, error: 'No podés eliminar tu propio usuario' });
      }
      const sup = _getSupervisorRaw(aBorrar);
      if (!sup) return _ok({ ok: false, error: 'Ese usuario no existe' });
      if (sup.isAdmin && _contarAdmins() <= 1) {
        return _ok({ ok: false, error: 'No se puede eliminar al último admin' });
      }
      _props().deleteProperty('supervisor|' + aBorrar);
      return _ok();
    }

    // ── Crear spreadsheet nuevo para un supervisor (solo admin) ──
    // Antes vivía en doGet, con el token viajando en la URL (y por lo tanto en
    // los logs de Google). Va por POST como el resto de las escrituras: la
    // respuesta con spreadsheetId/url se lee igual.
    if (data.action === 'createSupervisorSheet') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const template = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
      const nuevo = SpreadsheetApp.create('Arrivata - ' + (data.nombre || 'Supervisor'));
      const hojaDefault = nuevo.getSheets()[0]; // la hoja en blanco que Google crea sola

      // Clon exacto de la hoja plantilla (formato, validaciones, todo) — a
      // diferencia de Range.copyTo(), Sheet.copyTo() SÍ funciona entre
      // spreadsheets distintos.
      const hoja = template.copyTo(nuevo);
      hoja.setName(template.getName());
      nuevo.deleteSheet(hojaDefault);
      _removeFilterIfAny(hoja); // copyTo clona un Filter del template si tiene — rompe appendRow y puede ocultar filas

      const clearResult = _clearDataRows(hoja);
      return _ok({
        ok: true, spreadsheetId: nuevo.getId(), url: nuevo.getUrl(), sheetName: hoja.getName(),
        clear: clearResult
      });
    }

    // ── Administración de secretos (solo admin) ──────────────
    // La pantalla "Propiedades del script" del editor pasa a SOLO LECTURA
    // cuando el proyecto tiene muchas propiedades (este tiene más de 50, entre
    // supervisores, notas, fotos y datos de local). O sea que rotar la
    // contraseña del gate, subir el epoch o resetear un supervisor **no se
    // pueden hacer desde la interfaz**. Estas tres acciones son el reemplazo:
    // la contraseña viaja en el cuerpo de un POST por HTTPS, nunca por la URL
    // (que queda en logs e historial), nunca en el código y nunca en el repo.
    //
    // Todas exigen token de admin, que se saca con action:'login'. Ese login
    // usa el limitador por usuario, distinto del limitador global del gate:
    // por eso, aunque el gate esté bloqueado por intentos, un admin siempre
    // puede entrar por acá a destrabarlo.
    if (data.action === 'setGatePassword') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const nueva = String(data.newPassword || '');
      if (nueva.length < 12) {
        return _ok({ ok: false, error: 'La contraseña del gate tiene que tener al menos 12 caracteres' });
      }
      // Un espacio o un salto de línea pegado sin querer hace fallar todos los
      // logins después, sin ninguna pista de por qué. Se rechaza en vez de
      // recortarlo en silencio: recortar sería una sorpresa peor más adelante.
      if (nueva !== nueva.trim()) {
        return _ok({ ok: false, error: 'La contraseña no puede empezar ni terminar con espacios o saltos de línea' });
      }
      _props().setProperty('GATE_PASSWORD', nueva);
      let epoch = _gateEpoch();
      if (data.cerrarSesiones === true) {
        epoch = _subirEpoch();
      }
      return _ok({ ok: true, epoch: epoch, sesionesCerradas: data.cerrarSesiones === true });
    }

    // Invalida TODOS los tokens de gate vivos y, de paso, limpia el contador de
    // intentos (que cuelga del epoch). Sirve para las dos emergencias: "se
    // filtró la contraseña" y "alguien dejó el gate bloqueado".
    if (data.action === 'cerrarSesionesGate') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      return _ok({ ok: true, epoch: _subirEpoch() });
    }

    // Reemplaza al procedimiento viejo de "poner password en plano a mano en la
    // property", que dependía de la pantalla de propiedades.
    if (data.action === 'setSupervisorPassword') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const destino = String(data.targetUsername || '').trim();
      if (!destino) return _ok({ ok: false, error: 'Falta el usuario' });
      const sup = _getSupervisorRaw(destino);
      if (!sup) return _ok({ ok: false, error: 'Ese usuario no existe' });
      const nueva = String(data.newPassword || '');
      if (!nueva) return _ok({ ok: false, error: 'Falta la contraseña nueva' });
      if (nueva !== nueva.trim()) {
        return _ok({ ok: false, error: 'La contraseña no puede empezar ni terminar con espacios o saltos de línea' });
      }
      // Se guarda ya hasheada: el texto plano no toca Script Properties ni
      // siquiera de forma transitoria.
      _props().setProperty('supervisor|' + destino, JSON.stringify(_conPasswordHasheada(sup, nueva)));
      return _ok({ ok: true });
    }

    // ── Herramientas manuales de admin ───────────────────────
    // Las cuatro se invocaban pegando una URL en el navegador con usuario y
    // contraseña en el querystring, así que la contraseña del admin quedaba en
    // el historial y en los logs de Google. Ahora van por POST con token.
    // clearVisitRows además BORRA datos, así que exige confirmar:true.
    if (data.action === 'restyleSheet') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const sup = _getSupervisorRaw(data.supervisor || '');
      if (!sup || !sup.spreadsheetId) return _ok({ ok: false, error: 'Supervisor sin spreadsheet asignado' });
      const ss = SpreadsheetApp.openById(sup.spreadsheetId);
      const sheet = (sup.sheetName && ss.getSheetByName(sup.sheetName)) || ss.getSheets()[0];
      const found = _findHeaderRow(sheet);
      const numCols = found ? found.headers.length : sheet.getLastColumn();
      _applyTemplateStyle(sheet, numCols);
      return _ok({ ok: true });
    }

    if (data.action === 'clearVisitRows') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      if (data.confirmar !== true) {
        return _ok({ ok: false, error: 'clearVisitRows borra todas las filas: mandá confirmar:true' });
      }
      const spreadsheetId = data.spreadsheetId || '';
      if (!spreadsheetId) return _ok({ ok: false, error: 'Falta spreadsheetId' });
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const result = ss.getSheets().map(function (sh) {
        const r = _clearDataRows(sh);
        r.sheet = sh.getName();
        return r;
      });
      return _ok({ ok: true, sheets: result });
    }

    // Un Filter activo rompe appendRow y puede ocultar filas si le queda algún
    // criterio aplicado. Recorre todas las pestañas y lo saca.
    if (data.action === 'removeFilter') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const spreadsheetId = data.spreadsheetId || '';
      if (!spreadsheetId) return _ok({ ok: false, error: 'Falta spreadsheetId' });
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const result = ss.getSheets().map(function (sh) {
        const had = !!sh.getFilter();
        _removeFilterIfAny(sh);
        return { sheet: sh.getName(), hadFilter: had };
      });
      return _ok({ ok: true, sheets: result });
    }

    if (data.action === 'getDebugLog') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const raw = _props().getProperty('debug|lastError');
      return _ok({ ok: true, log: raw ? JSON.parse(raw) : null });
    }

    // ── Guardar fotos en Drive ───────────────────────────────
    if (data.action === 'savePhoto') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      const local = data.local || '';
      const fecha = data.fecha || '';
      const b64List = data.fotos || [];
      // Todo bajo lock, incluida la subida: el índice de fotos es
      // leer-modificar-escribir, así que sin lock dos subidas simultáneas a la
      // misma visita (o una subida mientras updateVisita migra las fotos) se
      // pisan y se pierden URLs. Subir PRIMERO y después pedir el lock haría
      // que, si el lock no se consigue, quedaran archivos sueltos en Drive que
      // nadie referencia (y que el reintento volvería a crear).
      return _conLock(function () {
        const urls = b64List.map(function (b64, i) {
          const clean = b64.replace(/^data:image\/\w+;base64,/, '');
          const bytes = Utilities.base64Decode(clean);
          const blob = Utilities.newBlob(bytes, 'image/jpeg',
            'gondola_' + local + '_' + fecha.replace(/\//g, '-') + '_' + i + '.jpg');
          const file = DriveApp.createFile(blob);
          // No hace falta compartir el archivo: se sirve autenticado a través
          // de la acción "getFotoData" de este mismo script (ver doGet), que
          // evita el hotlinking poco confiable de "drive.google.com/...".
          return ScriptApp.getService().getUrl() + '?action=getFotoData&id=' + file.getId();
        });
        const key = _fotoKey(local, fecha);
        const existing = _leerFotos(key);
        _props().setProperty(key, JSON.stringify(existing.concat(urls)));
        return _ok();
      });
    }

    // ── Guardar locales base de un supervisor (autocompletado) ──
    if (data.action === 'saveLocalesBase') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      PropertiesService.getScriptProperties().setProperty(
        'localesbase|' + resolved.targetUsername, JSON.stringify(data.locales || []));
      return _ok();
    }

    // ── Guardar datos del local ──────────────────────────────
    if (data.action === 'saveLocalData') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      PropertiesService.getScriptProperties().setProperty(
        'localdata|' + data.local, JSON.stringify(data.datos || {}));
      return _ok();
    }

    // ── Guardar nota ─────────────────────────────────────────
    if (data.action === 'saveNota') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      const key = 'nota|' + data.local + '|' + data.fecha;
      if (data.texto && data.texto.trim()) {
        PropertiesService.getScriptProperties().setProperty(key, data.texto.trim());
      } else {
        PropertiesService.getScriptProperties().deleteProperty(key);
      }
      return _ok();
    }

    // ── Guardar visita ────────────────────────────────────────
    if (data.action === 'saveVisita') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      const target = resolved.target;

      // Apps Script ejecuta este doPost por completo y recién DESPUÉS redirige
      // al cliente a una segunda URL para entregarle la respuesta; si ese
      // segundo salto falla (frecuente en la infraestructura de Apps Script),
      // el navegador muestra un error aunque la fila ya se haya guardado acá,
      // y a veces el propio Apps Script dispara dos ejecuciones casi
      // simultáneas para el mismo pedido. clientId identifica un mismo
      // intento de guardado — el cliente reusa el mismo id en reintentos.
      // Un simple "leer caché, después escribir" no alcanza: si dos
      // ejecuciones corren en paralelo, ambas pueden leer el caché vacío
      // antes de que cualquiera llegue a marcarlo. El lock serializa esas
      // ejecuciones para que la segunda vea el caché ya marcado.
      const clientId = data.clientId || '';
      const cache = clientId ? CacheService.getScriptCache() : null;
      const lock = clientId ? LockService.getScriptLock() : null;
      if (lock) {
        try { lock.waitLock(20000); } catch (e) { /* seguir sin lock antes que perder la visita */ }
      }
      try {
        if (cache && cache.get('visita|' + clientId)) return _ok();

        const ss = _openSpreadsheetForSupervisor(target);
        const sheet = (target.sheetName && ss.getSheetByName(target.sheetName)) || ss.getSheets()[0];

        const allValues = sheet.getDataRange().getValues();
        const hIdx = allValues.findIndex(function (r) {
          return String(r[0]).trim().toUpperCase() === 'FECHA';
        });
        if (hIdx === -1) throw new Error('No se encontró la fila FECHA en la hoja ' + sheet.getName());

        const headers = allValues[hIdx].map(function (h) { return String(h).trim(); });
        const row = _buildVisitaRow(headers, data, target);

        // sheet.appendRow() falla silenciosamente en hojas con un Filter activo
        // (las creadas por _applyTemplateStyle) — no tira error ni agrega fila.
        // setValues() en la fila calculada sí persiste.
        const targetRow = sheet.getLastRow() + 1;
        sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
        if (cache) cache.put('visita|' + clientId, '1', 21600); // 6 hs
        return _ok();
      } finally {
        if (lock) lock.releaseLock();
      }
    }

    // ── Editar una visita ya guardada (corregir datos / agregar fotos) ──
    // A diferencia de saveVisita (que agrega una fila), esto ubica la fila
    // original por Local+FECHA y la sobrescribe con setValues() — es
    // naturalmente seguro ante reintentos (no puede duplicar filas), salvo
    // que la fecha editada cambie: un reintento después de eso ya no
    // encontraría la fila por su FECHA original y devolvería error (inofensivo,
    // la edición ya se guardó, no hace falta el mismo lock que saveVisita).
    if (data.action === 'updateVisita') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      const target = resolved.target;

      return _conLock(function () {
        const ss = _openSpreadsheetForSupervisor(target);
        const sheet = (target.sheetName && ss.getSheetByName(target.sheetName)) || ss.getSheets()[0];

        const allValues = sheet.getDataRange().getValues();
        const hIdx = allValues.findIndex(function (r) {
          return String(r[0]).trim().toUpperCase() === 'FECHA';
        });
        if (hIdx === -1) throw new Error('No se encontró la fila FECHA en la hoja ' + sheet.getName());
        const headers = allValues[hIdx].map(function (h) { return String(h).trim(); });
        const localIdx = headers.findIndex(function (h) { return h === 'Local'; });

        const origLocal = String(data.origLocal || '').trim();
        const origFecha = String(data.origFecha || '').trim();
        let rowIdx = -1;
        for (let i = hIdx + 1; i < allValues.length; i++) {
          const fechaMatch = _fmtFecha(allValues[i][0]) === origFecha;
          const localMatch = localIdx === -1 || String(allValues[i][localIdx]).trim() === origLocal;
          if (fechaMatch && localMatch) { rowIdx = i; break; }
        }
        if (rowIdx === -1) {
          return _ok({ ok: false, error: 'No se encontró la visita original — puede que ya se haya editado o borrado.' });
        }

        const row = _mergeVisitaRow(headers, allValues[rowIdx], data, target);
        sheet.getRange(rowIdx + 1, 1, 1, row.length).setValues([row]);

        // Si la edición cambió el local o la fecha, las fotos se mudan con la
        // visita (misma transacción lógica: ya dentro de este lock).
        const fotos = _migrarFotos(origLocal, origFecha, data.local || origLocal, data.fecha || origFecha);
        return _ok({ ok: true, fotosMigradas: fotos.migradas });
      });
    }

    // ── Reportes con IA: proxy a Anthropic (solo supervisores identificados) ──
    // La API key vive acá (Propiedades del script → ANTHROPIC_API_KEY), nunca
    // en el navegador. Antes el dashboard le pegaba directo a Anthropic con la
    // key guardada en localStorage — visible para cualquiera con acceso al
    // navegador. Ahora el navegador solo manda el prompt; este proxy hace la
    // llamada real y devuelve la respuesta de Anthropic tal cual.
    if (data.action === 'callClaude') {
      const auth = _resolveToken(data);
      if (auth.error) return _ok({ ok: false, error: auth.error, expired: auth.expired });
      const apiKey = _props().getProperty('ANTHROPIC_API_KEY');
      if (!apiKey) return _ok({ ok: false, error: 'Falta configurar la API key de Anthropic en el proyecto de Apps Script (Configuración del proyecto → Propiedades del script → ANTHROPIC_API_KEY).' });

      // Sonnet 5 corre "thinking" adaptativo por defecto cuando no se especifica,
      // y en informes largos el razonamiento interno se come TODO el presupuesto
      // de max_tokens → la respuesta vuelve sin bloque de texto y el dashboard
      // lo ve como "Sin respuesta en etapa 1". Para generar informes queremos
      // todo el presupuesto en la salida, así que lo desactivamos explícitamente.
      //
      // Piso de max_tokens en 12000: los informes cortos igual cierran solos
      // mucho antes (max_tokens es un techo, no un objetivo — solo se paga lo
      // generado), pero el Complejo arma TODO en una sola respuesta (todas las
      // zonas + gráficos + conclusiones) y a 4096 se cortaba antes del final.
      // Con thinking apagado cada llamada termina en ~35-60 s.
      const payload = {
        model: 'claude-sonnet-5',
        max_tokens: Math.max(Number(data.maxTokens) || 0, 12000),
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: data.content }]
      };
      const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const status = resp.getResponseCode();
      const body = resp.getContentText();
      if (status < 200 || status >= 300) {
        let errMsg = 'Error HTTP ' + status + ' de Anthropic';
        try { const parsed = JSON.parse(body); if (parsed.error && parsed.error.message) errMsg = parsed.error.message; } catch (_) {}
        return _ok({ ok: false, error: errMsg });
      }
      // Éxito: se devuelve la respuesta de Anthropic tal cual (mismo shape que
      // esperaba el código del dashboard cuando llamaba directo a la API).
      return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
    }

    return _ok({ ok: false, error: 'Acción desconocida' });

  } catch (err) {
    try {
      _props().setProperty('debug|lastError', JSON.stringify({
        time: new Date().toString(), action: (JSON.parse(e.postData.contents) || {}).action,
        error: err.message, stack: err.stack || ''
      }));
    } catch (_) {}
    return _ok({ ok: false, error: err.message });
  }
}
