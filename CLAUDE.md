# Arrivata Dashboard

Panel comercial de una sola página que monitorea la presencia de productos
Arrivata (lácteos gourmet) en góndola de supermercados argentinos.

## Arquitectura

- **`index.html`** — la app entera: HTML + CSS + JS vanilla, sin framework ni
  build. Librerías por CDN (Tailwind play-CDN, Chart.js 4, PapaParse, marked,
  DOMPurify, SheetJS). Se hostea en GitHub Pages.
- **`apps-script.js`** — Google Apps Script (un solo proyecto; el deployment
  `/exec` vigente es el que termina en `…ScQRFDXiF1w`, el que apunta
  `DEFAULT_SCRIPT_URL`). Es la API: lee/escribe el Google Sheet de cada
  supervisor por `spreadsheetId`, guarda notas / fotos / datos de local en
  Script Properties, sube fotos a Drive y hace de proxy a la API de Anthropic
  (la API key vive en Script Properties, nunca en el navegador).
- **`server.py`** — servidor local viejo (Sheet publicado como CSV + API key en
  el cliente). Desactualizado respecto al modelo actual; usar solo para servir
  `index.html` en local durante el desarrollo.
- Las visitas se leen **en vivo** por `?action=getVisitas` (CSV), no por
  "Publicar en la web".

## Modelo de acceso

Hay **dos credenciales distintas** y no hay que mezclarlas: el token de gate
habilita **leer**, el de supervisor habilita **escribir**.

- **Gate de la página**: contraseña compartida, guardada en la Script Property
  `GATE_PASSWORD` y validada por el backend (`action:'gateLogin'` por POST).
  Devuelve un **token opaco de solo-lectura** (TTL 6 h, el tope de
  `CacheService`) que el cliente guarda como `arr_gate_token` y manda en el
  parámetro `t` de cada lectura. Antes el gate se comparaba en el cliente y se
  salteaba poniendo `arr_auth` a mano en `sessionStorage`. Ese flag ya no
  existe: la única señal de acceso es un token que el backend acepte. (Sobre
  la contraseña de esa época, ver **Deuda técnica**.)
  - **Rotarla NO requiere redeploy**, pero **tampoco se puede desde el editor**:
    la pantalla "Propiedades del script" queda en SOLO LECTURA cuando el
    proyecto tiene muchas propiedades, y este tiene más de 50 (supervisores,
    notas, fotos, datos de local). Se rota por POST — ver
    **Rotar y resetear secretos** más abajo. Los tokens vivos siguen valiendo
    hasta vencer; para matarlos en el acto va `cerrarSesiones:true`, que sube
    `GATE_EPOCH`, el valor que llevan embebido todos los tokens.
  - **Falla cerrada**: sin `GATE_PASSWORD` configurada no entra nadie.
  - **Límite de intentos**: 20 en 15 min, **global** (el gate no tiene usuario y
    Apps Script no expone la IP). Es más alto que el del login de supervisor a
    propósito: con 5 globales, cualquiera que fallara 5 veces dejaría afuera a
    todos. Aun así sigue siendo un arma de bloqueo, por eso el contador cuelga
    de `GATE_EPOCH`: **`cerrarSesionesGate` destraba el bloqueo al instante**.
    Y se puede llamar aunque el gate esté bloqueado, porque va con token de
    supervisor, que usa el otro limitador (el de por-usuario). La defensa real
    es que la contraseña sea larga y aleatoria.
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
- **Contraseñas de supervisor hasheadas**: `passwordHash` + `passwordSalt` +
  `passwordIter` + `passwordAlgo` en el registro `supervisor|<user>`, con
  HMAC-SHA256 iterado (`_hashPassword`, `_PASS_ALGO = 'hmac-sha256-utf8-js'`,
  `_PASS_ITER = 30000`, ~250–280 ms medido en vivo). `_authSupervisor` sigue
  siendo el **único** lugar donde se compara una contraseña, y acepta todavía
  la rama vieja de texto plano: eso es lo que hace la **migración perezosa**
  (el primer login acertado reescribe el registro hasheado). Cada registro
  guarda su `passwordIter`, así que cambiar `_PASS_ITER` no invalida hashes
  viejos. `_contarHashesGuardados()` (correr a mano en el editor) dice cuántos
  migraron, solo con cantidades. Estado al 29/09/2026: 1 hasheado, 1 en plano.
  - **El SHA-256 está en JS puro, NO en `Utilities`**, por dos cosas medidas
    en el runtime real: cada llamada a `Utilities` cruza a Java y cuesta 1–5 ms
    (10.000 vueltas eran 10–40 s por login; en JS son ~0,0065 ms por vuelta),
    y **`computeHmacSha256Signature(string, string)` sin charset convierte
    todo carácter no ASCII en `?`**: "contraseña" y "contrase?a" daban el
    mismo hash. Con `Utilities.Charset.UTF_8` o con bytes coincide con la
    versión JS. **Toda llamada nueva a `Utilities` que reciba texto de usuario
    tiene que pasar `Charset.UTF_8`.** El mock de Node de las pruebas imita
    ese comportamiento a propósito: el mock viejo usaba UTF-8 y las pruebas
    pasaban con una suposición falsa.
