# MC Browser: guia para colaboradores

**Estado de referencia: 2026-09-28.** Este documento resume el estado observado del repositorio y las decisiones de arquitectura conocidas. Si contradice el codigo actual, verificar el codigo y los tests antes de cambiarlo; las notas historicas explican decisiones, pero no sustituyen la implementacion.

## 1. En una frase

MC Browser es un navegador de escritorio basado en Electron que combina navegacion con controles de privacidad configurables, herramientas de medios y una IA integrada con supervision del usuario. La prioridad debe ser que el navegador y sus limites de seguridad sean predecibles; la IA, la extraccion multimedia y los mini-navegadores son capacidades complementarias, no excusas para debilitar ese nucleo.

## 2. Estado actual del proyecto

- Aplicacion Electron 30, orientada principalmente a Windows. El renderer anfitrion es `src/renderer.html` y los webviews muestran sitios web no confiables.
- La UI integra pestañas, nueva pestaña, barra de URL, historial, marcadores, permisos/cookies, descargas, recursos/streams, Reader, Lab y paneles laterales.
- La capa de privacidad incluye bloqueo de anuncios y trackers, reglas globales y por sitio, controles de cookies/permisos, aislamiento de recursos de terceros, DoH y proxy. Su comportamiento depende del sitio y de la particion; no es un bloqueo uniforme aplicado de la misma forma a todas las sesiones.
- Las herramientas multimedia detectan recursos y streams y admiten descargas directas/HLS, con FFmpeg y yt-dlp en los flujos que los requieren. Reutilizar el panel de descargas existente; no crear una segunda cola sin una necesidad concreta.
- El asistente IA admite proveedores locales y remotos, contexto de pagina, herramientas y modos. Los modos actuales del renderer son `casual`, `coder`, `gamedev`, `private` y `supervised`. La memoria y los recordatorios locales persisten en archivos de la aplicacion.
- Hay superficies especializadas: extractor de WhatsApp, panel WebChat para proveedores web y panel de Perchance. Tienen requisitos de sesion distintos del navegador principal.
- La modularizacion es parcial: existen modulos y librerias, pero `main.js` y `src/renderer.html` aun concentran bastante logica y coordinacion.

### Privacidad: distinciones importantes

- Que historial, ajustes o memoria se guarden localmente no significa que toda inferencia de IA sea local. Ollama puede ser local; los proveedores API y los servicios web implican enviar datos al proveedor correspondiente. No prometer procesamiento local universal.
- El aislamiento por particion separa cookies y almacenamiento, pero no convierte cada webview en un proceso de confianza independiente ni equivale a aislamiento total.
- Una excepcion de compatibilidad debe permitir solo lo necesario para el sitio/flujo afectado. No asumir que un dominio de autenticacion, una allowlist o un bypass tambien debe desactivar el bloqueo de contenido.

## 3. Mapa de codigo

| Superficie | Responsabilidad principal |
| --- | --- |
| `main.js` | Ciclo de vida Electron, ventana, sesiones, politicas de red/navegacion, permisos, descargas, IPC e integracion de modulos. Es grande; localizar el handler propietario antes de editar. |
| `preload.js` | Frontera entre renderer y proceso principal. Expone `mc` con `contextBridge`; los mensajes entrantes tienen canales permitidos. Mantener API estrecha y validar argumentos en el proceso principal. |
| `src/renderer.html` | UI anfitriona, pestañas/webviews, estado y logica de muchos paneles. Es un archivo grande y sensible a cambios de orden, reinyeccion y listeners duplicados. |
| `lib/` | Logica reutilizable con menor acoplamiento a Electron, como permisos, guardia de navegacion y checkpoints HLS. Preferir tests unitarios aqui cuando la regla pueda aislarse. |
| `modules/adblocker/` | Motor, listas, reglas de red y filtros cosmeticos. Las excepciones y el orden de evaluacion importan. |
| `modules/ai-assistant/` | Backend de proveedores/herramientas y UI del asistente. No mezclar automaticamente acciones del asistente con navegacion normal. |
| `modules/stream-enhancer/` | Deteccion y presentacion de streams en renderer. |
| `modules/whatsapp-extractor/` | Extraccion/gestion especifica de medios de WhatsApp. |
| `modules/perchance-panel/` + `perchance/perchance-panel.js` | Renderer y configuracion principal del mini-navegador Perchance. Su contrato esta documentado por separado. |
| `test/` | Tests Node actuales: `permissions.test.js`, `perchance.test.js` y `hls-resume.test.js`. No son pruebas end-to-end de Electron ni de sitios reales. |

