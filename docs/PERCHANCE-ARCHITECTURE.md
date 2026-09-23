# Perchance: arquitectura congelada

> **AVISO DE MANTENIMIENTO:** esta es la documentación canónica del panel de
> Perchance. No modificarla, resumirla ni reestructurarla después de este registro.
> Solo se puede actualizar con autorización explícita del usuario y únicamente
> cuando antes haya cambiado y sido validada la implementación correspondiente.
> No tocar el panel ni su documentación para cambios generales del navegador.

## 1. Qué es exactamente

Perchance es un mini navegador dentro de un panel lateral derecho de la ventana
principal. No es una pestaña normal, no es un iframe y no es una ventana nativa
independiente. El panel contiene uno o más elementos `<webview>` y cada pestaña
conserva su propia navegación.

La implementación activa está en `modules/perchance-panel/renderer.js`. El módulo
`perchance/perchance-panel.js` prepara su sesión desde el proceso principal. El
panel se carga al final de `src/renderer.html`, se abre con el botón `pch` o con
`Ctrl+Shift+Y` y se puede redimensionar con `PanelResize` usando la clave
`mc-panel-w-pch`.

## 2. Archivos y responsabilidades

| Archivo | Responsabilidad que no debe mezclarse |
| --- | --- |
| `modules/perchance-panel/renderer.js` | UI del sidebar, pestañas, webviews, barra URL, navegación, marcadores, historial, overlay y ajustes. |
| `perchance/perchance-panel.js` | Partición, allowlist de red, proxy, permisos, CSP/XFO, descargas, limpieza de datos y toasts de diálogos. |
| `perchance/perchance-proxy.js` | Proxy local singleton en `127.0.0.1` con DNS del sistema y túnel HTTP/HTTPS/WebSocket. |
| `main.js` | Inicialización del módulo, handlers IPC, apertura de enlaces como pestañas y diagnóstico opcional. |
| `preload.js` | Bridge IPC permitido: descargas, limpieza de datos y carpeta de descargas. |
| `src/renderer.html` | CSS del panel, botón, atajo y carga del script del renderer. |

`createPerchancePanel()` y `WebContentsView` siguen exportados en
`perchance/perchance-panel.js` por compatibilidad, pero son código legado. No son
el camino activo y `setupPerchancePanel()` no los utiliza.

## 3. Sesión y aislamiento

- Partición única y persistente: `persist:perchance-clean`.
- La partición conserva cookies, localStorage, IndexedDB, caché y service workers
  de Perchance entre reinicios.
- Está separada de `persist:mc` y de las sesiones del navegador principal.
- La configuración de UI se guarda en el localStorage del renderer anfitrión,
  con estas claves exactas:
  - `mc_perchance_bookmarks`
  - `mc_perchance_history`
  - `mc_perchance_settings`
- Inicio predeterminado: `https://perchance.org/4cffvbcm0c`.
- Nueva pestaña predeterminada: `https://www.google.com/`.
- El aislamiento no es un proceso Electron independiente: el webview vive dentro
  del `BrowserWindow` principal y comparte su ciclo de vida.

## 4. Estructura visual y comportamiento

`injectPanel()` crea `#perchance-sidebar` dentro de `#main` con:

1. Cabecera y cierre.
2. Barra de pestañas: cambiar, cerrar y crear (`+`).
3. Barra de navegación: atrás, adelante, recargar ignorando caché, inicio, URL,
   marcador y apertura del panel secundario.
4. `#pch-wv-container`, que contiene los webviews de las pestañas.

El panel secundario `#pch-extractor-overlay` se posiciona a la izquierda del
sidebar y lo sigue con `requestAnimationFrame`. Tiene tres vistas: Marcadores,
Historial y Configuración. Se cierra automáticamente cuando se cierra el sidebar.

Reglas de entrada de la barra URL:

- protocolo existente (`https:`, `http:`, etc.): se usa sin modificar;
- una sola palabra alfanumérica: se interpreta como código de generador y se
  convierte en `https://perchance.org/<codigo>`;
- dominio sin protocolo: se antepone `https://`;
- cualquier otra entrada: búsqueda en DuckDuckGo.

El historial conserva como máximo 200 URL únicas y la interfaz muestra las 30 más
recientes. Marcadores e historial no aceptan URL `about:`, `mc:` ni `chrome:`.

