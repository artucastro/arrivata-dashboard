# Arrivata Dashboard

Panel comercial de una sola página que monitorea la presencia de productos
Arrivata (lácteos gourmet) en góndola de supermercados argentinos.

## Arquitectura

- **`index.html`** — la app entera: HTML + CSS + JS vanilla, sin framework ni
  build. Librerías por CDN (Tailwind play-CDN, Chart.js 4, PapaParse, marked,
  DOMPurify, SheetJS). Se hostea en GitHub Pages.
- **`apps-script.js`** — Google Apps Script (un solo proyecto, un solo
  deployment `/exec`). Es la API: lee/escribe el Google Sheet de cada
  supervisor por `spreadsheetId`, guarda notas / fotos / datos de local en
  Script Properties, sube fotos a Drive y hace de proxy a la API de Anthropic
  (la API key vive en Script Properties, nunca en el navegador).
- **`server.py`** — servidor local viejo (Sheet publicado como CSV + API key en
  el cliente). Desactualizado respecto al modelo actual; usar solo para servir
  `index.html` en local durante el desarrollo.
- Las visitas se leen **en vivo** por `?action=getVisitas` (CSV), no por
  "Publicar en la web".

## Modelo de acceso

- **Gate de la página**: contraseña compartida `Arrivata123` (`arr_auth` en
  `sessionStorage`). Da acceso de solo-lectura al panorama global.
- **Identidad de supervisor**: login `username` + `password` por `doPost`
  (`action:'login'`), nunca por GET. El backend devuelve un **token de sesión
  opaco** (TTL 1 h, en `CacheService`) que el cliente guarda como
  `arr_verified_token` y reenvía en cada escritura (`_authFields` → campo
  `token`). La contraseña real nunca se persiste ni se reenvía.
- **Las escrituras aceptan SOLO token** (`_resolveToken`). Sin token, o con uno
  vencido, responden `expired:true`, que es la señal que usa el front para
  pedir login y reintentar la escritura sola. No hay forma de escribir mandando
  usuario+contraseña: esa rama existía por compatibilidad y permitía probar
  contraseñas contra cualquier escritura (ej. `saveNota`) salteando el límite
  de intentos.
- **Límite de intentos**: 5 fallos por usuario (normalizado a trim +
  minúsculas) en 15 min, contados en `CacheService` dentro de
  `_authSupervisor`, que es el único lugar donde se compara una contraseña —
  así cubre todos los caminos, no solo `action:'login'`. Cuenta también los
  usuarios inexistentes (si no, el bloqueo delataría cuáles existen) y el
  mensaje de error es siempre el mismo. Limitación aceptada: al ser por
  usuario, alguien puede bloquear a un supervisor a propósito por 15 min;
  Apps Script no expone la IP, así que no hay con qué acotarlo mejor.
- **`getFotoData` es público a propósito** (gerencia ve las fotos sin login),
  pero solo sirve archivos cuyo id figure en alguna propiedad `foto|…`: antes
  devolvía cualquier archivo de Drive legible por la cuenta dueña del script.
  Compara **ids**, no URLs, porque conviven dos formatos guardados
  (`…/exec?action=getFotoData&id=`, con ids de deployments viejos, y el viejo
  `drive.google.com/uc?export=view&id=`).
- Las **lecturas** (`getVisitas`, `getNotas`, `getFotos`, `getLocalData`,
  `getSupervisors`) son públicas a propósito: gerencia necesita ver el
  panorama global sin perfil de supervisor.

## Convenciones del front (`index.html`)

- **Sesión**: el reloj del cliente (`_verifiedAt`, `VERIFY_TTL_MS`) cuenta
  55 min FIJOS desde el login — no se renueva por actividad, igual que el
  token de 1 h del servidor. `_sesionVigente()` es el único chequeo;
  `abrirVerificacion()` pide login antes de abrir cualquier formulario de
  escritura (visita nueva, edición, datos del local, config, reportes).
- **Escrituras**: toda acción que manda `token` pasa por `postAction()`. Si el
  backend responde `expired:true` (o el reloj local ya venció), abre el login
  por encima del formulario (`pedirRelogin()`, modal con z-index 120) y
  reintenta la misma escritura UNA sola vez con el token nuevo; si el usuario
  cancela, el formulario queda abierto con sus datos. Es seguro porque el
  backend valida el token antes de escribir. No llamar a `fetch` directo para
  escribir: todas las escrituras, incluida `crearSpreadsheetSupervisor`, pasan
  por ahí.
- **Borrador de visita nueva**: `localStorage`, clave
  `arr_visita_draft|<username>`, autoguardado con debounce de 500 ms. Guarda
  texto, SI/NO, cantidades y el `clientId` del intento (para que el backend
  dedupe si aquel guardado había llegado); NUNCA fotos. No aplica a la
  edición. Se borra solo tras guardado confirmado o descarte explícito.
- **Fechas**: el día calendario de hoy sale SIEMPRE de `hoyAR()` (zona
  America/Argentina/Buenos_Aires; acepta offset en días). No usar
  `new Date().toISOString().slice(0,10)`: da el día en UTC y después de las
  21:00 de Argentina ya es mañana.