## 4. Invariantes que no se deben romper

### Seguridad y puente IPC

- El `BrowserWindow` anfitrion usa `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` y `sandbox: true`. Los sitios web no deben recibir acceso directo a Electron o al filesystem.
- Las capacidades del renderer pasan por la API limitada de `preload.js`; validar tipos, URLs, rutas e identificadores en el proceso principal. No aceptar que la UI sea una frontera de seguridad.
- Cuando se agregue un evento `send`/listener, revisar la lista `ALLOWED` y la forma en que el bridge lo expone. Los handlers `invoke` no necesariamente usan esa lista; seguir el patron existente en vez de agregar canales a ciegas.
- Las acciones con efectos (filesystem, descargas, ejecucion de herramientas, acceso a contenido de pagina) deben conservar consentimiento y confirmaciones segun el modo correspondiente.

### Navegacion, enlaces y popups

- La guardia distingue una navegacion iniciada por la interfaz del navegador de una redireccion automatica iniciada por la pagina. El objetivo es bloquear saltos externos automaticos, sin romper una navegacion que el usuario solicito.
- Las acciones de la UI que navegan deben marcar la intencion mediante el mecanismo existente de `nav-intent`; revisar duracion y limpieza de la marca por `webContents`. Una excepcion demasiado amplia puede dejar pasar anuncios durante la carga.
- El usuario suele abrir enlaces usando **Abrir enlace en nueva pestaña**. No inferir permiso para redirigir por el mero hecho de detectar un clic confiable en la pagina; ese cambio requiere una decision expresa y un caso reproducible.
- El menu contextual de enlaces, los eventos `new-window` y `setWindowOpenHandler` son rutas distintas. Mantener un solo propietario para crear una pestaña; doble manejo ya genero pestañas duplicadas.
- Mantener delante de cualquier excepcion de navegacion los bloqueos explicitos de redes/rutas publicitarias. Probar por separado URL directa, redirect cross-site, popup, enlace en pestaña nueva y login OAuth.

### Sesiones, cookies y excepciones por sitio

- Las particiones persistentes son limites funcionales: la principal usa `persist:mc`; WebChat `persist:mc-webchat`; WhatsApp `persist:mc-whatsapp`; Perchance usa `persist:perchance-clean`; las sesiones adicionales siguen `persist:mc-session-<id>`.
- No unificar particiones ni cambiar el alcance de `webRequest`, permisos, cookies, proxy o adblocker como parte de un arreglo local. Cada sesion tiene una politica intencionalmente distinta.
- **Google/Gemini:** solo en documentos `*.google.com` y `*.google.com.py`, el adblock generico y el aislamiento de terceros dejan pasar recursos; se bloquean `adservice.google.com`, `pagead2.googlesyndication.com`, `googleadservices.com`, `googletagmanager.com`, `googletagservices.com` y `google-analytics.com` (incluidos subdominios). Las reglas explicitas del usuario conservan prioridad. Gemini y `accounts.google.com` reciben cookies persistentes por defecto; los permisos sensibles siguen la politica normal.
- **WebChat** debe ser un webview completo del proveedor en `persist:mc-webchat`: cookies/almacenamiento propios, sin reglas de permisos, adblock, cookies, redirecciones ni aislamiento heredadas del navegador principal; se permiten los permisos que solicite el proveedor. No inyectar contexto MC ni reescribir su navegación/popups. El proxy sigue la configuracion explicita del usuario.
- Compatibilidad de Google debe conservar la identidad nativa de Chromium. El User-Agent especial de WhatsApp y sus Client Hints se limitan a dominios WhatsApp; no aplicar una rotacion o UA global para arreglar un sitio.
- Las reglas de autenticacion, cookies persistentes y origenes confiables son especificas al flujo. No agregar dominios completos a una excepcion global para reparar un subdominio o SDK puntual.
- **Perchance:** seguir `docs/PERCHANCE-ARCHITECTURE.md`. Ese documento se declaro congelado: no tocar el panel ni su documentacion para cambios generales, y no modificarlo sin autorizacion explicita del usuario y validacion previa de la implementacion.

### Webviews, descargas y estado