- **Las LECTURAS piden token** (`_resolveReadAuth`), desde el 24/09/2026. Vale
  el token de gate o el de supervisor, y viaja en el querystring (parámetro
  `t`) y no en un header porque `doGet(e)` de Apps Script **no puede leer
  headers HTTP**: solo ve `e.parameter`.
  - ⚠ **Que las lecturas sean públicas era la decisión vieja, y se revirtió a
    propósito.** La intención original —que gerencia vea el panorama sin perfil
    de supervisor— **se mantiene**: gerencia entra con la contraseña del gate y
    lee con ese token. Lo que se cerró es que cualquiera con la URL del `/exec`
    se bajara las visitas de todos los supervisores sin credencial alguna.
    **Reabrir estas lecturas es una regresión, no una simplificación.** Si en
    una pasada futura parece que el token "sobra", no sobra: es lo único que
    separa el `/exec` de ser un volcado público de la base.
  - El flag de rechazo es **`gateExpired`**, NO `expired`. Son dos credenciales
    distintas: `expired` significa "se venció la sesión de supervisor" y el
    front reacciona limpiándola. Si una lectura vencida devolviera `expired`,
    un refresh de fondo le voltearía la sesión de escritura a alguien en medio
    de una carga.
  - `GATE_ENFORCE_READS` es la palanca: `'1'` rechaza lecturas sin token,
    ausente o `'0'` las permite. Sirvió para la transición y **queda como
    rollback instantáneo sin redeploy**. Un token presente pero inválido se
    rechaza siempre, con palanca o sin ella. **Estado al 29/09/2026: `'0'`**
    (el front con token recién se publicó). Pasa a `'1'` cuando el dueño
    confirme el front en producción; hasta entonces las lecturas siguen
    abiertas para cualquiera con la URL del `/exec`.
- **`getFotoData` también pide token**, pero **sigue validando** que el id
  figure en alguna propiedad `foto|…`. Las dos cosas hacen falta: el token del
  gate es un secreto compartido que tiene todo el que mira el panel, así que
  sin esa validación cualquiera de ellos podría enumerar archivos de Drive
  legibles por la cuenta dueña del script. Compara **ids**, no URLs, porque
  conviven dos formatos guardados (`…/exec?action=getFotoData&id=`, con ids de
  deployments viejos, y el viejo `drive.google.com/uc?export=view&id=`).
- **Las 4 herramientas manuales de admin van por POST con token**
  (`restyleSheet`, `clearVisitRows`, `removeFilter`, `getDebugLog`). Antes
  aceptaban usuario+contraseña en el querystring, así que la contraseña del
  admin quedaba en el historial del navegador y en los logs de Google. Las
  ramas GET siguen existiendo solo para responder "usá POST" a un favorito
  viejo. `clearVisitRows` además exige `confirmar:true` porque borra datos.
  Receta: sacar un token con `action:'login'` y después
  `curl -L -X POST -H 'Content-Type: text/plain' -d '{"action":"getDebugLog","token":"…"}' <exec>`.

