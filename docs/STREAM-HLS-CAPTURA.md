# MC Player universal y captura HLS con Referer

**Estado:** implementado en MC Browser desktop. Esta guía documenta el flujo actual y sirve como referencia para una futura integración en MC-TV; no implica que esa integración ya esté aprobada ni que las arquitecturas sean intercambiables.

## Objetivo

MC Player se plantea como una carcasa universal para probar fuentes y contenedores con el contexto de Referer que requieren. Sus comportamientos se ampliarán de forma incremental según el tipo de fuente o proveedor: hoy incluye playlist HLS directa y contenedor/player web embebido. StreamHunt conserva su escaneo y descarga existentes; la captura de red es una función separada.

El objetivo de aislamiento actual es **visual/funcional**: presentar dentro de la carcasa solo el player o contenedor elegido, ocultando el resto de la página original. No equivale a aislar el proceso, la sesión, las cookies o el almacenamiento del webview.

La interfaz vive en el panel lateral **Stream Hunt > Streams**. Tiene dos caminos:

- **Captura de red:** se activa explícitamente y escucha nuevas solicitudes `.m3u8`; cada resultado muestra URL, página de origen y `Referer` si el navegador lo envió.
- **Prueba manual:** permite introducir una URL `.m3u8` o una página/player HTTP(S), junto con un `Referer`. Una playlist abre con HLS.js dentro de MC Player; una página contenedora se carga en un iframe dentro de la misma carcasa con su `Referer` de entrada, incluso si la política global de Referer lo eliminaría. Esta ruta no asume que el contenedor exponga una URL `.m3u8` ni intenta resolverla automáticamente. Los valores iniciales corresponden a la señal en vivo de SNT.

Para ocultar la página del canal y probar solo un player embebido, usar la URL directa del player (por ejemplo `geo.dailymotion.com/player/...`) y el Referer del sitio padre (por ejemplo `https://www.abc.com.py/tv/`). Si se introduce la URL de la página padre, se mostrará esa página completa dentro del iframe; MC Player no busca ni extrae automáticamente un iframe desde otro sitio.

## Flujo actual

1. `main.js` mantiene el interruptor de captura. Al estar activo, el `onBeforeSendHeaders` de la sesión principal inspecciona solicitudes HTTP(S) `.m3u8`, toma `Referer` de los headers (con `d.referrer` como respaldo) y emite `streams:hls-captured` con URL, origen, `webContentsId` y hora.
2. `preload.js` autoriza el evento y expone `mc.setHlsCapture()` / `mc.setHlsPlayerReferer()` al renderer anfitrión. `preload/selection-bridge.js` expone al MC Player la operación acotada `setHlsEntryReferer(token, url, referer)`.
3. `src/renderer.html` filtra resultados para la pestaña activa, elimina duplicados, presenta la lista y permite copiar URL/Referer o abrir la fuente en MC Player. La entrada manual enruta `.m3u8` a HLS.js; una página HTTP(S) se carga en un iframe dentro del escenario, solo después de registrar su Referer contra el token y webContents del MC Player.
4. MC Player se genera como una página `data:` dentro de una pestaña normal y usa HLS.js. Antes de `loadSource()`, el player solicita al preload `preload/selection-bridge.js` actualizar el Referer asociado a su token.
5. El handler IPC de `main.js` acepta la actualización desde el renderer anfitrión que registra el reproductor o desde el propio webContents cuyo URL contiene el token. Al actualizar desde el player, el token queda ligado a ese `webContentsId`.
6. El hook de red aplica el Referer solo a solicitudes multimedia cuyo documento aún contiene el token del player y cuyo webContents coincide. La respuesta multimedia de ese player recibe `Access-Control-Allow-Origin: *` para que una página `data:` pueda consumirla mediante HLS.js. No se modifica CORS para páginas normales ni para otros webContents.

## Extender los comportamientos

Al añadir una fuente nueva, mantener MC Player como carcasa compartida y definir su comportamiento como una ruta explícita, no como excepciones dispersas por el panel:

- **Entrada:** tipo de URL, Referer de navegación (`entryReferer`) y, si corresponde, Referer de media (`mediaReferer`). No asumir que ambos valores son iguales.
- **Presentación:** elemento HTML o contenedor que se monta dentro de `.stage`; por ejemplo, `video` + HLS.js para `.m3u8`, o `iframe` para un player web extraído.
- **Inicialización:** pasos previos a asignar la fuente, incluyendo IPC de Referer, eventos de readiness e interacción específica si el proveedor la exige.
- **Aislamiento visual:** mostrar el player objetivo sin el resto de la página cuando se conoce su URL de embed. Si se carga una página completa, no prometer extracción automática de su DOM cross-origin.
- **Errores y limpieza:** reportar carga/reproducción, cancelar listeners/timers al cambiar fuente y no permitir que callbacks tardíos reemplacen otro canal.

Para cada proveedor nuevo, añadir una ruta de comportamiento y sus pruebas sin cambiar el flujo de otros providers. La carcasa/iframe conserva la partición `persist:mc`: el aislamiento visual actual no es una frontera de seguridad ni una prueba de partición separada.

