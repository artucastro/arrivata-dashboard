# Arrivata — Dashboard de Presencia Comercial

Panel de control para monitorear la presencia de Arrivata en locales, con gráficos por marca y zona, tabla filtrable y generación de reportes automáticos con IA.

---

## Requisitos

- **Python 3.7+** (ya viene instalado en la mayoría de las computadoras)
- Un **Google Sheet publicado como CSV**
- Una **API key de Anthropic** (solo para generar reportes — opcional)

---

## Paso 1 — Preparar el Google Sheet

Tu planilla debe tener columnas similares a estas (el dashboard las detecta automáticamente):

| Fecha | Local | Marca | Zona | Dirección | Con Arrivata | Notas |
|-------|-------|-------|------|-----------|--------------|-------|
| 2024-05-20 | Farmacity Palermo | Nike | CABA Norte | Av. Santa Fe 1234 | Sí | OK |

**Columna "Con Arrivata"**: puede ser `Sí`, `Si`, `Yes`, `1`, `Presente`, `Activo` o `X` para positivo. Cualquier otro valor se toma como ausente.

### Cómo publicar el sheet como CSV

1. Abrí tu Google Sheet
2. **Archivo → Compartir → Publicar en la web**
3. Elegí **"Toda la hoja"** y formato **"Valores separados por comas (.csv)"**
4. Hacé clic en **Publicar** y copiá la URL generada

La URL tiene este formato:
```
https://docs.google.com/spreadsheets/d/XXXXXXXXX/pub?output=csv
```

---

## Paso 2 — Iniciar el servidor

Abrí una terminal (PowerShell o CMD) en la carpeta del proyecto y ejecutá:

```bash
python server.py
```

Deberías ver:
```
  ╔══════════════════════════════════════╗
  ║   Arrivata Dashboard — Servidor OK   ║
  ║   http://localhost:8080              ║
  ╚══════════════════════════════════════╝
```

Luego abrí tu navegador en: **http://localhost:8080**

> ⚠️ No abras `index.html` directamente desde el explorador de archivos — los reportes con IA no van a funcionar sin el servidor.

---

## Paso 3 — Configurar el dashboard

Al abrir por primera vez aparece el panel de configuración:

1. **URL de Google Sheets CSV**: pegá la URL del paso 1
2. **API Key de Anthropic**: ingresá tu key de [console.anthropic.com](https://console.anthropic.com) *(solo necesaria para reportes)*
3. Clic en **Guardar y cargar datos**

La configuración se guarda automáticamente en el navegador — no hace falta repetirla cada vez.

---

## Funcionalidades

### Estadísticas en tiempo real
- Total de locales auditados
- Cantidad y porcentaje con Arrivata presente
- Cobertura general
- Total de marcas y zonas

### Gráficos
- **Presencia por Marca**: porcentaje de cobertura por cada marca (colores según nivel: verde ≥70%, amarillo ≥40%, rojo <40%)
- **Presencia por Zona**: cobertura por zona geográfica

### Tabla de locales
- Búsqueda por texto libre
- Filtros por marca, zona y estado de Arrivata
- Ordenamiento por columna
- Paginación (25 registros por página)

### Reportes con IA (requiere API key de Anthropic)
- **Reporte Semanal**: analiza los últimos 7 días
- **Reporte Mensual**: analiza los últimos 30 días
- Incluye resumen ejecutivo, métricas, highlights y recomendaciones estratégicas
- Se puede copiar al portapapeles con un clic

---

## Actualización de datos

Los datos se sincronizan desde Google Sheets al hacer clic en **Actualizar** (navbar superior derecha). No hay actualización automática — actualizá cuando quieras ver los últimos cambios del sheet.

---

## Solución de problemas

| Problema | Solución |
|----------|----------|
| No carga datos | Verificá que el sheet está **publicado** como CSV (no solo compartido con un link) |
| Error CORS en reportes | Usá `python server.py` y accedé por `http://localhost:8080`, no abriendo el archivo directamente |
| API key inválida | La key debe comenzar con `sk-ant-`. Conseguila en [console.anthropic.com](https://console.anthropic.com) |
| Columnas no detectadas | En Configurar → Mapeo de columnas, ingresá los nombres exactos de tus columnas |
| Puerto 8080 ocupado | Ejecutá `PORT=8081 python server.py` y accedé por `http://localhost:8081` |

---

## Estructura del proyecto

```
arrivata-dashboard/
├── index.html    ← Dashboard completo (HTML + JS + CSS)
├── server.py     ← Servidor local + proxy para API de Anthropic
└── README.md     ← Este archivo
```