## Rotar y resetear secretos

**La pantalla "Propiedades del script" del editor está en SOLO LECTURA** porque
el proyecto tiene más de 50 propiedades. No se pueden editar a mano ni
`GATE_PASSWORD`, ni `GATE_EPOCH`, ni los registros `supervisor|…`. Todo se hace
por POST con token de admin.

Por qué POST y no GET: la contraseña va en el **cuerpo**, cifrado por HTTPS.
En un querystring quedaría en el historial del navegador y en los logs de
Google — que es exactamente la deuda que se pagó con las herramientas de admin.
Y por qué no una función temporal en el editor: el código del proyecto se
versiona, así que una contraseña pegada ahí puede quedar en una versión vieja
para siempre. **La contraseña no va nunca al código, ni al repo, ni a una URL.**

Primero, el token de admin (dura 1 h):

```sh
EXEC='https://script.google.com/macros/s/…ScQRFDXiF1w/exec'
read -rs PASS_ADMIN                      # se tipea, no queda en el historial
TOKEN=$(curl -sL -X POST "$EXEC" -H 'Content-Type: text/plain' \
  --data-binary "{\"action\":\"login\",\"u\":\"artucastro\",\"p\":\"$PASS_ADMIN\"}" \
  | sed 's/.*"token":"\([^"]*\)".*/\1/')
```

| Qué | Cómo |
|---|---|
| **Rotar el gate** (mensual) | `{"action":"setGatePassword","token":"…","newPassword":"…"}` |
| **Rotar y echar a todos** (si se filtró) | lo mismo + `"cerrarSesiones":true` |
| **Destrabar el gate bloqueado** por intentos | `{"action":"cerrarSesionesGate","token":"…"}` |
| **Resetear a un supervisor** | `{"action":"setSupervisorPassword","token":"…","targetUsername":"gonza","newPassword":"…"}` |

Ejemplo completo de la rotación mensual:

```sh
read -rs NUEVA                           # la nueva, tipeada, nunca en un archivo
curl -sL -X POST "$EXEC" -H 'Content-Type: text/plain' \
  --data-binary "{\"action\":\"setGatePassword\",\"token\":\"$TOKEN\",\"newPassword\":\"$NUEVA\"}"
unset NUEVA PASS_ADMIN
```

Detalles que importan:

- **Mínimo 12 caracteres** para el gate, y se recomiendan 16+ aleatorios: al ser
  el límite de intentos global y por lo tanto flojo, la longitud es la defensa
  real.
- **Se rechazan los espacios y saltos de línea al principio o al final** en vez
  de recortarlos. Un `\n` pegado sin querer haría fallar todos los logins sin
  dar ninguna pista; recortarlo en silencio sería una sorpresa peor más
  adelante.
- **Si el gate queda bloqueado, seguís pudiendo entrar**: `cerrarSesionesGate`
  va con token de supervisor, que usa el limitador por-usuario, no el global
  del gate. Nunca te quedás afuera del todo.
- `setSupervisorPassword` guarda **ya hasheado**: el texto plano no toca Script
  Properties ni de forma transitoria, y preserva `spreadsheetId`, `sheetName`,
  `zona` e `isAdmin`.
- Las tres acciones exigen `isAdmin`; un supervisor común recibe
  `No autorizado`.

## Convenciones del front (`index.html`)

- **Sesión**: el reloj del cliente (`_verifiedAt`, `VERIFY_TTL_MS`) cuenta
  55 min FIJOS desde el login — no se renueva por actividad, igual que el
  token de 1 h del servidor. `_sesionVigente()` es el único chequeo;
  `abrirVerificacion()` pide login antes de abrir cualquier formulario de
  escritura (visita nueva, edición, datos del local, config, reportes).