Al cerrar el panel, `suspendTabs()` desmonta los webviews y corta su actividad
(JavaScript, timers, conexiones y consumo de memoria). Solo conserva en memoria
la URL y el título de cada pestaña. Al reabrir, `resumeTabs()` crea de nuevo los
webviews usando la misma partición persistente; por eso las cookies, el login y el
almacenamiento de Perchance no se pierden. Cerrar el panel no equivale a borrar
datos.

## 5. Reglas de red y permisos

`installPerchanceNetwork()` se aplica exclusivamente a la partición anterior.
Nunca debe registrarse sobre `persist:mc`, el adblocker ni las sesiones extra.

La allowlist permite `perchance.org` y sus subdominios, además de los dominios de
plugins, subidas, CDN, Cloudflare, Google y Hugging Face definidos literalmente en
`EXACT_HOSTS` y `SUFFIX_HOSTS`. WebSocket solo se acepta para hosts Perchance o
desafíos de Cloudflare. Las URL `blob:`, `data:` y `about:` no se filtran como HTTP.

El módulo:

- usa el User-Agent nativo de Chromium con la major de Electron;
- permite los permisos registrados en `PERMISSIONS_TO_ALLOW`;
- elimina solo para respuestas originadas en Perchance las cabeceras CSP, XFO,
  COEP, CORP y `x-content-type-options` que rompen plugins e iframes;
- no modifica atributos `sandbox` de iframes de la página;
- no cancela recursos normales de navegación;
- puede limpiar almacenamiento solo si el usuario lo solicita desde Configuración
  o si se fuerza con `MC_PERCHANCE_CLEAR_STORAGE=1` o
  `--perchance-clear-storage`.

El proxy local resuelve por DNS del sistema para evitar que el DoH global de
Electron impida resolver subdominios dinámicos. No debe sustituirse por el proxy
general de la aplicación.

## 6. Descargas y diálogos

`installPerchanceDownloads()` registra `will-download` en la sesión correcta,
crea `~/Downloads/Perchance`, fija la ruta síncronamente y permite descargas
`blob:` y `data:`. Emite los estados `start`, `progress` y `done` hacia el
renderer por `perchance:download`. No llamar a `preventDefault()` ni cancelar el
camino normal de descarga.

`alert()` y `confirm()` de la página se convierten en toasts dentro de Perchance
para evitar diálogos nativos de Electron. Esto depende de los scripts instalados
por `installPerchanceAlertBubbles()`.

## 7. Navegación externa y IPC

Los enlaces HTTP(S) que intentan abrir una ventana desde el webview no crean una
ventana nativa: `main.js` envía `perchance-open-tab` y el renderer crea otra
pestaña del panel. Las ventanas auxiliares no HTTP(S), como `about:blank` y
`srcdoc`, se permiten porque Perchance las usa para widgets internos.

El bridge expone únicamente estas operaciones del panel:

- `onPerchanceDownload()` para recibir eventos;
- `clearPerchanceData({ cache, cookies, storage })`;
- `openPerchanceDlFolder()`.

La limpieza desde Configuración borra, por separado, caché, cookies y storage;
`Borrar todo` además vacía los arrays de marcadores e historial del renderer.

## 8. Límites y diagnóstico

El panel no ofrece aislamiento total de proceso ni de memoria. Los errores de
Electron asociados a frames descartados durante navegaciones rápidas pueden
aparecer cuando Perchance crea iframes; no deben solucionarse cambiando el
sandbox del webview.

Con `MC_PCH_DIAG=1` se habilitan logs `[PCH-*]` de webcontents, navegación,
consola, carga y RTC. Los errores de carga más útiles son `ERR_NAME_NOT_RESOLVED`
(DNS/proxy), `ERR_BLOCKED_BY_CLIENT` (filtro), `ERR_BLOCKED_BY_RESPONSE`
(cabeceras) y `ERR_FAILED` (proxy, permisos o sesión).

## 9. Regla final de cambios

Toda modificación específica debe quedarse en los archivos del panel enumerados
arriba. No cambiar simultáneamente partición, proxy, allowlist, `webRequest`,
`webview` y DoH. Validar primero con `node --check` sobre los archivos tocados y
`npm test`; no ejecutar `npm run dist` sin confirmación del usuario. Si se cambia
la implementación, pedir autorización antes de modificar este documento y
actualizar también sus valores exactos.