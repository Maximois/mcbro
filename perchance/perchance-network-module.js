// perchance-network-module.js
// Módulo de red "modo Perchance" para un navegador Electron estricto.
// Uso: installPerchanceModule() EN main, antes de crear la BrowserWindow.
// La ventana que cargue perchance.org debe usar el mismo partition (persist:perchance).
//
//   const { createPerchanceWindow } = require("./perchance-network-module");
//   createPerchanceWindow("https://perchance.org/mi-generador");
//
// Qué hace y por qué (ver README/notas al final del archivo):
//   1. Sustituye la allowlist estricta por una allowlist "Perchance" (dominios + familia).
//   2. Quita CSP / X-Frame-Options SOLO en respuestas del ecosistema Perchance
//      (el motor inyecta <script> y usa eval: sin esto no arranca).
//   3. Resuelve permisos (fullscreen, clipboard, pointerLock, captura...).
//   4. Fuerza una UA de Chrome normal y desactiva la marca de automatización.

const { app, session, BrowserWindow } = require("electron");

// ---------------------------------------------------------------------------
// 1. Allowlist del ecosistema Perchance
// ---------------------------------------------------------------------------

// Dominios exactos
const PERCHANCE_EXACT_HOSTS = new Set([
  "perchance.org",
  "null.perchance.org",
  "static.cloudflareinsights.com", // beacon que sirve perchance.org
  "clients3.google.com",           // connectivity checks del navegador
  "sucuri.net",
]);

// Dominios + todos sus subdominios (sufijo). Ojo: los subdominios de perchance
// incluyen "<32hex>.perchance.org" (cada generador vive ahí), y los plugins
// tienen servidores propios: image-generation / text-generation / comments-plugin /
// server-plugin / upload .perchance.org
const PERCHANCE_SUFFIX_HOSTS = [
  "perchance.org",
  "uploads.dev",              // user.uploads.dev, aigc.uploads.dev, editable.uploads.dev
  "user-uploads.perchance.org",
  "esm.sh",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  "huggingface.co",           // @huggingface/transformers (t2i) baja modelos de aquí
  "hf.co",
  "xethub.hf.co",             // cas-bridge.xethub.hf.co (transferencia de pesos)
  "googleapis.com",           // fonts.googleapis.com
  "gstatic.com",
  "bigger.pics",              // upscaler usado por la galería
  "raw.githubusercontent.com",
];

function isPerchanceHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  if (PERCHANCE_EXACT_HOSTS.has(h)) return true;
  return PERCHANCE_SUFFIX_HOSTS.some((suffix) => h === suffix || h.endsWith("." + suffix));
}

// OJO: partner/redirectores de anuncios (si en algún momento se rehabilitan).
const PERCHANCE_AD_HOSTS = ["ads.perchance.org"];

function isAllowedUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return true; // data:, blob:, about: etc. no tienen host
  }
  if (u.protocol === "ws:" || u.protocol === "wss:") {
    return isPerchanceHost(u.hostname); // wss://server-plugin.perchance.org/...
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  return isPerchanceHost(u.hostname) || PERCHANCE_AD_HOSTS.includes(u.hostname);
}

// ---------------------------------------------------------------------------
// 2. Instalación del módulo sobre una session/partition dedicada
// ---------------------------------------------------------------------------

const PERCHANCE_PARTITION = "persist:perchance";

const PERMISSIONS_TO_ALLOW = new Set([
  "fullscreen",
  "pointerLock",
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "media",             // chats de personajes con micrófono/cámara
  "notifications",
  "background-sync",
  "idle-detection",
  "gamepad",
  "hid",
  "usb",
  "serial",
  "midi",
  "midiSysex",
  "speaker-selection",
]);

function installPerchanceModule(partition = PERCHANCE_PARTITION) {
  const ses = session.fromPartition(partition);

  // --- 2.1 Filtro de peticiones: bloquea SOLO lo ajeno al ecosistema ---
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    if (isAllowedUrl(details.url)) return callback({ cancel: false });
    // Un subdominio/iframe que no esté en la familia: cancelamos,
    // pero dejamos pasar el frame raíz de perchance para no romper la navegación.
    const isMainFrame = details.resourceType === "mainFrame";
    callback({ cancel: !isMainFrame });
  });

  // --- 2.2 Quitar CSP / X-Frame-Options en respuestas Perchance ---
  ses.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (details, callback) => {
    const fromPerchance = isPerchanceHost(new URL(details.url).hostname || "") ||
      isPerchanceHost(details.frameOrigin || "");
    if (!fromPerchance) return callback({});

    const headers = { ...(details.responseHeaders || {}) };
    const drop = [
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "x-content-type-options",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
    ];
    for (const key of Object.keys(headers)) {
      if (drop.includes(key.toLowerCase())) delete headers[key];
    }
    callback({ responseHeaders: headers });
  });

  // --- 2.3 Permisos: permitimos el set que Perchance usa, negamos el resto ---
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(PERMISSIONS_TO_ALLOW.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => PERMISSIONS_TO_ALLOW.has(permission));

  // --- 2.4 Redirecciones: log para depurar cadenas raras, sin cancelar ---
  ses.webRequest.onBeforeRedirect((details) => {
    if (!isAllowedUrl(details.redirectURL)) {
      console.warn("[perchance] redirect fuera de allowlist:", details.url, "->", details.redirectURL);
    }
  });

  // --- 2.5 Descargas (blob:/data:) ---
  installDownloadHandling(partition);

  return ses;
}