- **Lecturas**: TODA lectura pasa por `apiGet(action, params, {as})`, espejo de
  `postAction()`: agrega el token de gate, detecta `gateExpired`, pide la
  contraseña y reintenta UNA vez. Ningún sitio arma URLs por su cuenta —
  antes cada lectura la concatenaba a mano y `fetchVisitasRows` duplicaba la
  lógica de `visitasUrl()`, que es exactamente cómo un sitio se queda sin
  token. **Criterio de aceptación: `grep -c 'fetch(' index.html` tiene que dar
  exactamente 1**, el de `_fetchExecUnaVez` (ver **Transporte y
  reintentos**). Cualquier otro es un sitio que se escapó del token y de los
  reintentos.
  - `getVisitas` responde CSV pero su error de auth sale como JSON. `apiGet`
    los distingue por el primer carácter: un CSV legítimo siempre arranca con
    la cabecera `FECHA` y nunca con `{`. El chequeo va en `apiGet`, **nunca**
    dentro de `processCSV`, para que el "No se encontró la fila de
    encabezados" siga significando lo que dice (un sheet roto).
  - El pedido de contraseña está deduplicado (`pedirGate`): `processCSV`
    dispara tres lecturas en paralelo y tienen que provocar UN solo modal.
  - **Si hay un formulario abierto, no se pide nada**: se marca
    `_gatePendiente`, se avisa con un toast y se pregunta al cerrarlo
    (`revisarGatePendiente`). El modal del gate es opaco y taparía una visita a
    medio cargar; el usuario pensaría que perdió el trabajo y recargaría — y
    ahí sí pierde las fotos, que no van al borrador.
  - **El re-login de supervisor tiene prioridad** sobre el del gate: detrás
    suyo hay datos sin guardar. `pedirGate()` cede si hay uno en curso.
- **Boot**: las lecturas de arranque viven en `arrancarApp()` y solo corren con
  token de gate. Antes estaban sueltas en el `DOMContentLoaded` y se disparaban
  siempre, incluso con la pantalla de login tapando todo. El `setInterval` de
  5 min tiene dos guardas: sin token no pide nada, y con un modal de gate
  abierto no encola otro (si no, al vencer reaparecería cada 5 min).
- **Escrituras**: toda acción que manda `token` pasa por `postAction()`. Si el
  backend responde `expired:true` (o el reloj local ya venció), abre el login
  por encima del formulario (`pedirRelogin()`, modal con z-index 120) y
  reintenta la misma escritura UNA sola vez con el token nuevo; si el usuario
  cancela, el formulario queda abierto con sus datos. Es seguro porque el
  backend valida el token antes de escribir. No llamar a `fetch` directo para
  escribir: todas las escrituras, incluida `crearSpreadsheetSupervisor`, pasan
  por ahí.
