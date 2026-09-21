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
  if (!sup || String(sup.password) !== String(password)) {
    cache.put(key, String(intentos + 1), _LOGIN_VENTANA_SEGUNDOS);
    return { error: _LOGIN_ERROR };
  }
  cache.remove(key); // un login exitoso limpia el contador
  return { sup: sup };
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

// Admin para las acciones por GET. Las cuatro herramientas manuales
// (restyleSheet, clearVisitRows, removeFilter, getDebugLog) no las llama
// ningún front: se invocan pegando la URL en el navegador, así que siguen
// aceptando usuario+contraseña en el querystring — deuda conocida, ver
// CLAUDE.md. El límite de intentos de _authSupervisor igual las cubre.
// Ninguna acción por GET la llama el frontend (createSupervisorSheet, que era
// la única, pasó a POST), así que solo mira el par u/p.
function _requireAdminGet(e) {
  const auth = _authSupervisor(e.parameter.u || '', e.parameter.p || '');
  return (auth.sup && auth.sup.isAdmin) ? auth.sup : null;
}

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

  // ── Aplicar el estilo visual del template a un spreadsheet ya existente ──
  // (solo admin) — para "poner al día" spreadsheets creados antes de este cambio.
  if (action === 'restyleSheet') {
    if (!_requireAdminGet(e)) {
      return _ok({ ok: false, error: 'No autorizado' });
    }
    const sup = _getSupervisorRaw(e.parameter.supervisor || '');
    if (!sup || !sup.spreadsheetId) return _ok({ ok: false, error: 'Supervisor sin spreadsheet asignado' });
    const ss = SpreadsheetApp.openById(sup.spreadsheetId);
    const sheet = (sup.sheetName && ss.getSheetByName(sup.sheetName)) || ss.getSheets()[0];
    const found = _findHeaderRow(sheet);
    const numCols = found ? found.headers.length : sheet.getLastColumn();
    _applyTemplateStyle(sheet, numCols);
    return _ok({ ok: true });
  }

  // ── Borrar todas las filas de datos (dejando el header) de un spreadsheet ──
  // (solo admin) — recorre TODAS las pestañas y devuelve el detalle de lo
  // que borró en cada una, para poder verificar sin adivinar.
  if (action === 'clearVisitRows') {
    if (!_requireAdminGet(e)) {
      return _ok({ ok: false, error: 'No autorizado' });
    }
    const spreadsheetId = e.parameter.spreadsheetId || '';
    if (!spreadsheetId) return _ok({ ok: false, error: 'Falta spreadsheetId' });
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const result = ss.getSheets().map(function (sh) {
      const r = _clearDataRows(sh);
      r.sheet = sh.getName();
      return r;
    });
    return _ok({ ok: true, sheets: result });
  }

  // ── Lista de supervisores (para el sidebar y panel admin) ──
  if (action === 'getSupervisors') {
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
    const fileId = e.parameter.id || '';
    if (!fileId) return _ok({ ok: false, error: 'Falta id' });
    // Este endpoint es público a propósito (gerencia ve las fotos sin login,
    // ver CLAUDE.md), así que NO puede servir cualquier archivo de Drive que la
    // cuenta dueña del script pueda leer: solo los que están registrados como
    // foto de alguna visita. Si no figura, se corta acá sin tocar Drive.
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
    const supervisorParam = e.parameter.supervisor || '';
    const val = _props().getProperty('localesbase|' + supervisorParam);
    let locales = [];
    if (val) { try { locales = JSON.parse(val); } catch (_) {} }
    return _ok({ ok: true, locales: locales });
  }

  // ── Datos de locales ──────────────────────────────────────
  if (action === 'getLocalData') {
    const all = _props().getProperties();
    const localData = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('localdata|') === 0) {
        try { localData[k.slice(10)] = JSON.parse(all[k]); } catch (_) {}
      }
    });
    return _ok({ ok: true, localData });
  }

  // ── Sacar el Filter de un spreadsheet ya existente (solo admin) ──
  // Un Filter activo rompe appendRow y puede ocultar filas si le queda
  // algún criterio aplicado. Recorre todas las pestañas y lo saca.
  if (action === 'removeFilter') {
    if (!_requireAdminGet(e)) {
      return _ok({ ok: false, error: 'No autorizado' });
    }
    const spreadsheetId = e.parameter.spreadsheetId || '';
    if (!spreadsheetId) return _ok({ ok: false, error: 'Falta spreadsheetId' });
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const result = ss.getSheets().map(function (sh) {
      const had = !!sh.getFilter();
      _removeFilterIfAny(sh);
      return { sheet: sh.getName(), hadFilter: had };
    });
    return _ok({ ok: true, sheets: result });
  }

  // ── DEBUG temporal: último error de doPost ────────────────────
  if (action === 'getDebugLog') {
    if (!_requireAdminGet(e)) {
      return _ok({ ok: false, error: 'No autorizado' });
    }
    const raw = _props().getProperty('debug|lastError');
    return _ok({ ok: true, log: raw ? JSON.parse(raw) : null });
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

    // ── Crear supervisor (solo admin) ────────────────────────
    if (data.action === 'createSupervisor') {
      const admin = _requireAdmin(data);
      if (admin.error) return _ok({ ok: false, error: admin.error, expired: admin.expired });
      const nuevoUsername = String(data.newUsername || '').trim();
      if (!nuevoUsername) return _ok({ ok: false, error: 'Falta el nombre de usuario' });
      // Antes hacía setProperty a secas: crear un supervisor con un usuario que
      // ya existía lo sobrescribía en silencio. Repitiendo el usuario del admin
      // se podía reemplazar su propio registro y quedarse sin acceso de admin.
      const yaExiste = _buscarUsernameExistente(nuevoUsername);
      if (yaExiste) return _ok({ ok: false, error: 'Ese usuario ya existe' });
      _props().setProperty('supervisor|' + nuevoUsername, JSON.stringify({
        name: data.nombre, password: data.newPassword, zona: data.zona || '',
        spreadsheetId: data.spreadsheetId || '', sheetName: data.sheetName || '',
        isAdmin: data.isAdmin || false
      }));
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

    // ── Guardar fotos en Drive ───────────────────────────────
    if (data.action === 'savePhoto') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error, expired: resolved.expired });
      const local = data.local || '';
      const fecha = data.fecha || '';
      const b64List = data.fotos || [];
      const urls = b64List.map(function (b64, i) {
        const clean = b64.replace(/^data:image\/\w+;base64,/, '');
        const bytes = Utilities.base64Decode(clean);
        const blob = Utilities.newBlob(bytes, 'image/jpeg',
          'gondola_' + local + '_' + fecha.replace(/\//g, '-') + '_' + i + '.jpg');
        const file = DriveApp.createFile(blob);
        // No hace falta compartir el archivo: se sirve autenticado a través
        // de la acción "fotoImg" de este mismo script (ver doGet), que evita
        // el hotlinking poco confiable de "drive.google.com/...".
        return ScriptApp.getService().getUrl() + '?action=getFotoData&id=' + file.getId();
      });
      // Leer-modificar-escribir: sin lock, dos subidas simultáneas a la misma
      // visita (o una subida mientras updateVisita migra las fotos) se pisan y
      // se pierden URLs. Los archivos ya están en Drive a esta altura: el lock
      // protege el índice, no la subida.
      return _conLock(function () {
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