// ---------------------------------------------------------------------------
// 2.5 Descargas: el botón "⬇️ Download" de la galería/t2i (y el guardado de
//     imágenes) usa <a href="blob:..."><download> + .click(). Eso dispara
//     session 'will-download'. Si tu navegador estricto cancela por scheme
//     (blob:/data:) o registró el handler en OTRA session/partition, la
//     descarga se pierde en silencio mientras arrastrar-afuera sigue andando.
// ---------------------------------------------------------------------------

function isDownloadableUrl(rawUrl) {
  // blob:/data: son descargas legítimas del contenido generado
  if (/^(blob|data):/i.test(rawUrl)) return true;
  return isAllowedUrl(rawUrl);
}

function installDownloadHandling(partition = PERCHANCE_PARTITION) {
  const ses = session.fromPartition(partition);
  ses.on("will-download", (event, item) => {
    const url = item.getURL();
    if (!isDownloadableUrl(url)) {
      console.warn("[perchance] descarga bloqueada:", url);
      item.cancel();
      return;
    }
    // NO llames a event.preventDefault() ni a item.cancel() en el camino normal.
    // Deja que Chromium use la carpeta por defecto, o pon un diálogo tú mismo:
    item.setSaveDialogOptions({
      title: "Guardar",
      defaultPath: item.getFilename() || "perchance-download",
    });
    item.once("done", (_e, state) => {
      if (state !== "completed") console.warn("[perchance] descarga no completada:", state, url);
    });
  });
  return ses;
}

// ---------------------------------------------------------------------------
// 3. UA + webdriver: Perchance comprueba navigator.webdriver y hace
//    window.eval() para decidir si el navegador "es moderno" (si falla,
//    degrada la carga). Una UA de Electron/Chromium custom puede romperlo.
// ---------------------------------------------------------------------------

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function applyPerchanceUserAgent(partition = PERCHANCE_PARTITION) {
  const ses = session.fromPartition(partition);
  ses.setUserAgent(CHROME_UA);
  app.userAgentFallback = CHROME_UA;
  // Evita que aparezca navigator.webdriver === true si usas flags de automatización:
  app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
}

// ---------------------------------------------------------------------------
// 4. Ventana lista para Perchance
// ---------------------------------------------------------------------------

function createPerchanceWindow(url = "https://perchance.org/") {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PERCHANCE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false, // motores de juego/animación en background
      // Nunca des un preload que reescriba window.open/fetch dentro del iframe.
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "allow" })); // popups/enlaces
  win.loadURL(url);
  return win;
}

module.exports = {
  installPerchanceModule,
  installDownloadHandling,
  applyPerchanceUserAgent,
  createPerchanceWindow,
  isPerchanceHost,
  isAllowedUrl,
  isDownloadableUrl,
  PERCHANCE_PARTITION,
  CHROME_UA,
};

// ---------------------------------------------------------------------------
// Notas para mantener esto (por qué cada pieza existe)
// ---------------------------------------------------------------------------
// La página https://perchance.org/<gen> es un contenedor que embebe
// https://<32hex>.perchance.org/<gen> en un <iframe sandbox="... allow-same-origin
// allow-scripts allow-modals allow-popups allow-downloads allow-pointer-lock ...">.
// El código real corre en ese subdominio distinto (otro origen), así que:
//
// - Si tu allowlist estricta solo deja "el dominio y sus subdominios", los
//   iframes de plugins en OTROS dominios (image-generation.perchance.org,
//   text-generation.perchance.org, upload.perchance.org, user.uploads.dev,
//   esm.sh, cdn.jsdelivr.net, huggingface.co) se caen y la página queda mutilada.
// - El motor (perchance-engine-*.js) define funciones creando <script> con
//   document.head.append(...) y evalúa bloques con eval(`with(root){...}`).
//   Cualquier CSP o bloqueo de inline/eval mata el motor => hay que borrar CSP.
// - El iframe y su padre se comunican por postMessage entre orígenes distintos:
//   no particiones ni aísles ese tráfico.
// - El almacenamiento (localStorage, IndexedDB/kv-plugin) vive en el origen del
//   subdominio: si limpias la partition o la recreas con otro nombre, se pierde
//   todo (y pueden fallar kv-plugin / remember).
// - server-plugin usa wss://server-plugin.perchance.org (WebSocket) => allowlist
//   también para ws/wss.
// - No filtres por resource type "el que esperas": Perchance pide fuentes
//   (fonts.googleapis.com), beacon de Cloudflare, CDNs de módulos, etc.
// - El botón de descarga de la galería/t2i no navega: crea un <a> con
//   href=blob: (o data:), atributo download, y llama .click(). Es una descarga
//   de sesión (will-download). Si tu capa estricta cancela scheme blob:/data: o
//   solo instaló el handler en la session por defecto en vez de la partition
//   persist:perchance, la descarga se cae en silencio (el drag&drop sí funciona
//   porque arrastrar un blob no pasa por el pipeline de descargas).
//   Arreglo: registrar will-download sobre session.fromPartition(partition) y
//   permitir blob:/data: (ver installDownloadHandling).
// ---------------------------------------------------------------------------