- **HTML dinámico**: todo dato externo (sheet, Script Properties, input de
  usuario, respuesta de la IA) se escapa antes de ir a `innerHTML`: `esc()`
  para texto y atributos (escapa `& < > " '`), `escJs()` para strings dentro
  de handlers inline (`onclick="fn('...')"`). El markdown de los reportes pasa
  por `renderMarkdownSafe()` (marked + DOMPurify, sin imágenes/medios); si
  DOMPurify no cargó se muestra texto plano escapado.

## Convenciones del backend (`apps-script.js`)

- **Locks**: `_conLock()` envuelve las escrituras leer-modificar-escribir
  (`updateVisita`, `savePhoto`). Si no consigue el lock en 20 s devuelve
  `{ok:false, error:'Sistema ocupado, probá de nuevo', busy:true}` **sin haber
  escrito nada**. `saveVisita` es la excepción deliberada: ante un lock vencido
  sigue igual, porque perder una visita recién cargada a mano es peor que el
  riesgo de duplicarla.
- **Dedupe de `saveVisita`**: por `clientId` en `CacheService`. Límites a tener
  en cuenta: dura 6 h (el máximo de `CacheService`), las entradas se pueden
  desalojar antes, y si el lock vence el dedupe se saltea. O sea que un
  borrador recuperado al día siguiente y reenviado **sí** puede duplicar la
  fila. El arreglo de fondo es un id único por visita en una columna del Sheet.
- **`updateVisita` no reconstruye la fila**: `_mergeVisitaRow` parte de los
  valores actuales y solo pisa las celdas que el payload trae y el encabezado
  reconoce, así una columna agregada a mano al Sheet no se blanquea al editar.
- **Fotos al editar**: si la edición cambia local o fecha, `_migrarFotos` mueve
  las propiedades `foto|…` dentro del mismo lock, fusionando si la clave nueva
  ya tenía fotos y escribiendo la nueva **antes** de borrar la vieja. La nota
  la migra el front; `localdata|` no se migra (ver deuda técnica).

## Reglas de trabajo

1. Verificá contra la realidad (curl al `/exec` real), no teorices.
2. Probá local antes de tocar GitHub. Cambios no triviales: correr local, que
   el dueño confirme, y recién ahí commitear/pushear.
3. Minimizá los redeploys del Apps Script: agrupá cambios de backend,
   verificá con curl y recién ahí pedí el redeploy.
4. Un commit = un cambio. No mezcles trabajo en progreso con fixes.
5. El front y el `apps-script.js` comparten el shape de cada acción. Si cambia
   uno, cambia el otro, coordinado.
6. Cuidá el mobile: la mayoría de las cargas de visita son desde el celular.

## Deuda técnica conocida

- El gate de acceso al dashboard (contraseña compartida "Arrivata123") sigue
  siendo una clave única hardcodeada en el HTML público, visible para
  cualquiera que inspeccione el código fuente. Es una decisión de producto
  consciente: gerencia necesita ver el panorama completo sin perfil de
  supervisor. Mitigación acordada: rotar esta contraseña cada 1 mes (pauta
  operativa, no automatizada por ahora).
- Las contraseñas de supervisor se guardan en Script Properties en texto plano
  y se comparan con `===`. Fix pendiente aparte (hashear con salt del lado del
  Apps Script).
- Las lecturas de datos del Apps Script no piden token: cualquiera con la URL
  del `/exec` puede bajar todas las visitas de todos los supervisores.
- `index.html` es un monolito de ~4.900 líneas sin tests ni build; Tailwind
  play-CDN en producción; varias dependencias de CDN (solo DOMPurify lleva
  versión fija + SRI).
- Las lecturas paralelas al arrancar (`getNotas`, `getFotos`, `getLocalData`)
  fallan en silencio de forma intermitente contra el Apps Script real (se
  tragan con `.catch(()=>{})`): los indicadores de nota/foto pueden faltar
  hasta el próximo auto-refresh de 5 min.
- Notas, fotos y datos de local se guardan con clave global (`nota|<local>|...`,
  `localdata|<local>`), no por supervisor: una zona puede pisar datos de otra.
  Ya pasa en la práctica: "Coto Cabildo" existe en los sheets de dos
  supervisores distintos.
- Las cuatro herramientas manuales por GET (`restyleSheet`, `clearVisitRows`,
  `removeFilter`, `getDebugLog`) siguen aceptando usuario+contraseña en la URL,
  así que la contraseña del admin queda en el historial del navegador y en los
  logs de Google. `clearVisitRows` además borra datos. Pasarlas a POST con
  token queda pendiente. Mientras tanto las cubre el límite de intentos.
- Al editar una visita cambiando el nombre del local, `localdata|<local>` queda
  huérfano: no se migra porque la clave es global y sin fecha, así que moverla
  puede robarle los datos a otra visita del mismo local. Va junto con los ids
  únicos por visita.
- `updateVisita` ubica la fila por local + fecha y toma la primera
  coincidencia: si hay dos visitas del mismo local el mismo día (ya pasó con
  "Jumbo Palermo" el 27/08) siempre edita la primera.
- `CacheService` (donde viven los tokens de sesión) no es persistente entre
  reinicios del script y tiene límite de tamaño por entrada. Con TTL de 1 h no
  es un problema práctico; para sesiones más largas habría que pasar a
  `PropertiesService` con limpieza manual.