- En Electron, un webview creado sin `src` puede no emitir `dom-ready` de forma fiable. Para navegaciones, seguir el patron existente y evitar iniciar dos cargas (por ejemplo `loadURL` y despues asignar `src`) en el mismo ciclo.
- `mc://newtab` es estado virtual de la aplicacion; el webview puede estar en `about:blank`. No confundir ambos estados ni convertir un back a `about:blank` en una pagina vacia visible.
- Las descargas nativas pertenecen a la `Session`, no al webContents que las inicio. Registrar el handler en la particion correcta y no cancelar el flujo normal por cerrar una pestaña popup.
- Recursos `blob:` y `data:` no siguen siempre la ruta HTTP normal. Antes de cambiar descargas de contenido generado, verificar quien crea la URL, que sesion la recibe y como se obtiene el nombre/extensión.
- Borrar datos puede requerir limpiar a la vez el archivo JSON nativo, `localStorage`, almacenamiento del sitio y estado en memoria, y luego recargar la pagina. Un solo boton puede atravesar varios almacenes.

## 5. Problemas que historicamente costaron mas

Estos son patrones repetidos documentados en `/memories/repo/`; usarlos como lista de riesgos, no como afirmacion de que todos sigan abiertos.

1. **Carreras y estados en webviews.** Navegar dos veces, depender de `dom-ready`, o actualizar la barra y el webview fuera de orden produjo pantallas blancas, cargas abortadas y vuelta a `about:blank`. Separar URL virtual, URL real, pestaña activa y carga pendiente.
2. **Redirecciones, popups y OAuth.** Un cambio de prioridad en `will-redirect`, `did-navigate` o los handlers de popup puede bloquear una cadena legitima, permitir redirecciones de anuncios o abrir tabs duplicadas. Login de Google/X tiene estados intermedios: no redirigir/reload al recibir un cambio de cookie mientras el usuario aun autentica.
3. **Excepciones de privacidad demasiado amplias.** Un bypass de dominio auth aplicado antes de reglas explicitas desactivo reglas de YouTube; tratar cualquier host de compatibilidad como confiable puede abrir trackers. Probar el orden exacto y limitar por host, sitio, tipo de recurso y particion.
4. **Alcance de datos inconsistente.** Historial y preferencias existen en mas de una capa. Se documentaron datos que “volvian” porque un fallback reimportaba `localStorage` despues de limpiar el historial nativo.
5. **Suposiciones incorrectas sobre Electron.** `allow="fullscreen"` no reemplaza el permiso de sesion; fullscreen dependia de conceder `fullscreen`. `getProcessId()` no es el PID del SO. Coordenadas del menu contextual de Electron pueden estar en DIP mientras `elementFromPoint()` usa pixeles CSS.
6. **Trabajo global pesado en paginas dinamicas.** Un `MutationObserver` que recorria todos los iframes/elementos y un hook global de `fetch` congelaron un renderer. Preferir interceptacion de red y trabajo incremental, limitado al sitio que lo necesita.
7. **Handlers y timers duplicados.** Doble conversion de popup a pestaña genero pestañas duplicadas; varios muestreadores de procesos se pisaban. Asegurar un solo propietario y un solo timer para cada flujo.
8. **Contenido multimedia y contexto obsoleto.** Hooks de `fetch`/XHR sobreviven navegaciones SPA; capturar `pageUrl` solo al instalarlos atribuyo streams a la pagina anterior. Usar `location.href` al detectar y actualizar items ya existentes cuando cambia la SPA.
9. **Diferencias entre codigo y build.** Se documento una restauracion desde `app.asar` porque un estado fuente habia quedado atras. No asumir que un artefacto empaquetado siempre es la fuente de verdad; comparar fechas/diffs antes de restaurar o copiar, y no sobrescribir `package.json` con el del asar sin revisar.

## 6. Futuro documentado, aun no comprometido

`docs/IDEAS-FUTURAS.md` es un documento de analisis, no una especificacion aprobada ni una lista de trabajo ya implementado.

| Idea | Estado y cautelas |
| --- | --- |
| YouTube: interceptar `/youtubei/v1/player` y retirar campos de anuncios antes de que el player los procese | Propuesta. Usa CDP `Fetch`; el debugger es exclusivo por webContents y agrega riesgo/latencia. Mantener el bloqueo y skip reactivos actuales como fallback. |
| Instagram: extraer URL de video del HTML/JSON de la sesion y descargar por el pipeline actual | Propuesta. Puede depender de login y cambiar si Meta modifica el HTML. Plan de fallback nativo -> yt-dlp; `gallery-dl` sigue siendo una decision abierta. |
| Audio general: extension correcta para directos, HLS solo audio, extraccion con FFmpeg/yt-dlp y una UI “solo audio” | Propuesta. Infraestructura parcial existente; la cadena de conversion y la UI no estan completas. No confundir con la idea de Instagram. |
| Adjuntar contexto del navegador al WebChat | Retirado el 2026-09-28 por decision del usuario: el WebChat debe comportarse como el sitio nativo, sin botones de adjuntar pagina/seleccion ni inyeccion de contexto. No restaurar sin autorizacion expresa. |
| MC-M.Browser para Android | Linea/prototipo separado; no asumir que forma parte de este Electron desktop ni portar cambios sin revisar su arquitectura y alcance.