- **Transporte y reintentos** (`fetchExec`, `EXEC_POLITICAS`): toda respuesta
  de Apps Script viaja en dos saltos, el `/exec` (302) y el
  `script.googleusercontent.com/macros/echo` que entrega el resultado. **El
  echo falla solo**: 404 "No se encontró la página" o cuelgues de decenas de
  segundos. Medido el 29/09/2026 sobre 142 pedidos reales: 15–27 % de 404,
  **siempre en el echo, nunca en el `/exec`**, también de a un pedido y sin
  carga (no es el límite de concurrencia ni lo de varias cuentas `/u/N/`: los
  pedidos van sin cookies). Venía de antes de la v41. Es de la plataforma y
  **no tiene arreglo de backend**; se mitiga en el front.
  - `fetchExec()` es el único `fetch` de la app. **Falla de transporte** = 404,
    5xx, error de red, timeout (`AbortController`, 40 s) o HTML donde se
    esperaba JSON/CSV. Una respuesta del script, **aunque sea `ok:false`, nunca
    se reintenta** (repetir una contraseña mala solo gasta intentos).
  - Política por acción:

    | Acción | Reintentos ante transporte | Si se agotan |
    |---|---|---|
    | Todas las lecturas | 2 (a 1 s y 3 s), con "Reintentando…" | error visible; la 2.ª tanda avisa con un toast |
    | `saveVisita` | 1 (el backend dedupea por `clientId` y al duplicado le responde `ok:true`) | "Tocá Reintentar: si ya se había guardado, no se duplica" |
    | `saveLocalData` | 1 (pisa el registro) | "No pudimos confirmar…" y relee |
    | `login`, `gateLogin` | 1, solo por transporte | error de conexión |
    | `saveNota`, `updateVisita`, admin | 0 | "No pudimos confirmar si se guardó. Revisá antes de volver a intentarlo." |
    | `savePhoto` | 0, timeout 3 min | ídem, y relee las fotos |
    | `callClaude` | 0 acá (`callAnthropic` tiene su bucle), timeout 6 min | error del informe |

  - **Por qué las escrituras casi no reintentan**: el 404 del echo puede llegar
    **después** de que el script escribió. Reintentar a ciegas `savePhoto`
    duplica archivos en Drive. Y `updateVisita`, si cambió local o fecha, en el
    segundo intento ya no encuentra la fila y respondería error aunque se haya
    guardado.
  - **Por qué `callClaude` y `savePhoto` tienen timeout propio**: un informe de
    hasta 12.000 tokens o una subida de fotos desde el celular pasan de 40 s
    aun saliendo bien; con el timeout general fallarían siempre.
  - **Rebote del echo en un POST**: cuando el echo no tiene listo el
    resultado, redirige a la URL original. En un POST esa URL es el `/exec`
    sin parámetros; el navegador la sigue por GET y `doGet` sin `action`
    responde **`OK` en texto plano** (200, `text/plain`), sin error en el
    panel de Ejecuciones y con el resultado del POST perdido aunque se haya
    ejecutado. Así falló el `gateLogin` correcto el 30/09/2026 ("respuesta
    ilegible"). Por eso `_fetchExecUnaVez` trata como transporte el `OK`
    pelado, el cuerpo vacío y el JSON ilegible. Pasa en ~1 de cada 20 POST.
  - **`callClaude` no reintenta ante transporte, en ningún nivel**: ni
    `fetchExec` (política `ia`) ni el bucle de `callAnthropic`, y la etapa 1
    de los informes no cae a su informe alternativo. Cada POST es una llamada
    paga a Anthropic que suele haberse hecho igual. Sí reintentan los errores
    de la API que no son permanentes y la respuesta 200 sin texto.
  - Scripts de medición en **`tools/`** (solo metadatos, nunca datos; la
    salida `tools/*.jsonl` está en `.gitignore`): `medir-exec.js` sigue la
    cadena de redirects salto por salto, `resumir.js` saca los porcentajes y
    latencias, y `probar-post.js` manda POST inofensivos para cazar el rebote.
    Instrucciones de uso en el encabezado de cada uno.
- **Borrador de visita nueva**: `localStorage`, clave
  `arr_visita_draft|<username>`, autoguardado con debounce de 500 ms. Guarda
  texto, SI/NO, cantidades y el `clientId` del intento (para que el backend
  dedupe si aquel guardado había llegado); NUNCA fotos. No aplica a la
  edición. Se borra solo tras guardado confirmado o descarte explícito.
- **Fechas**: el día calendario de hoy sale SIEMPRE de `hoyAR()` (zona
  America/Argentina/Buenos_Aires; acepta offset en días). No usar
  `new Date().toISOString().slice(0,10)`: da el día en UTC y después de las
  21:00 de Argentina ya es mañana.
- **Catálogo de productos**: NO hay lista fija. `detectBrands()` lo deduce de
  los encabezados del sheet por sufijo (` AR`, ` FES`, ` WA`, ` CUI`,
  ` CARRE`); lo único hardcodeado son las 5 marcas. Para dar de alta un
  producto alcanza con agregar la columna al sheet — el formulario, los
  gráficos, los faltantes, el Excel, el PDF y los informes lo toman solos.
- **Alta de un producto nuevo** (`PRODUCTO_ALTA`): una columna nueva llega con
  TODO el histórico vacío, así que sin marcar desde cuándo existe cuenta como
  faltante en cada visita anterior y ningún local puede volver a estar
  "Completo" (medido al agregar la Burratina sobre las 828 visitas reales:
  13 locales "Completo" → 0, la única alerta de quiebre se apagaba y la
  variedad promedio caía de 77% a 71%). El mapa `PRODUCTO_ALTA`
  (encabezado exacto → fecha `dd/MM/yyyy`) más `productoAplica()` /
  `arrColsDeVisita()` resuelven eso, y se aplican en los seis lugares donde el
  total de productos es denominador o se listan faltantes: `getStatusForRow`
  (alertas y agenda), `calcFaltantesPorProducto`, `calcLocalScore`,
  `getPortfolioStatus`, el gráfico "Variedad por Local" y `getRichStats`. Los
  que filtran por "tiene datos" (`productStats`, el gráfico de producto, la
  tabla del detalle) no lo necesitan. Si la celda ya tiene un dato, el producto
  cuenta igual aunque la visita sea anterior al alta.
  **Estado en producción**: la Burratina (`Burratina AR`, alta 21/09/2026) está
  viva desde el 23/09/2026 en la columna Q de las dos hojas (artucastro —que es
  además la plantilla— y Gonza), con el histórico vacío. Verificado contra el
  `/exec` real sobre 834 visitas: aparece última en Arrivata en Cargar Visita,
  no cuenta como faltante en las 828 visitas previas al alta (denominador 12
  antes del 21/09, 13 desde), siguen los 13 locales "Completo" y la única
  alerta de quiebre, y ninguna columna de FES/WA/CUI/CARRE se corrió.
  **Procedimiento para el próximo producto**: 1) agregar la línea a
  `PRODUCTO_ALTA`, 2) pushear el front, 3) recién después agregar la columna a
  cada sheet de supervisor Y a la plantilla. Ese orden importa: con la columna
  puesta antes del push, gerencia ve las métricas rotas hasta que recargue.
  El encabezado del sheet y la clave del mapa tienen que coincidir carácter por
  carácter; si no, salta un `console.warn` al cargar los datos.
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
- **Plantilla de columnas**: `createSupervisorSheet` clona la PRIMERA PESTAÑA
  del spreadsheet al que está bindeado el proyecto (el de artucastro), no una
  lista en el código. Una columna de producto nueva hay que agregarla también
  ahí, o los supervisores que se creen después arrancan sin ella.
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

