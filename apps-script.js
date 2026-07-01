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

// ── GET: leer notas o datos de local ─────────────────────────
function doGet(e) {
  if (e.parameter.action === 'getNotas') {
    const all = PropertiesService.getScriptProperties().getProperties();
    const notas = {};
    Object.keys(all).forEach(k => {
      if (k.startsWith('nota|')) notas[k.slice(5)] = all[k];
    });
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, notas }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'getFotos') {
    const local = e.parameter.local || '';
    const prefix = 'foto|' + local + '|';
    const all = PropertiesService.getScriptProperties().getProperties();
    const fotos = {};
    Object.keys(all).forEach(k => {
      if (k.startsWith(prefix)) {
        const fecha = k.slice(prefix.length);
        try { fotos[fecha] = JSON.parse(all[k]); } catch(_) {}
      }
    });
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, fotos }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'getLocalData') {
    const all = PropertiesService.getScriptProperties().getProperties();
    const localData = {};
    Object.keys(all).forEach(k => {
      if (k.startsWith('localdata|')) {
        try { localData[k.slice(10)] = JSON.parse(all[k]); } catch(_) {}
      }
    });
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, localData }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

// ── POST: guardar visita o nota ───────────────────────────────
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ── Guardar fotos en Drive ───────────────────────────────
    if (data.action === 'savePhoto') {
      const local = data.local || '';
      const fecha = data.fecha || '';
      const b64List = data.fotos || [];
      const urls = b64List.map(function(b64, i) {
        const clean = b64.replace(/^data:image\/\w+;base64,/, '');
        const bytes = Utilities.base64Decode(clean);
        const blob = Utilities.newBlob(bytes, 'image/jpeg',
          'gondola_' + local + '_' + fecha.replace(/\//g,'-') + '_' + i + '.jpg');
        const file = DriveApp.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return 'https://drive.google.com/uc?export=view&id=' + file.getId();
      });
      const key = 'foto|' + local + '|' + fecha;
      var existing = [];
      try { existing = JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || '[]'); } catch(_) {}
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(existing.concat(urls)));
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Guardar datos del local ──────────────────────────────
    if (data.action === 'saveLocalData') {
      const key = 'localdata|' + data.local;
      PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(data.datos || {}));
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Guardar nota ─────────────────────────────────────────
    if (data.action === 'saveNota') {
      const key = 'nota|' + data.local + '|' + data.fecha;
      if (data.texto && data.texto.trim()) {
        PropertiesService.getScriptProperties().setProperty(key, data.texto.trim());
      } else {
        PropertiesService.getScriptProperties().deleteProperty(key);
      }
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── Guardar visita (comportamiento original) ──────────────
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];

    const allValues = sheet.getDataRange().getValues();
    const hIdx = allValues.findIndex(r => String(r[0]).trim().toUpperCase() === 'FECHA');
    if (hIdx === -1) throw new Error('No se encontró la fila de encabezados (FECHA)');

    const headers = allValues[hIdx].map(h => String(h).trim());

    const row = headers.map(h => {
      if (h === 'FECHA')                            return data.fecha || '';
      if (/^d[iíI][aá]$/i.test(h.trim()))          return data.dia || '';
      if (h === 'Local')                            return data.local || '';
      if (h === 'Ubicación' || h === 'Ubicacion')   return data.ubicacion || '';
      if (data.productos && h in data.productos)    return data.productos[h];
      return '';
    });

    sheet.appendRow(row);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