Antes de tomar una idea, acordar objetivo, politica de privacidad, fallback, costo de mantenimiento, criterios de aceptacion y si se permite cambiar la UX. No implementar una propuesta solo porque aparezca en el documento.

## 7. Evaluacion del enfoque

**La tesis del producto es defendible, pero el alcance actual es ancho.** Las piezas comparten una base real —sesiones web, privacidad, contexto y descargas—, pero combinan al menos cuatro trabajos de producto: navegador seguro, gestor de medios, asistente IA/Lab y mini-navegadores especializados. El mayor riesgo no es que falten ideas; es sumar superficie mas rapido de lo que se puede probar.

Orden recomendado para mantener el foco:

1. **P0: confianza del navegador.** Navegacion, nueva pestaña, historial, cookies/permisos, aislamiento y descargas deben tener comportamiento estable y pruebas de regresion. No relajar protecciones para quitar un error visual sin identificar su causa.
2. **P1: hacer confiables las herramientas actuales.** Corregir ciclo de vida, rendimiento, datos que reaparecen, sesiones y descargas; conservar el pipeline comun y reducir duplicaciones cuando haya una ganancia concreta.
3. **P2: evolucion modular de IA y medios.** Mantener consentimiento visible, limite de datos claro y fallback. Separar features nuevas en modulos cuando reduzca acoplamiento, no por crear carpetas sin ownership claro.
4. **P3: experimentos.** Probar ideas de YouTube/Instagram/audio con prototipo reversible, scope por host/sesion, logs temporales, fallback y criterio de abandono. No poner un experimento fragil en la ruta critica sin evidencia.

Hay una deuda documental concreta: el README presenta modos `professional` y un arbol con `mcb-v3/`, mientras el renderer actual usa `coder`/`gamedev` y esa carpeta no aparece en el repositorio. Revisar y sincronizar el README cuando se apruebe; hasta entonces, usar el codigo para estado actual y etiquetar las propuestas como tales.

## 8. Procedimiento recomendado para cambios

1. Identificar el dueño del comportamiento: main, preload, renderer, modulo, libreria o sesion. Encontrar un test/call-site cercano antes de editar.
2. Escribir una hipotesis falsable y el caso barato que la podria refutar. Elegir el cambio minimo que permita probarla.
3. Para una feature web, revisar al menos: flujo normal, sitio externo, redireccion automatica, pestaña nueva, permiso/cookie relevante y carga en una sesion limpia cuando aplique.
4. Añadir o reutilizar una prueba unitaria para reglas puras. Ejecutar primero el test del area y luego `npm test` (`node --test`). Usar `node --check <archivo.js>` para sintaxis JS; no reemplaza prueba funcional.
5. Probar Electron manualmente para cambios de webview, permisos, popup, descarga o sesion. La app usa `requestSingleInstanceLock()`: cerrar la instancia abierta antes de interpretar que `npm start` no hizo nada.
6. Confirmar que la build/artefacto incluye los archivos nuevos si se cambia empaquetado. No ejecutar `npm run dist` ni reconstruir instalador sin autorizacion del usuario.
7. No revertir trabajo preexistente del usuario, no hacer reset destructivo, no borrar datos/particiones durante pruebas sin consentimiento y no crear commits/push salvo que se pidan.

Al 2026-09-28, la suite tiene tres archivos de test y 50 tests; cubre reglas y funciones puras, pero no sustituye pruebas reales de Electron, autenticacion, navegacion o descarga en sitios.

## 9. Lecturas de referencia

- [README del proyecto](../README.md): descripcion general, pendiente de sincronizar en algunos detalles.
- [Ideas futuras](IDEAS-FUTURAS.md): propuestas y riesgos; nada de ahi se considera aprobado por defecto.
- [Captura HLS con Referer](STREAM-HLS-CAPTURA.md): flujo de captura, player, limites de red y guia de portabilidad a otras apps.
- [Arquitectura de Perchance](PERCHANCE-ARCHITECTURE.md): contrato especifico del panel, particion y red; documento congelado.
- [Guardia de navegacion](../lib/navigation-guard.js), [permisos](../lib/permissions.js) y [bridge](../preload.js): reglas base que conviene leer antes de cambios de seguridad/navegacion.