- **Higiene de implementaciones: dejar SOLO la vigente.** Cada implementación
  de Apps Script queda fijada a una versión del código y sigue sirviéndola para
  siempre. O sea que una implementación vieja **ignora cualquier cambio de
  seguridad que hagamos después**: no tiene `_resolveReadAuth`, así que
  `GATE_ENFORCE_READS` no la afecta y sigue entregando todo sin credencial.
  El 24/09/2026 había **39 implementaciones activas y 35 servían las 859
  visitas, las notas y los datos de local a cualquiera con la URL**. Se
  borraron 37; quedan dos, verificadas con curl:
  - `…xt8ScQRFDXiF1w` (v41 desde el 29/09/2026) — la vigente, la que apunta
    `DEFAULT_SCRIPT_URL`. Se actualiza con **Gestionar implementaciones →
    lápiz → Nueva versión**, nunca con "Nueva implementación" (daría otra URL).
  - `…RrteQQJmplTXFI` (HEAD) — pide login de Google, no expone nada, y sirve
    siempre el código más nuevo. Útil para probar.
  **Después de cada redeploy hay que revisar que no queden sobrantes**:
  `clasp list-deployments <scriptId>` tiene que devolver esas dos y nada más.
  Ojo con `clasp undeploy --all`: se lleva puesta también la vigente.
- **Exposición histórica conocida (no investigada).** Diez URLs de `/exec`
  viejas estuvieron en el historial del repo **público** entre el 26/05/2026 y
  el 24/09/2026, y las diez seguían activas y abiertas hasta que se borraron.
  Cualquiera que haya mirado el historial de `index.html` en esos cuatro meses
  tuvo acceso completo a las visitas, notas y datos de local sin credencial
  alguna. No se pudo verificar si hubo accesos: Apps Script no registra la IP
  del que llama, el historial de ejecuciones no dice por qué implementación
  entró el pedido, y leerlo requiere el scope `script.processes`, que clasp no
  pide por defecto. Dicho de otro modo: **no es que no haya pasado, es que no
  se puede saber.** Por eso las lecturas se cerraron.
