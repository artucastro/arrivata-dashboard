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

function _ok(data) {
  return ContentService.createTextOutput(JSON.stringify(data || { ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET ───────────────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action || '';

  // ── Login de supervisor ────────────────────────────────────
  if (action === 'login') {
    const u = e.parameter.u || '';
    const p = e.parameter.p || '';
    const val = PropertiesService.getScriptProperties().getProperty('supervisor|' + u);
    if (!val) return _ok({ ok: false, error: 'Usuario no encontrado' });
    var sup;
    try { sup = JSON.parse(val); } catch(_) { return _ok({ ok: false, error: 'Error interno' }); }
    if (sup.password !== p) return _ok({ ok: false, error: 'Contraseña incorrecta' });
    return _ok({ ok: true, supervisor: {
      name: sup.name, username: u, zona: sup.zona,
      csvUrl: sup.csvUrl, sheetName: sup.sheetName, isAdmin: sup.isAdmin || false
    }});
  }

  // ── Lista de supervisores (para panel admin) ───────────────
  if (action === 'getSupervisors') {
    const all = PropertiesService.getScriptProperties().getProperties();
    const sups = [];
    Object.keys(all).forEach(function(k) {
      if (k.startsWith('supervisor|')) {
        try {
          var s = JSON.parse(all[k]);
          sups.push({
            username: k.slice(11), name: s.name, zona: s.zona,
            sheetName: s.sheetName, csvUrl: s.csvUrl, isAdmin: s.isAdmin || false
          });
        } catch(_) {}
      }
    });
    return _ok({ ok: true, supervisors: sups });
  }

  // ── Notas ─────────────────────────────────────────────────
  if (action === 'getNotas') {
    const all = PropertiesService.getScriptProperties().getProperties();
    const notas = {};
    Object.keys(all).forEach(function(k) {
      if (k.startsWith('nota|')) notas[k.slice(5)] = all[k];
    });
    return _ok({ ok: true, notas });
  }

  // ── Fotos de un local ─────────────────────────────────────
  if (action === 'getFotos') {
    const local = e.parameter.local || '';
    const prefix = 'foto|' + local + '|';
    const all = PropertiesService.getScriptProperties().getProperties();
    const fotos = {};
    Object.keys(all).forEach(function(k) {
      if (k.startsWith(prefix)) {
        try { fotos[k.slice(prefix.length)] = JSON.parse(all[k]); } catch(_) {}
      }
    });
    return _ok({ ok: true, fotos });
  }

  // ── Visitas (lectura en vivo, sin caché de "Publicar en la web") ──
  // Sin "sheet" combina TODAS las hojas del spreadsheet en un solo CSV.
  // Con "sheet=NombreDeHoja" devuelve solo esa hoja.
  if (action === 'getVisitas') {
    const sheetName = e.parameter.sheet || '';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = sheetName
      ? [ss.getSheetByName(sheetName)].filter(function(s) { return !!s; })
      : ss.getSheets();

    let canonHeaders = null;
    const dataRows = [];

    sheets.forEach(function(sh) {
      const values = sh.getDataRange().getValues();
      const hIdx = values.findIndex(function(r) {
        return String(r[0]).trim().toUpperCase() === 'FECHA';
      });
      if (hIdx === -1) return;
      const headers = values[hIdx].map(function(h) { return String(h).trim(); });
      if (!canonHeaders) {
        canonHeaders = headers.slice();
      } else {
        headers.forEach(function(h) {
          if (h && canonHeaders.indexOf(h) === -1) canonHeaders.push(h);
        });
      }
      values.slice(hIdx + 1).forEach(function(r) {
        if (String(r[0]).trim() === '') return;
        const map = {};
        headers.forEach(function(h, i) { map[h] = r[i]; });
        dataRows.push(map);
      });
    });

    if (!canonHeaders) canonHeaders = ['FECHA'];

    const fmtCell = function(v) {
      if (v instanceof Date) {
        return Utilities.formatDate(v, ss.getSpreadsheetTimeZone(), 'dd/MM/yyyy');
      }
      let s = (v === null || v === undefined) ? '' : String(v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    };

    const lines = [canonHeaders.map(fmtCell).join(',')];
    dataRows.forEach(function(map) {
      lines.push(canonHeaders.map(function(h) { return fmtCell(map[h]); }).join(','));
    });

    return ContentService.createTextOutput(lines.join('\n')).setMimeType(ContentService.MimeType.CSV);
  }

  // ── Datos de locales ──────────────────────────────────────
  if (action === 'getLocalData') {
    const all = PropertiesService.getScriptProperties().getProperties();
    const localData = {};
    Object.keys(all).forEach(function(k) {
      if (k.startsWith('localdata|')) {
        try { localData[k.slice(10)] = JSON.parse(all[k]); } catch(_) {}
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

    // ── Crear supervisor ─────────────────────────────────────
    if (data.action === 'createSupervisor') {
      const key = 'supervisor|' + data.username;
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
        name: data.nombre, password: data.password, zona: data.zona || '',
        sheetName: data.sheetName || '', csvUrl: data.csvUrl || '',
        isAdmin: data.isAdmin || false
      }));
      return _ok();
    }

    // ── Eliminar supervisor ──────────────────────────────────
    if (data.action === 'deleteSupervisor') {
      PropertiesService.getScriptProperties().deleteProperty('supervisor|' + data.username);
      return _ok();
    }

    // ── Guardar fotos en Drive ───────────────────────────────
    if (data.action === 'savePhoto') {
      const local = data.local || '';
      const fecha = data.fecha || '';
      const b64List = data.fotos || [];
      const urls = b64List.map(function(b64, i) {
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
      try { existing = JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '[]'); } catch(_) {}
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(existing.concat(urls)));
      return _ok();
    }

    // ── Guardar datos del local ──────────────────────────────
    if (data.action === 'saveLocalData') {
      PropertiesService.getScriptProperties().setProperty(
        'localdata|' + data.local, JSON.stringify(data.datos || {}));
      return _ok();
    }

    // ── Guardar nota ─────────────────────────────────────────
    if (data.action === 'saveNota') {
      const key = 'nota|' + data.local + '|' + data.fecha;
      if (data.texto && data.texto.trim()) {
        PropertiesService.getScriptProperties().setProperty(key, data.texto.trim());
      } else {
        PropertiesService.getScriptProperties().deleteProperty(key);
      }
      return _ok();
    }

    // ── Guardar visita ────────────────────────────────────────
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Si el supervisor especificó su hoja, usarla; si no, la primera
    const sheet = (data.supervisorSheet && ss.getSheetByName(data.supervisorSheet))
      || ss.getSheets()[0];

    const allValues = sheet.getDataRange().getValues();
    const hIdx = allValues.findIndex(function(r) {
      return String(r[0]).trim().toUpperCase() === 'FECHA';
    });
    if (hIdx === -1) throw new Error('No se encontró la fila FECHA en la hoja ' + sheet.getName());

    const headers = allValues[hIdx].map(function(h) { return String(h).trim(); });

    const row = headers.map(function(h) {
      if (h === 'FECHA')                            return data.fecha || '';
      if (/^d[iíI][aá]$/i.test(h.trim()))          return data.dia || '';
      if (h === 'Local')                            return data.local || '';
      if (h === 'Ubicación' || h === 'Ubicacion')   return data.ubicacion || '';
      if (h === 'Supervisor')                       return data.supervisorName || '';
      if (data.productos && h in data.productos)    return data.productos[h];
      return '';
    });

    sheet.appendRow(row);
    return _ok();

  } catch (err) {
    return _ok({ ok: false, error: err.message });
  }
}
