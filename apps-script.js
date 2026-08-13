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

// Valida usuario/contraseña y devuelve el registro del supervisor (o null).
function _authSupervisor(username, password) {
  const sup = _getSupervisorRaw(username);
  if (!sup) return null;
  if (String(sup.password) !== String(password)) return null;
  return sup;
}

function _requireAdmin(data) {
  const sup = _authSupervisor(data.username, data.password);
  if (!sup || !sup.isAdmin) return null;
  return sup;
}

// Resuelve a qué supervisor (dueño de spreadsheet) apunta una operación
// de escritura, validando que quien la pide esté autorizado a hacerlo.
function _resolveTarget(data) {
  const actor = _authSupervisor(data.username, data.password);
  if (!actor) return { error: 'Usuario o contraseña incorrectos' };
  const targetUsername = data.targetUsername || data.username;
  if (targetUsername !== data.username && !actor.isAdmin) {
    return { error: 'No autorizado para editar esta zona' };
  }
  const target = targetUsername === data.username ? actor : _getSupervisorRaw(targetUsername);
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

  // ── Login de supervisor ────────────────────────────────────
  if (action === 'login') {
    const sup = _authSupervisor(e.parameter.u || '', e.parameter.p || '');
    if (!sup) {
      const exists = _getSupervisorRaw(e.parameter.u || '');
      return _ok({ ok: false, error: exists ? 'Contraseña incorrecta' : 'Usuario no encontrado' });
    }
    return _ok({ ok: true, supervisor: {
      name: sup.name, username: e.parameter.u, zona: sup.zona, isAdmin: sup.isAdmin || false
    }});
  }

  // ── Crear spreadsheet nuevo para un supervisor (solo admin) ──
  // Va por GET (no por doPost) para poder leer el spreadsheetId/url de vuelta:
  // los POST a este script se mandan con mode:'no-cors' (limitación de Apps
  // Script con CORS en POST) y por lo tanto la respuesta queda inaccesible.
  if (action === 'createSupervisorSheet') {
    if (!_requireAdmin({ username: e.parameter.u, password: e.parameter.p })) {
      return _ok({ ok: false, error: 'No autorizado' });
    }
    const template = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const nuevo = SpreadsheetApp.create('Arrivata - ' + (e.parameter.nombre || 'Supervisor'));
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

  // ── Aplicar el estilo visual del template a un spreadsheet ya existente ──
  // (solo admin) — para "poner al día" spreadsheets creados antes de este cambio.
  if (action === 'restyleSheet') {
    if (!_requireAdmin({ username: e.parameter.u, password: e.parameter.p })) {
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
    if (!_requireAdmin({ username: e.parameter.u, password: e.parameter.p })) {
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
    if (!_requireAdmin({ username: e.parameter.u, password: e.parameter.p })) {
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
    if (!_requireAdmin({ username: e.parameter.u, password: e.parameter.p })) {
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

    // ── Crear supervisor (solo admin) ────────────────────────
    if (data.action === 'createSupervisor') {
      if (!_requireAdmin(data)) return _ok({ ok: false, error: 'No autorizado' });
      const key = 'supervisor|' + data.newUsername;
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
        name: data.nombre, password: data.newPassword, zona: data.zona || '',
        spreadsheetId: data.spreadsheetId || '', sheetName: data.sheetName || '',
        isAdmin: data.isAdmin || false
      }));
      return _ok();
    }

    // ── Eliminar supervisor (solo admin) ─────────────────────
    if (data.action === 'deleteSupervisor') {
      if (!_requireAdmin(data)) return _ok({ ok: false, error: 'No autorizado' });
      PropertiesService.getScriptProperties().deleteProperty('supervisor|' + data.targetUsername);
      return _ok();
    }

    // ── Guardar fotos en Drive ───────────────────────────────
    if (data.action === 'savePhoto') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error });
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
      const key = 'foto|' + local + '|' + fecha;
      var existing = [];
      try { existing = JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '[]'); } catch (_) {}
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(existing.concat(urls)));
      return _ok();
    }

    // ── Guardar locales base de un supervisor (autocompletado) ──
    if (data.action === 'saveLocalesBase') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error });
      PropertiesService.getScriptProperties().setProperty(
        'localesbase|' + resolved.targetUsername, JSON.stringify(data.locales || []));
      return _ok();
    }

    // ── Guardar datos del local ──────────────────────────────
    if (data.action === 'saveLocalData') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error });
      PropertiesService.getScriptProperties().setProperty(
        'localdata|' + data.local, JSON.stringify(data.datos || {}));
      return _ok();
    }

    // ── Guardar nota ─────────────────────────────────────────
    if (data.action === 'saveNota') {
      const resolved = _resolveTarget(data);
      if (resolved.error) return _ok({ ok: false, error: resolved.error });
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
      if (resolved.error) return _ok({ ok: false, error: resolved.error });
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

        const row = headers.map(function (h) {
          if (h === 'FECHA') return data.fecha || '';
          if (/^d[iíI][aá]$/i.test(h.trim())) return data.dia || '';
          if (h === 'Local') return data.local || '';
          if (h === 'Ubicación' || h === 'Ubicacion') return data.ubicacion || '';
          if (h === 'Supervisor') return target.name || '';
          if (data.productos && h in data.productos) return data.productos[h];
          return '';
        });

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

    // ── Reportes con IA: proxy a Anthropic (solo supervisores identificados) ──
    // La API key vive acá (Propiedades del script → ANTHROPIC_API_KEY), nunca
    // en el navegador. Antes el dashboard le pegaba directo a Anthropic con la
    // key guardada en localStorage — visible para cualquiera con acceso al
    // navegador. Ahora el navegador solo manda el prompt; este proxy hace la
    // llamada real y devuelve la respuesta de Anthropic tal cual.
    if (data.action === 'callClaude') {
      const actor = _authSupervisor(data.username, data.password);
      if (!actor) return _ok({ ok: false, error: 'Usuario o contraseña incorrectos' });
      const apiKey = _props().getProperty('ANTHROPIC_API_KEY');
      if (!apiKey) return _ok({ ok: false, error: 'Falta configurar la API key de Anthropic en el proyecto de Apps Script (Configuración del proyecto → Propiedades del script → ANTHROPIC_API_KEY).' });

      const payload = {
        model: 'claude-sonnet-5',
        max_tokens: data.maxTokens || 2048,
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