Los contenedores, incluidos los players de Dailymotion, se cargan en el iframe usando la URL recibida y su Referer configurado. MC Player no añade parámetros de autoplay/mute ni intenta pulsar el control de reproducción; la carga y la reproducción quedan a cargo del proveedor y del usuario.

## Por qué el Referer se aplica en el proceso principal

El ejemplo habitual con un `<input id="refererUrl">` no cambia el header por sí mismo. JavaScript de página no puede asignar `Referer` mediante `fetch`, XHR ni `xhrSetup`, porque Chromium lo trata como un header controlado por el navegador. El campo solo es configuración hasta que una API confiable lo comunica al proceso principal; el hook `webRequest.onBeforeSendHeaders` es quien establece el header de red.

El valor visible en el player significa **Referer configurado**, no una garantía de que el sitio acepte la petición. Para una página contenedora, `streams:entry-referer` fuerza una sola vez el header de la navegación del iframe a la URL registrada y vence a los 30 segundos; sus recursos posteriores usan la política normal del navegador. Un `403` aún puede indicar cookies requeridas, restricciones de IP/UA u otra política del proveedor.

CORS es independiente del Referer. El player interno tiene origen opaco (`data:`), por lo que HLS.js puede fallar aunque el header llegue correcto. La modificación CORS está limitada a respuestas de recursos multimedia asociadas al token del player; no equivale a desactivar `webSecurity` globalmente. El flujo actual no configura cookies/credenciales de sesión para el CDN.

## Límites y decisiones de seguridad

- La captura actual está instalada en la sesión principal `persist:mc`. Las sesiones extra, WebChat, WhatsApp y Perchance no se incluyen automáticamente.
- Electron permite un solo listener activo por evento de `webRequest` y sesión. No registrar otro `onBeforeSendHeaders` para MC-TV ni una segunda feature en `persist:mc`: integrar la nueva lógica en el listener existente, o componerla en el propietario de sesión adecuado.
- No confiar en el renderer como frontera de seguridad. El proceso principal valida token, protocolo HTTP(S), origen del IPC y asociación con el webContents que carga el documento del player.
- La asociación tiene expiración (15 minutos) y límite de 100 tokens. La búsqueda vuelve a comprobar que el token esté en la URL activa; navegar después en la misma pestaña no debe conservar el override de Referer/CORS.
- La lista de captura es temporal en memoria del renderer; no se persisten playlists ni headers. Los URLs firmados pueden caducar y contener tokens sensibles: no volcarlos en logs, historial ni telemetría.
- El `Referer` capturado puede estar ausente o ser distinto del que el servidor espera. En ese caso se puede usar el formulario manual; no se debe inventar que el navegador lo capturó.
- No es una técnica para saltar autenticación, DRM, controles de acceso o restricciones del proveedor. Usar solo fuentes a las que el usuario tiene derecho de acceso.

## Reutilización futura en MC-TV

Antes de portar el flujo, verificar si MC-TV es Electron, qué proceso posee su sesión y qué preload usa su player. Reutilizar el diseño de responsabilidades, no copiar IDs ni asumir que comparte `persist:mc`.

1. Elegir el dueño del hook de red por sesión y extender su único listener existente.
2. Capturar solo playlists HLS útiles, guardar el `Referer` observado y asociar el resultado a la pestaña/documento que generó la solicitud.
3. Mantener el bridge estrecho: aceptar URL HTTP(S), validar el token en main y ligar la configuración al webContents correcto.
4. Aplicar Referer antes de iniciar HLS.js; nunca intentar establecerlo desde `fetch`/XHR de página.
5. Probar CORS aparte. Si el player tiene origen opaco, modificar CORS solo en respuestas de medios de ese player y mantener `webSecurity` global habilitado.
6. Definir explícitamente política de cookies, UA, proxy, TLS y partición para el CDN; no heredar credenciales automáticamente.
7. Probar casos separados: URL directa sin Referer, Referer capturado, Referer manual, respuesta 403, error CORS, URL firmada vencida, navegación de la pestaña después de abrir el player y cierre de la pestaña.

## Idea futura: resolver el canal antes de reproducir

**Estado: propuesta; no implementada.** El objetivo para MC-TV es resolver una fuente HLS reciente antes de abrir la superficie de reproducción y volver a resolverla si deja de servir, sin reiniciar la aplicación ni dejar una navegación auxiliar abierta indefinidamente.

### Flujo propuesto

