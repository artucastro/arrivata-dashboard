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
// operar siempre sobre el spreadsheet donde está bindeado.
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
    const nuevo = SpreadsheetApp.create('Arrivata - ' + (e.parameter.nombre || 'Supervisor'));
    const hoja = nuevo.getSheets()[0];
    const template = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const templateValues = template.getDataRange().getValues();
    const hIdx = templateValues.findIndex(function (r) {
      return String(r[0]).trim().toUpperCase() === 'FECHA';
    });
    const headers = hIdx !== -1
      ? templateValues[hIdx]
      : ['FECHA', 'Día', 'Local', 'Ubicación', 'Supervisor'];
    hoja.getRange(1, 1, 1, headers.length).setValues([headers]);
    hoja.setName('Visitas');
    return _ok({ ok: true, spreadsheetId: nuevo.getId(), url: nuevo.getUrl(), sheetName: hoja.getName() });
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

  // ── Fotos de un local ─────────────────────────────────────
  if (action === 'getFotos') {
    const local = e.parameter.local || '';
    const prefix = 'foto|' + local + '|';
    const all = _props().getProperties();
    const fotos = {};
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(prefix) === 0) {
        try { fotos[k.slice(prefix.length)] = JSON.parse(all[k]); } catch (_) {}
      }
    });
    return _ok({ ok: true, fotos });
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
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return 'https://drive.google.com/uc?export=view&id=' + file.getId();
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

      sheet.appendRow(row);
      return _ok();
    }

    return _ok({ ok: false, error: 'Acción desconocida' });

  } catch (err) {
    return _ok({ ok: false, error: err.message });
  }
}
