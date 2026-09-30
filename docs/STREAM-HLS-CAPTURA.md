# Captura HLS con Referer y MC Player

**Estado:** implementado en MC Browser desktop. Esta guía documenta el flujo actual y sirve como referencia para una futura integración en MC-TV; no implica que esa integración ya esté aprobada ni que las arquitecturas sean intercambiables.

## Objetivo

Capturar URLs de playlists HLS (`.m3u8`) que el detector de página puede no descubrir, conservar el `Referer` observado en la solicitud y ofrecer una reproducción alternativa en MC Player. StreamHunt conserva su escaneo y descarga existentes: la captura de red es una función separada.

La interfaz vive en el panel lateral **Stream Hunt > Streams**. Tiene dos caminos:

- **Captura de red:** se activa explícitamente y escucha nuevas solicitudes `.m3u8`; cada resultado muestra URL, página de origen y `Referer` si el navegador lo envió.
- **Prueba manual:** permite introducir una URL HLS y un `Referer` objetivo. En MC Browser los valores iniciales corresponden a la señal en vivo de SNT.

## Flujo actual

1. `main.js` mantiene el interruptor de captura. Al estar activo, el `onBeforeSendHeaders` de la sesión principal inspecciona solicitudes HTTP(S) `.m3u8`, toma `Referer` de los headers (con `d.referrer` como respaldo) y emite `streams:hls-captured` con URL, origen, `webContentsId` y hora.
2. `preload.js` autoriza el evento y expone `mc.setHlsCapture()` / `mc.setHlsPlayerReferer()` al renderer anfitrión.
3. `src/renderer.html` filtra resultados para la pestaña activa, elimina duplicados, presenta la lista y permite copiar URL/Referer o abrir la fuente en MC Player. El formulario manual usa la misma ruta de reproducción sin depender de que la captura haya detectado antes la playlist.
4. MC Player se genera como una página `data:` dentro de una pestaña normal y usa HLS.js. Antes de `loadSource()`, el player solicita al preload `preload/selection-bridge.js` actualizar el Referer asociado a su token.
5. El handler IPC de `main.js` acepta la actualización desde el renderer anfitrión que registra el reproductor o desde el propio webContents cuyo URL contiene el token. Al actualizar desde el player, el token queda ligado a ese `webContentsId`.
6. El hook de red aplica el Referer solo a solicitudes multimedia cuyo documento aún contiene el token del player y cuyo webContents coincide. La respuesta multimedia de ese player recibe `Access-Control-Allow-Origin: *` para que una página `data:` pueda consumirla mediante HLS.js. No se modifica CORS para páginas normales ni para otros webContents.

## Por qué el Referer se aplica en el proceso principal

El ejemplo habitual con un `<input id="refererUrl">` no cambia el header por sí mismo. JavaScript de página no puede asignar `Referer` mediante `fetch`, XHR ni `xhrSetup`, porque Chromium lo trata como un header controlado por el navegador. El campo solo es configuración hasta que una API confiable lo comunica al proceso principal; el hook `webRequest.onBeforeSendHeaders` es quien establece el header de red.

El valor visible en el player significa **Referer configurado**, no una garantía de que el CDN acepte la petición. Un `403` aún puede indicar token vencido, cookies requeridas, restricciones de IP/UA, expiración o un Referer distinto del esperado.

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
- Probar manualmente en Electron con la captura activada antes de cargar/reproducir la página; luego abrir el recurso capturado o usar **Probar URL manual en MC Player**.

La aceptación final depende de la respuesta real del servidor. Un parseo correcto y tests unitarios verdes no demuestran que un CDN externo acepte Referer, CORS o tokens.
