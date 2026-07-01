// ─────────────────────────────────────────────────────────────
// INSTRUCCIONES PARA CONFIGURAR:
// 1. Abrí el Google Spreadsheet
// 2. Menú: Extensiones → Apps Script
// 3. Borrá el código que haya y pegá TODO este archivo
// 4. Clic en "Guardar"
// 5. Clic en "Implementar" → "Nueva implementación"
//    - Tipo: Aplicación web
//    - Ejecutar como: Yo (tu cuenta de Google)
//    - Quién tiene acceso: Cualquier usuario
// 6. Clic en "Implementar" → copiá la URL que aparece
// 7. Pegá esa URL en el dashboard: Configurar → URL Google Apps Script
// ─────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheets()[0];

    // Encontrar fila de encabezados (la que empieza con FECHA)
    const allValues = sheet.getDataRange().getValues();
    const hIdx = allValues.findIndex(r => String(r[0]).trim().toUpperCase() === 'FECHA');
    if (hIdx === -1) throw new Error('No se encontró la fila de encabezados (FECHA)');

    const headers = allValues[hIdx].map(h => String(h).trim());

    // Construir la fila nueva alineada con los encabezados
    const row = headers.map(h => {
      if (h === 'FECHA')                           return data.fecha || '';
      if (h === 'Dia' || h === 'Día' || h === 'DIA') return data.dia || '';
      if (h === 'Local')                           return data.local || '';
      if (h === 'Ubicación' || h === 'Ubicacion') return data.ubicacion || '';
      if (data.productos && h in data.productos)   return data.productos[h];
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

// Test rápido: ejecutá esta función manualmente para verificar que funciona
function testDoPost() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        fecha: '29/06/2026',
        local: 'TEST LOCAL',
        ubicacion: 'Dirección Test 123',
        productos: {}
      })
    }
  };
  const result = doPost(fakeEvent);
  Logger.log(result.getContent());
}