1. El usuario selecciona un canal. Un componente `ChannelResolver` recibe la URL de entrada del canal y el Referer de navegación que necesita el proveedor.
2. El resolver abre esa URL en un WebView/contexto de navegador en segundo plano, asociado a la sesión/cookies necesarias. Para canales embebidos, preferir la página o player oficial que inicializa la señal, no una playlist firmada copiada de una sesión anterior.
3. El resolver observa solicitudes de red y espera una playlist HLS candidata. Acepta `.m3u8`; descarta anuncios, segmentos `.ts`/`.m4s`, playlists de otros webContents y resultados viejos. Registra juntos URL, Referer de la petición multimedia, origen, hora y contexto del canal.
4. Cuando encuentra una URL reciente, entrega al reproductor el par `{ playlistUrl, mediaReferer }`. La reproducción comienza entonces en el player visible. El Referer utilizado para cargar la página del proveedor se conserva aparte como `entryReferer`; no sustituye automáticamente al Referer de la solicitud HLS.
5. Si el manifiesto carga y llegan segmentos, se marca la sesión como activa. Se cierra o suspende el resolver en segundo plano cuando ya no haga falta, salvo que el proveedor requiera mantener su sesión viva para renovar el stream.
6. Si el reproductor recibe un fallo de red recuperable o una respuesta HTTP que indique URL caducada/no autorizada (por ejemplo, `403`, `404` o `410`), solicita una renovación para el canal activo. No debe volver a scrapear por errores de decodificación local del video: estos se recuperan por separado.
7. El resolver obtiene una playlist nueva. Si es distinta y válida, el player reemplaza la fuente HLS y continúa en el mismo canal. Una renovación en curso se comparte entre las solicitudes concurrentes para evitar varias navegaciones y URLs compitiendo.
8. Limitar los reintentos con backoff y un máximo definido. Si no aparece una fuente nueva, mostrar un error accionable y permitir reintentar manualmente; no quedar en un bucle infinito de scraping.
9. Al cambiar de canal o cerrar la reproducción, cancelar timers, listeners y navegación auxiliar de la sesión anterior. Ninguna respuesta tardía del canal anterior debe sustituir la playlist del canal actual.

### Referentes distintos en players embebidos

Para un canal de ABCTV servido mediante Dailymotion, registrar los dos contextos por separado:

- `entryUrl`: la página/player que inicia el canal, por ejemplo `https://geo.dailymotion.com/player/<player>.html?video=<id>`.
- `entryReferer`: el sitio que contiene el embed, por ejemplo `https://www.abc.com.py/tv/`.
- `playlistUrl`: la playlist firmada entregada por el CDN de Dailymotion; su forma incluye una ruta `sec2(...)` y no debe persistirse literalmente porque el token caduca.
- `mediaReferer`: el documento que pidió esa playlist, observado como `https://geo.dailymotion.com/`.

El Referer de `entryUrl` ayuda al player embebido a inicializarse; el `mediaReferer` corresponde a la petición de la playlist/segmentos. No intercambiarlos sin probar el servidor. El fragmento `#cell=...` de una URL HLS no se envía en la petición HTTP, aunque puede aportar estado al reproductor o a su lógica de CDN.

Si el proveedor necesita interacción para iniciar la señal, cualquier toque automático debe pertenecer a una estrategia específica y explícita del proveedor, ejecutarse solo cuando el player esté listo y tener un límite de tiempo/intentos. No simular clics genéricos en toda página ni usar un retraso fijo como única señal de que el botón existe.

### Contrato y criterios de aceptación

- El resultado de resolución debe distinguir `entryUrl`, `entryReferer`, `playlistUrl`, `mediaReferer`, hora de captura y estado/causa del último fallo. No reducir ambos Referer a un solo campo ambiguo.
- La reproducción inicial debe esperar una playlist válida; no abrir el player con una URL capturada previamente que pueda estar vencida.
- Al vencer la URL, una renovación exitosa debe cambiar la fuente sin cambiar de canal; un fallo definitivo debe detener reintentos y comunicarlo.
- Un cambio de canal durante una renovación debe impedir que el resultado anterior se aplique.
- Los tests deben cubrir URL fresca, token vencido, HTTP 403/404/410, timeout, error de media no relacionado con red, reintentos simultáneos, backoff, cambio de canal durante scraping y limpieza al cerrar.
- Nunca guardar ni imprimir URLs firmadas completas, cookies o tokens en logs. En diagnósticos, redactar segmentos como `sec2(...)` y queries de autenticación.

## Archivos de MC Browser

| Archivo | Responsabilidad |
| --- | --- |
| `main.js` | Captura de solicitudes, IPC de configuración, asociación token/webContents, override de Referer y CORS acotado. |
| `preload.js` | API del renderer anfitrión y whitelist del evento de captura. |
| `preload/selection-bridge.js` | API mínima del webview-player para actualizar el Referer sin exponer Node al documento. |
| `src/renderer.html` | UI del panel lateral, captura/listado, formulario SNT y documento generado de MC Player. |

## Validación

- `node --check main.js`
- `node --check preload.js`
- `node --check preload/selection-bridge.js`
- `npm test` (50 pruebas actuales; no es una prueba de Electron ni de SNT en vivo)
- Probar manualmente en Electron dos casos separados: URL `.m3u8` directa en MC Player y URL de página/player embebida en la carcasa con Referer de entrada. Confirmar que el iframe no navega antes de registrar el Referer y que el player del sitio se comporta igual que en su página original. La captura HLS es una observación aparte, no el mecanismo que abre el contenedor.

La aceptación final depende de la respuesta real del servidor. Un parseo correcto y tests unitarios verdes no demuestran que un CDN externo acepte Referer, CORS o tokens.
