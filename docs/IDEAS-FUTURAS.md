# MC Browser v2.1 — Ideas y estrategias futuras

> **Documento de trabajo.** Nada de lo que figura acá está implementado todavía.
> Es un registro de análisis y planes para retomar otro día.
> Fecha de creación: 2026-09-12. Fuente: conversación de ideas (adjunta).
>
> Regla del documento: **no escribir código acá** — solo análisis, planes,
> estrategias, riesgos y criterios de aceptación. Los fragmentos de código que
> se mencionan quedaron en la conversación original y se pueden recuperar de ahí.

---

## Índice

1. [YouTube — bloqueo proactivo de anuncios (intercepción de `/youtubei/v1/player`)](#1-youtube--bloqueo-proactivo-de-anuncios)
2. [Instagram — descarga nativa de video (sin binarios externos)](#2-instagram--descarga-nativa-de-video)
3. [Audio — descarga y extracción de audio](#3-audio--descarga-y-extracción-de-audio)
4. [Decisiones pendientes / preguntas abiertas](#4-decisiones-pendientes--preguntas-abiertas)
5. [Correcciones a las referencias de la conversación](#5-correcciones-a-las-referencias-de-la-conversación)

---

## 1. YouTube — bloqueo proactivo de anuncios

### 1.1 Estado actual (verificado en el código)

El bloqueo de anuncios de YouTube hoy es **reactivo** (detecta el anuncio después
de que YouTube ya decidió mostrarlo). Capas existentes:

| Capa | Dónde | Qué hace |
|---|---|---|
| Bloqueo de stream | `modules/adblocker/main.js` → `isYouTubeAdStream()` (~línea 84) | Bloquea `googlevideo.com` cuando la URL trae `[?&]ad_` o `ad_signature` (enfoque Brave/uBlock). Al bloquear el stream, YouTube salta el anuncio. |
| Reglas nativas | `modules/adblocker/main.js` → `AD_NETWORK_HOSTS` / `AD_PATH_TOKENS` (~líneas 13–61) | Bloquea `doubleclick.net`, `googlesyndication.com`, `googleadservices.com`, `adservice.google.com`, etc., scoped a `youtube.com`. |
| Selectores cosméticos | `modules/adblocker/main.js` → `YT_COSMETIC_SELECTORS` (~línea 338) y `builtInCosmeticSelectors()` (~línea 384) | Oculta overlays/banners de display (`ytd-display-ad-renderer`, `.ytp-ad-module`, `[class*="ytwAd"]`, etc.). |
| Content-script de skip | `src/renderer.html` → `injectYouTubeAdSkip()` (~línea 3400), inyectado en `dom-ready` y `did-finish-load` | Detecta `ad-created`/`ad-showing` en `#movie_player`, clickea el botón de skip o fuerza `muted + playbackRate=16` para los no saltables. |

**Por qué "no cierra" del todo (análisis estructural):** todo lo anterior es
reactivo — detecta el anuncio *después* de que YouTube lo programó. Eso explica
el parpadeo, el audio que se cuela un instante, y que el heurístico `ad_` en la
URL no siempre matchee porque YouTube inserta cada vez más anuncios server-side,
mezclados en el mismo stream que el contenido, sin marca distinguible en la URL.
Brave y uBlock también vienen perdiendo terreno contra esto.

> Nota de memoria: las lecciones aprendidas de las iteraciones del skip reactivo
> están documentadas en `/memories/repo/mc-browser.md` (sección "Bloqueo de
> anuncios de video en YouTube", 2026-09-09). Resumen clave: **nunca usar seek**
> durante un anuncio (congela o reinicia), `visibility:hidden` pausa el video,
> y el 16x + muted es lo único fiable para no saltables.

### 1.2 La idea (bloqueo en el origen)

Interceptar la respuesta del endpoint `/youtubei/v1/player` — la llamada que hace
el propio YouTube para saber qué anuncios programar — y borrarle las claves
`adPlacements` / `playerAds` / `adSlots` del JSON **antes** de que el reproductor
la lea.

- Si el player nunca recibe la instrucción de mostrar el anuncio, no hay nada que
  "saltar" ni parpadeo que ocultar.
- Es la diferencia entre **bloquear el anuncio** (reactivo) y **evitar que se
  programe** (proactivo).

**Mecanismo:** el mismo patrón CDP que ya usa el cookie-guard, pero con el dominio
`Fetch` en vez de `Page`:

1. `wc.debugger.attach('1.3')` (igual que `attachCookieGuard`).
2. `Fetch.enable` con `patterns: [{ urlPattern: '*youtubei/v1/player*', requestStage: 'Response' }]`.
3. En `Fetch.requestPaused`: `Fetch.getResponseBody` → parsear JSON → borrar las
   claves de anuncios → `Fetch.fulfillRequest` con el body parcheado.
4. Cualquier error → `Fetch.continueRequest` (fallback seguro).

`requestStage: 'Response'` intercepta *después* de que la respuesta llegó pero
*antes* de que la reciba la página — es el punto justo.

### 1.3 Puntos de integración (verificados)

- **Patrón a copiar:** `attachCookieGuard(wc)` en `main.js:526`, que se engancha
  desde `app.on('web-contents-created')` en `main.js:2754`, filtrado con
  `isMainBrowsingSession(contents)` (`main.js:479`).
- **Scoping:** llamar el strip solo para webContents cuyo webview navega a
  `*.youtube.com` (igual que las reglas nativas scoped por sitio), para no meter
  CDP en cada pestaña.
- **Ubicación propuesta:** módulo separado `modules/adblocker/youtube-strip.js`,
  enganchado desde el mismo lugar donde hoy se llama `attachCookieGuard`.
- **Fallback:** dejar el sistema actual (DOM-skip + bloqueo de stream) como
  respaldo, no reemplazarlo.

### 1.4 Riesgos y consideraciones

- **Firma/validación del JSON:** si YouTube empieza a firmar o validar ese JSON
  con un hash del lado del cliente (todavía no lo hace, pero lo han insinuado),
  esta técnica se rompe y hay que volver al plan reactivo. Por eso el fallback.
- **Exclusividad del debugger:** el `debugger` de Electron es exclusivo por
  `webContents` — si el usuario abre DevTools manualmente en esa pestaña, el
  attach falla (mismo problema ya documentado en el cookie-guard).
- **Costo de CDP:** interceptar respuestas agrega latencia a la carga del player;
  conviene limitarlo a YouTube y quizá solo a `requestStage: 'Response'` (no
  interceptar requests).
- **Evolución del endpoint:** el path `/youtubei/v1/player` puede cambiar de
  versión (`v1` → `v2`) o de nombre; el `urlPattern` debería ser tolerante.
- **Claves a borrar:** `adPlacements`, `playerAds`, `adSlots` — verificar en la
  práctica si hay más (p. ej. `adBreakParams`, `adVideoEnd`).

### 1.5 Estrategia de implementación (cuando se retome)

1. **Prototipo aislado:** implementar `attachYouTubeAdStrip(wc)` como módulo
   separado, sin tocar el adblocker actual.
2. **Scoping:** engancharlo en `web-contents-created` con filtro de dominio
   YouTube (o en `did-navigate` del webview).
3. **Logging de diagnóstico:** loguear cuándo se intercepta y qué claves se
   borraron (patrón `[DIAG-YT-AD]` ya usado en el adblocker).
4. **A/B:** probar con anuncios reales (pre-roll, mid-roll, banners) y comparar
   con el comportamiento actual.
5. **No tocar el fallback reactivo** hasta confirmar que el strip cubre los casos.
6. **Documentar** en `/memories/repo/` el resultado (qué funcionó, qué rompió).

### 1.6 Criterios de aceptación

- Un video con pre-roll/mid-roll no muestra anuncio ni parpadeo, sin audio que se cuele.
- El reproductor arranca directo al contenido (sin "saltar" visible).
- No hay regresión en videos normales (el JSON parcheado no rompe la reproducción).
- Con DevTools abierta en la pestaña, el sistema cae limpio al fallback reactivo.

---

## 2. Instagram — descarga nativa de video

### 2.1 Contexto y estado actual (verificado)

- **X (Twitter) ya está resuelto** con el Stream Hunter: `video.twimg.com` sirve
  `.mp4`/`.m3u8` con extensión limpia y tokens convencionales → entra directo por
  `MEDIA_RE`/`hasMediaToken` sin fricción. No necesita nada de esto.
- **Instagram es el caso raro:** los videos no se detectan bien con el Stream
  Hunter (URLs firmadas, fragmentadas, o carruseles). Por eso se busca un método
  de descarga específico.
- **Infraestructura existente que se reutiliza:**
  - `chromiumFetch(url, extraHeaders, signal)` en `main.js:983` — pega a una URL
    usando las cookies reales de la sesión `persist:mc` (usuario logueado).
  - `ScrapingTools.extractByPattern(html, pattern)` en
    `modules/ai-assistant/main.js:883` — busca por regex dentro de un HTML.
  - `dlMedia(url, type, pageUrl, displayName)` en `src/renderer.html:4993` — crea
    la fila de descarga con barra de progreso, pausar/cancelar/reintentar, la
    agrega al historial y abre el panel de descargas. **No hay que reinventar la UI.**
  - `ytdlpCheck` / `ytdlpDownload` en `preload.js:170/174` (handlers en
    `main.js:2107/2156`).

### 2.2 La idea (Opción B — extracción nativa, sin binarios)

Instagram, cuando servís la página logueado, incrusta el JSON completo del post
en el propio HTML (incluye la URL directa del mp4 en alta calidad, sin
fragmentar). El plan:

1. `chromiumFetch(pageUrl)` con UA de Chrome → obtener el HTML.
2. Buscar `"video_url":"https:..."` en el HTML (regex).
3. Desescapar (`\u0026` → `&`, `\/` → `/`).
4. Pasar la URL directa a `dlMedia` → descarga nativa por streaming (ya existe).

**Ventajas:** cero dependencias externas, 100% controlado por nosotros, y si Meta
cambia el nombre del campo JSON es cambiar un regex, no esperar un release de un
proyecto ajeno.

**Desventajas:** más frágil ante cambios de *estructura* (si Instagram deja de
embeber ese JSON y pasa todo a llamadas dinámicas por fetch, hay que rehacerlo).

### 2.3 Alternativas consideradas

| Opción | Qué es | Veredicto |
|---|---|---|
| **A — `gallery-dl`** | Otro binario externo (Python, CLI), mismo concepto que yt-dlp pero proyecto independiente con su propio extractor de Instagram. | Redundancia real, pero es la misma clase de dependencia que yt-dlp: si Meta bloquea el patrón que comparten, caen los dos juntos. |
| **B — nativa (elegida)** | Extraer la URL del JSON embebido con `chromiumFetch` + regex. | Sin dependencias, rápido, cubre el caso común. |
| **yt-dlp (ya existente)** | Binario ya integrado. | Más robusto ante cambios estructurales, pero más pesado y requiere instalación. |

**Estrategia de fallback recomendada (cadena):**
1. **Opción B** (nativa, rápida, sin dependencias) → cubre el caso común.
2. Si falla → **yt-dlp** (más robusto).
3. Si eso también falla → **gallery-dl** como tercera red (solo si se decide
   incorporar el binario).

Así hay diversidad real sin triplicar mantenimiento: la mayoría de las veces la B
sola alcanza.

### 2.4 Puntos de integración (verificados)

- **Handler IPC:** `ipcMain.handle('ig:extract-video', ...)` en `main.js`, justo
  después del handler `ytdlp-download` (`main.js:2156`). Reutiliza `chromiumFetch`.
  - Validar que `pageUrl` sea `https://(www.)?instagram.com/...`.
  - Devolver `{ ok: true, url }` o `{ error }` (patrón de los handlers existentes).
- **Preload:** exponer `igExtractVideo: (url) => ipcRenderer.invoke('ig:extract-video', url)`
  junto a `ytdlpDownload` (`preload.js:174`).
  - ⚠️ Recordar la regla del proyecto: los canales `invoke` no necesitan entrada en
    el whitelist `ALLOWED` de preload.js (ese set es solo para `on`/`send`).
- **Renderer (`src/renderer.html`):**
  - Botón en la toolbar junto a `#dl-toolbar-btn` (`src/renderer.html:1012`),
    oculto por defecto (`display:none`).
  - `SITE_DL_PATTERNS` para detectar URLs descargables:
    `/instagram\.com\/(p|reel|reels|tv|stories)\//i`.
  - `updateSiteDownloadButton(url)` para mostrar/ocultar el botón.
  - `downloadCurrentPageVideo()` que encadena nativo → yt-dlp y usa `dlMedia`.
  - Hooks en `did-navigate` / `did-finish-load` del webview (`src/renderer.html:3496–3545`)
    y en `switchTab(id)` (`src/renderer.html:3674`), con el patrón
    `if (id === state.activeTab) updateSiteDownloadButton(wv.getURL())`.

### 2.5 Riesgos y consideraciones

- **Nombre del campo JSON:** `"video_url"` es el nombre histórico que usa
  Instagram en el JSON embebido. Si en la cuenta/región del usuario no aparece
  con ese nombre exacto, hay que loguear el HTML temporalmente y ajustar el regex.
- **Carruseles de fotos:** no tienen `video_url` → devolver error claro
  ("¿es un carrusel de fotos, o requiere sesión iniciada?").
- **Requiere sesión:** la extracción nativa depende de estar logueado en
  Instagram (cookies de `persist:mc`). Sin sesión, el HTML no trae el JSON.
- **UA:** usar un UA de Chrome realista; Instagram puede servir HTML distinto
  según el UA.
- **Fragilidad estructural:** si Instagram deja de embeber el JSON, la Opción B
  muere y la cadena cae a yt-dlp (que suele absorber esos cambios más rápido).

### 2.6 Estrategia de implementación (cuando se retome)

1. **Handler primero:** `ig:extract-video` en main.js, probado en aislamiento
   (loguear el HTML si el regex no matchea).
2. **Preload:** exponer `igExtractVideo`.
3. **Renderer:** botón + `SITE_DL_PATTERNS` + `updateSiteDownloadButton` +
   `downloadCurrentPageVideo` con la cadena nativo → yt-dlp.
4. **Hooks:** `did-navigate` / `did-finish-load` / `switchTab`.
5. **Probar con:** reel, post con video, carrusel de fotos (debe dar error claro),
   y sin sesión iniciada.
6. **Decidir después** si vale la pena sumar gallery-dl como tercera red.
7. **Documentar** en `/memories/repo/` el resultado.

### 2.7 Criterios de aceptación

- Entrar a un reel → aparece el botón → click → descarga directa por `dlMedia`
  (barra de progreso, pausar/cancelar/reintentar, historial).
- Si el regex no matchea → cae solo a yt-dlp sin que el usuario haga nada distinto.
- El resultado, venga de donde venga, aparece en el panel de Descargas de siempre.
- No rompe el flujo actual de X (que ya funciona con el Stream Hunter).

---

## 3. Audio — descarga y extracción de audio

> **Alcance:** esta sección es para **audio en general** — descargar y extraer
> audio de cualquier fuente (archivos directos, HLS de solo audio, video → mp3,
> etc.). Es una feature independiente del plan de Instagram de la sección 2;
> Instagram solo aparece como un ejemplo posible de fuente, nunca como requisito.

### 3.1 Estado actual (verificado en el código)

El navegador ya puede bajar audio en algunos casos, pero de forma **incompleta y
sin intención explícita de "descargar solo el audio"**:

| Capacidad | Dónde | Estado |
|---|---|---|
| Descarga directa de archivos de audio | `dl-file` → `downloadFile` (main.js) | Funciona para `.mp3/.wav/.flac/.ogg/.m4a/.aac` con Range, pausa/cancelar/reintentar. ⚠️ La inferencia de extensión (main.js:1485) mapea **todo** audio a `.mp3` — pierde la extensión real (un `.m4a` se guarda como `.mp3`). |
| HLS (incluye audio-only) | `dl-hls` → `downloadHls` (main.js) | Descarga playlists y finaliza con FFmpeg, pero **siempre a contenedor MP4 (video)**. Un stream de solo audio termina en `.mp4` sin pista de video. |
| Conversión FFmpeg | `remuxToMp4` / `transcodeToMp4` (main.js:1217) | Solo produce MP4. **No existe** extracción de audio (video → mp3/m4a/opus). |
| yt-dlp | `ytdlp-download` (main.js:2156) | Descarga video. **No usa** `-x --audio-format` (extracción de audio). |
| WhatsApp extractor | `modules/whatsapp-extractor/` | Maneja audio (mp3/opus) vía data URLs, pero es específico de WhatsApp. |
| IA (`ai:dl:url`) | `modules/ai-assistant/main.js:561` | Baja directos y HLS, incluido audio. |
| UI | `dlMedia` (renderer.html:4993) → `startMediaDownload` (4880) | Dispatcher único: DASH→yt-dlp, HLS→`downloadHLS`, resto→`downloadFile`. No hay opción "solo audio". |

**Conclusión:** la infraestructura de descarga (streaming, Range, pausa, FFmpeg,
yt-dlp) ya existe y es reutilizable. Lo que falta es (a) una **estrategia de
extracción de audio** (video → mp3/m4a/opus), (b) **finalización de audio-only**
en HLS, (c) **preservar la extensión real** en directos, y (d) una **UI** para
pedir "descargar solo el audio".

### 3.2 Estrategias de descarga de audio (independientes)

Tres estrategias con lógicas distintas, pensadas para componerse en cadena de
fallback:

**Estrategia A — Descarga directa (ya existe, pulir).**
- URL termina en `.mp3/.m4a/.opus/.wav/.flac/.aac` → `downloadFile` directo.
- Mejoras: preservar extensión real (no forzar `.mp3`), y opcionalmente leer
  metadatos (título/artista) para el nombre de archivo.
- Cero dependencias. Cubre: archivos sueltos, podcasts, SoundCloud directo, etc.

**Estrategia B — Extracción con yt-dlp (video → audio).**
- `ytdlp-download` con `-x --audio-format mp3|m4a|opus --audio-quality 0`.
- Requiere FFmpeg (ya integrado: `ffmpeg-check`/`ffmpeg-install`).
- Cubre: cualquier sitio con video (YouTube, redes, etc.).
- Es la más robusta ante cambios estructurales (mantenida por la comunidad).

**Estrategia C — Nativa sin binarios (audio-only HLS + extracción local).**
- **Audio-only HLS:** si el `.m3u8` solo tiene pista de audio, descargar segmentos
  y finalizar a `.m4a`/`.mp3` con FFmpeg (nueva función de finalización de audio,
  análoga a `finalizeMediaFile`).
- **Extracción local con FFmpeg:** `extractAudioFromVideo(inputPath, outputPath,
  format)` — toma un video ya descargado y extrae la pista de audio
  (mp3/m4a/opus/flac).
- **Extracción nativa de URL de audio:** resolver la URL de audio directa desde
  el HTML/JSON que embebe la página (algunos sitios la incrustan, p. ej. en un
  `<script>` con el JSON del contenido). Es un mecanismo genérico: si el sitio
  embebe la URL, se extrae con regex; si no, la cadena cae a yt-dlp.
- Cero dependencias externas (solo FFmpeg, que ya es parte del proyecto).

### 3.3 Arquitectura modular propuesta

Para que sean **funciones modulares e independientes**, se propone un módulo
dedicado siguiendo el patrón existente (`modules/whatsapp-extractor/`,
`modules/stream-enhancer/`):

```
modules/audio-downloader/
├── main.js      → handlers IPC + funciones de conversión FFmpeg
└── renderer.js  → UI (botones "Descargar audio", integración con dlMedia)
```

**Funciones independientes (contrato claro, sin acoplamiento entre sí):**

| Función | Entrada → Salida | Dependencias |
|---|---|---|
| `downloadAudioDirect(url, name, pageUrl)` | URL directa → archivo de audio | `downloadFile` (existente) |
| `downloadAudioHLS(url, name, pageUrl)` | `.m3u8` audio-only → `.m4a`/`.mp3` | `downloadHls` + nueva finalización de audio |
| `ytdlpAudio(url, format)` | URL de video → archivo de audio | yt-dlp + FFmpeg |
| `extractAudioFromVideo(inputPath, outputPath, format)` | video local → audio | FFmpeg |
| `resolveAudioUrl(pageUrl)` | página (cualquier sitio que embeba la URL de audio en su HTML) → URL de audio directa | `chromiumFetch` + regex |
| `dlAudio(url, source, format)` | **dispatcher** que encadena A → C → B | compone las anteriores |

El dispatcher `dlAudio` es el único punto de entrada desde la UI y aplica la
cadena de fallback: **directo → nativo → yt-dlp** (mismo patrón de cadena que el
plan de video de la sección 2). Cada estrategia es independiente y testeable por
separado.

**Formatos a soportar (selector en UI):**
- `mp3` — universal, con pérdida (por defecto).
- `m4a` (AAC) — mejor calidad/tamaño.
- `opus` — mejor calidad, menos compatible.
- `flac` — sin pérdida (solo si la fuente es flac directo).

### 3.4 Puntos de integración (verificados)

- **Handler IPC:** `audio:extract` (yt-dlp con `-x`), `audio:convert` (FFmpeg
  local), `audio:resolve` (URL nativa). En `main.js`, junto a los handlers de
  yt-dlp/ffmpeg (`main.js:2107–2160`).
- **Preload:** exponer `audioExtract` / `audioConvert` / `audioResolve` junto a
  `ytdlpDownload` (`preload.js:174`). (Los `invoke` no necesitan whitelist
  `ALLOWED`.)
- **Renderer:** nueva función `dlAudio(url, format)` que reusa `dlMedia`
  (renderer.html:4993) para la UI de descarga (barra de progreso, historial,
  pausa).
- **Puntos de entrada de UI (a decidir):**
  1. Menú contextual sobre elementos `video`/`audio` → "Descargar audio (mp3)".
  2. Ítems del Stream Hunter → botón "🎵 Audio" junto al "⬇ DL".
  3. Botón en la toolbar para la página activa (patrón de detección por URL de
     la sección 2, generalizable a cualquier sitio con audio).
  4. Extractor de recursos → el filtro "Audio" ya existe (renderer.html:1347);
     agregar acción de descarga.
- **Finalización de audio-only en HLS:** nueva función análoga a
  `finalizeMediaFile` (main.js:~1300) que detecte "solo audio" con
  `inspectMediaFile` (ffprobe) y use `-vn -c:a copy` (remux) o
  `-vn -c:a libmp3lame/aac` (transcode) en vez de `-map 0:v:0`.

### 3.5 Riesgos y consideraciones

- **yt-dlp + FFmpeg:** la extracción de audio con yt-dlp requiere FFmpeg; ya está
  integrado (`ffmpeg-check`/`ffmpeg-install`), pero hay que validar el flujo de
  instalación.
- **YouTube:** puede limitar/rate-limit peticiones de solo audio; la extracción
  local con FFmpeg (Estrategia C) es el plan B.
- **Extracción nativa de URL:** depende de que el sitio embeba la URL de audio en
  el HTML/JSON. Si no la embebe, o cambia el nombre del campo, esa vía falla y la
  cadena cae a yt-dlp (mismo riesgo estructural que el plan de video de la
  sección 2).
- **Extensión real:** forzar `.mp3` en directos puede romper reproductores (un
  `.m4a` renombrado a `.mp3` no siempre reproduce). Preservar la extensión real
  es importante.
- **HLS audio-only:** no todos los `.m3u8` de audio finalizan bien a MP4; la
  finalización de audio debe detectar el codec (AAC → remux a `.m4a`; otro →
  transcode a `.mp3`).
- **Metadatos:** opcional — etiquetar mp3 (título/artista) requiere una lib extra
  (p. ej. `music-metadata` o `node-id3`); no es crítico para v1.

### 3.6 Estrategia de implementación (cuando se retome)

1. **Base:** función `extractAudioFromVideo` (FFmpeg) + finalización de audio-only
   en HLS — son las piezas que faltan en el motor.
2. **Estrategia A:** pulir `downloadFile` para preservar extensión real de audio.
3. **Estrategia B:** extender `ytdlp-download` con opción `{ audio: true, format }`
   (o handler `audio:extract`).
4. **Estrategia C:** `resolveAudioUrl` genérica (resolver URL de audio desde el
   HTML de la página; aplica a cualquier sitio que la embeba).
5. **Dispatcher:** `dlAudio(url, format)` que encadena A → C → B.
6. **UI:** elegir 1–2 puntos de entrada (recomendado: menú contextual + Stream
   Hunter).
7. **Probar con:** YouTube (video → mp3), podcast directo (.mp3), HLS de
   audio-only, y un sitio que embeba audio en su HTML.
8. **Documentar** en `/memories/repo/` el resultado.

### 3.7 Criterios de aceptación

- Un video de YouTube se descarga como `.mp3` (o `.m4a`) con calidad razonable,
  sin video.
- Un video de cualquier sitio (YouTube, redes, etc.) permite "descargar audio" y
  cae a yt-dlp si la extracción nativa falla.
- Un `.m3u8` de solo audio termina en `.m4a`/`.mp3` (no en `.mp4` sin video).
- Un archivo `.m4a` directo se guarda como `.m4a` (no `.mp3`).
- Todo pasa por el panel de Descargas de siempre (progreso, pausa, historial).

---

## 4. Decisiones pendientes / preguntas abiertas

- **YouTube:** ¿vale la pena el costo de CDP (latencia + exclusividad del
  debugger) por el beneficio proactivo, o el reactivo actual es "suficiente"?
  ¿Se implementa como módulo separado o se integra al adblocker?
- **Instagram:** ¿se incorpora `gallery-dl` como tercera red, o la cadena
  nativo → yt-dlp alcanza? (Recomendación: empezar sin gallery-dl.)
- **Instagram:** ¿el botón de descarga aplica solo a Instagram o se generaliza
  el patrón `SITE_DL_PATTERNS` a otros sitios (TikTok, etc.) a futuro?
- **Ambos:** ¿se exponen como toggles en la UI (protecciones/ajustes) o van
  siempre activos?
- **Audio:** ¿puntos de entrada de UI (menú contextual, Stream Hunter, toolbar)?
  ¿Formato por defecto (mp3 vs m4a)? ¿Se etiquetan metadatos en v1?

---

## 5. Correcciones a las referencias de la conversación

Al verificar contra el código actual (2026-09-12), algunas referencias de la
conversación original estaban desactualizadas. Valores reales:

| Referencia en la conversación | Valor real verificado |
|---|---|
| `dlMedia` en `main.js:5089` | `dlMedia(url, type, pageUrl, displayName)` en **`src/renderer.html:4993`** (es código del renderer, no del main). |
| `ytdlp-download` en `main.js:~2132` | Handler en `main.js:2156` (`ytdlp-check` en `2107`, `findYtdlp()` en `2100`). |
| `chromiumFetch` en `main.js:958` | `chromiumFetch(url, extraHeaders, signal)` en `main.js:983`. |
| `ScrapingTools.extractByPattern` en `modules/ai-assistant/main.js:881` | En `modules/ai-assistant/main.js:883`. |
| `attachCookieGuard` en `main.js:~527` | `attachCookieGuard(wc)` en `main.js:526`; se engancha en `web-contents-created` (`main.js:2754`) con `isMainBrowsingSession` (`main.js:479`). |
| Botón de toolbar en `src/renderer.html:~1012` | `#dl-toolbar-btn` en `src/renderer.html:1012`. ✓ |
| `injectYouTubeAdSkip` | En `src/renderer.html:3400`, inyectado en `dom-ready`/`did-finish-load` (`3496–3504`). ✓ |
| `ytdlpCheck`/`ytdlpDownload` en preload | `preload.js:170/174`. ✓ |

---

*Fin del documento. Para retomar: elegir un tema, leer la sección correspondiente
y la memoria del repo (`/memories/repo/mc-browser.md` para YouTube, y las notas de
WhatsApp/streams para patrones de descarga), y arrancar por el paso 1 de la
estrategia elegida. El plan de audio (sección 3) está pensado para construirse
como módulo independiente `modules/audio-downloader/` con funciones componibles.*