- **La contraseña del gate de antes del 24/09/2026 está quemada**: vivía en el
  código del cliente y quedó en el historial **público** del repo. **Se rotó el
  29/09/2026.** El historial no se reescribió (ya estuvo expuesto, y reescribir
  un repo público no lo des-expone): la regla es que esa contraseña no vuelve
  a usarse nunca. Ninguna contraseña, vieja o nueva, se escribe en este
  archivo ni en el repo.
- `verificarYProceder` todavía tiene un "modo sin Apps Script" que acepta un
  login local fijo. Es inerte (solo corre sin `scriptUrl`, que se fuerza
  siempre a `DEFAULT_SCRIPT_URL`, y sin backend no hay lecturas ni escrituras
  reales), pero es código muerto con forma de contraseña: borrarlo.
- El gate sigue siendo **una sola contraseña compartida**, sin usuarios ni
  trazabilidad: no se sabe quién miró qué, y si se filtra hay que rotarla para
  todos. Es una decisión de producto consciente (gerencia no quiere gestionar
  usuarios). Mitigación: rotarla una vez por mes con `setGatePassword` (ver
  **Rotar y resetear secretos**), sin redeploy ni tocar código.
- El hash de contraseñas de supervisor **no equivale a bcrypt**. Apps Script no
  tiene bcrypt/scrypt/argon2, así que es HMAC-SHA256 iterado, muy por debajo de
  la recomendación actual de OWASP para PBKDF2 (inalcanzable acá: serían más de
  10 s por login). Compra que no haya texto plano guardado y que el salt mate
  las rainbow tables; **no** protege contra alguien que ya pueda leer Script
  Properties, porque esa misma persona lee `GATE_PASSWORD` y la
  `ANTHROPIC_API_KEY`, y puede crearse un admin con un hash calculado por ella.
- **Reset de un supervisor que olvidó la contraseña**: acción
  `setSupervisorPassword` (ver **Rotar y resetear secretos**). El
  procedimiento viejo —editar la property a mano y poner `password` en texto
  plano— **ya no sirve**: la pantalla de propiedades está en solo lectura.
  `_passwordCorrecta` igual mantiene la rama de texto plano, porque es lo que
  hace posible la migración perezosa de los registros viejos; si alguien la
  "limpia" por prolijidad, rompe esa migración.
- Los tokens de gate viven en `CacheService`, que **desaloja entradas antes de
  tiempo y no sobrevive a reinicios del script**. O sea que el pedido de
  contraseña puede aparecer en momentos arbitrarios, no solo a las 6 h. Es
  tolerable porque el re-login no destruye nada (ver `pedirGate`), pero no hay
  que leerlo como un bug cuando pase.
- `index.html` es un monolito de ~5.000 líneas sin tests ni build; Tailwind
  play-CDN en producción; varias dependencias de CDN (solo DOMPurify lleva
  versión fija + SRI).
- **Latencia y fallas del `/exec`** (ver **Transporte y reintentos**): p50 de
  3 a 10 s y p95 de 20 a 80 s en pedidos triviales, más el 404 del echo. Los
  reintentos lo mitigan pero no lo arreglan: con 2 reintentos, una lectura
  sigue fallando en ~1–2 % de los casos, y cada reintento suma espera. Si el
  auto-sync de 5 min falla del todo, `showError` reemplaza el dashboard ya
  cargado por el mensaje de error. Etapa 4: sacar las lecturas de Apps Script
  y aligerar `saveVisita` (lee la hoja entera para escribir una fila) y
  `savePhoto` (todas las fotos en un solo POST, bajo el lock global).
- La segunda tanda de lecturas (`getNotas`, `getFotos`, `getLocalData`) ya no
  falla en silencio: reintenta y, si se agota, avisa con un toast no
  bloqueante. Los indicadores de nota/foto pueden faltar igual hasta el
  próximo auto-refresh de 5 min.
- Notas, fotos y datos de local se guardan con clave global (`nota|<local>|...`,
  `localdata|<local>`), no por supervisor: una zona puede pisar datos de otra.
  Ya pasa en la práctica: "Coto Cabildo" existe en los sheets de dos
  supervisores distintos.
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
