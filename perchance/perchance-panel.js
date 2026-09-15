// perchance-panel.js
// Módulo AISLADO para el panel dedicado de Perchance.
// Vive fuera de tus restricciones: su propia partition, su propia session,
// su propia allowlist, su propio pipeline de descargas.
//
//   const { createPerchancePanel } = require("./perchance-panel");
//   const panel = createPerchancePanel({ win, bounds: {x:0,y:0,width:900,height:700} });
//   panel.view.webContents.loadURL("https://perchance.org/mi-generador");
//
// Sustituye al módulo anterior (perchance-network-module.js). Todo aquí es
// autocontenido: no necesita que toques la session por defecto de la app.

const { app, session, WebContentsView, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const PERCHANCE_PARTITION = "persist:perchance";

// ===========================================================================
// 1. Allowlist del ecosistema Perchance
// ===========================================================================

const EXACT_HOSTS = new Set([
  "perchance.org",
  "null.perchance.org",
  "static.cloudflareinsights.com",
  "challenges.cloudflare.com",
  "challenge.cloudflare.com",
  "turnstile.cloudflare.com",
  "clients3.google.com",
]);

const SUFFIX_HOSTS = [
  "perchance.org",            // incluye <32hex>.perchance.org y los servidores
                              // de plugins: image-generation / text-generation /
                              // comments-plugin / server-plugin / upload .perchance.org
  "uploads.dev",              // user. / aigc. / editable.
  "user-uploads.perchance.org",
  "esm.sh",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  "huggingface.co",
  "hf.co",
  "xethub.hf.co",
  "googleapis.com",
  "gstatic.com",
  "bigger.pics",
  "raw.githubusercontent.com",
];

function isPerchanceHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (EXACT_HOSTS.has(h)) return true;
  return SUFFIX_HOSTS.some((s) => h === s || h.endsWith("." + s));
}

function isGoogleHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return h === "google.com" || /(^|\.)google\.[a-z.]+$/.test(h) ||
    h.endsWith(".gstatic.com") || h.endsWith(".googleapis.com") ||
    h.endsWith(".googleusercontent.com");
}

function isAllowedUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return true; }         // data:, blob:, about:
  if (u.protocol === "ws:" || u.protocol === "wss:") return isPerchanceHost(u.hostname) || isCloudflareChallengeHost(u.hostname);
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  return isPerchanceHost(u.hostname) || isGoogleHost(u.hostname);
}

function isCloudflareChallengeHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  return h === "challenges.cloudflare.com" || h.endsWith(".challenges.cloudflare.com") ||
    h === "challenge.cloudflare.com" || h.endsWith(".challenge.cloudflare.com") ||
    h === "turnstile.cloudflare.com";
}

// ===========================================================================
// 2. Descargas — la única parte que de verdad importa para "no me deja guardar"
// ===========================================================================
//
// POR QUÉ FALLABA: el botón ⬇️ no navega a ninguna URL. Crea
//   <a href="blob:..." download="imagen.jpg">  y le hace .click()
// (text-to-image / t2i-framework-plugin-v2 y create-media-gallery-plugin).
// Eso NO es navegación: dispara el evento 'will-download' del WebContents.
// Tres formas de matarlo en silencio:
//   a) contents.session.on('will-download', e => e.preventDefault())  <-- plantilla
//      "navegador súper estricto" que casi todos copian. Mata TODO.
//   b) registrar el handler en la session por defecto mientras la vista corre en
//      partition:"persist:perchance" -> tu handler nunca se ejecuta.
//   c) no fijar ruta: si no hay carpeta de descargas / no hay diálogo posible
//      (kiosco, ventana sin foco, entorno sin ~/Downloads), Chromium cancela.
//
// El evento 'will-download' es SÍNCRONO: lo que no fijes ahí, no pasa después.

const DEFAULT_FOLDER = path.join(app.getPath ? app.getPath("downloads") : process.cwd(), "Perchance");

function downloadFolder(folder = DEFAULT_FOLDER) {
  try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { console.error("[perchance] no pude crear", folder, e); }
  return folder;
}

function sanitizeFilename(name) {
  return (name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || `perchance-${Date.now()}`;
}

function installPerchanceDownloads(partition = PERCHANCE_PARTITION, opts = {}) {
  const { folder = DEFAULT_FOLDER, onEvent = () => {} } = opts;
  const ses = session.fromPartition(partition);
  const dir = downloadFolder(folder);

  ses.setDownloadPath(dir); // fallback a nivel de session

  // Diagnóstico: si ya hay otro listener, alguien más está en el pipeline.
  if (ses.listenerCount && ses.listenerCount("will-download") > 0) {
    console.warn("[perchance] AVISO: ya existe otro listener 'will-download' en esta session. " +
      "Si alguno llama a event.preventDefault()/item.cancel(), las descargas se cancelan.");
  }

  ses.on("will-download", (event, item) => {
    // (a) NUNCA preventDefault/cancel aquí en el camino normal.
    const url = item.getURL();
    if (!/^(blob|data):/i.test(url) && !isAllowedUrl(url)) {
      console.warn("[perchance] descarga fuera de allowlist:", url);
      item.cancel();
      return;
    }

    const filename = sanitizeFilename(item.getFilename());
    const fullPath = path.join(dir, filename);

    // (c) RUTA SÍNCRONA = descarga garantizada, sin diálogo, sin depender del SO.
    item.setSavePath(fullPath);

    onEvent({ type: "start", url, filename, path: fullPath, totalBytes: item.getTotalBytes() });

    item.on("updated", (_e, state) => {
      onEvent({ type: "progress", state, filename, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
    });
    item.once("done", (_e, state) => {
      const ok = state === "completed";
      if (!ok) console.warn("[perchance] descarga NO completada:", state, url);
      onEvent({ type: "done", state, filename, path: fullPath, success: ok });
    });
  });

  return ses;
}

// ===========================================================================
// 3. Red + permisos del panel
// ===========================================================================

const PERMISSIONS_TO_ALLOW = new Set([
  "fullscreen", "pointerLock", "clipboard-read", "clipboard-sanitized-write",
  "display-capture", "media", "notifications", "background-sync",
  "idle-detection", "gamepad", "hid", "usb", "serial", "midi", "midiSysex",
  "speaker-selection",
]);

function installPerchanceNetwork(partition = PERCHANCE_PARTITION) {
  const ses = session.fromPartition(partition);
  // No tocar cookies, localStorage ni IndexedDB: solo retirar caches persistentes
  // que pueden dejar una versión vieja del generador atrapada entre reinicios.
  ses.clearCache().catch(() => {});
  ses.clearStorageData({ storages: ["cachestorage", "serviceworkers"] }).catch(() => {});
  const nativeUA = session.defaultSession.getUserAgent();

  // Allowlist: cancela lo ajeno, deja pasar el frame raíz para no romper la barra.
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (d, cb) => {
    if (isAllowedUrl(d.url)) return cb({ cancel: false });
    cb({ cancel: d.resourceType !== "mainFrame" });
  });

  // Quita CSP / XFO / COEP en respuestas de Perchance.
  // El motor de Perchance define funciones con <script> inyectado en <head> y
  // evalúa bloques con eval(`with(root){...}`) -> cualquier CSP lo mata.
  ses.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (d, cb) => {
    const fromPerchance = isPerchanceHost(safeHost(d.url)) || isPerchanceHost(d.frameOrigin);
    if (!fromPerchance) return cb({});
    const headers = { ...(d.responseHeaders || {}) };
    const drop = [
      "content-security-policy", "content-security-policy-report-only",
      "x-frame-options", "x-content-type-options",
      "cross-origin-opener-policy", "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
    ];
    for (const k of Object.keys(headers)) if (drop.includes(k.toLowerCase())) delete headers[k];
    cb({ responseHeaders: headers });
  });

  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS_TO_ALLOW.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => PERMISSIONS_TO_ALLOW.has(permission));

  // Perchance, Google y Turnstile usan la identidad nativa de Electron/Chromium.
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
    const headers = { ...(d.requestHeaders || {}) };
    const host = safeHost(d.url);
    headers['User-Agent'] = nativeUA;
    cb({ requestHeaders: headers });
  });

  return ses;
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ""; } }

// ===========================================================================
// 4. Panel dedicado
// ===========================================================================

function createPerchancePanel({ win, bounds = { x: 0, y: 0, width: 1000, height: 800 }, url = "https://perchance.org/4cffvbcm0c", onDownload = () => {} }) {
  installPerchanceNetwork(PERCHANCE_PARTITION);
  installPerchanceDownloads(PERCHANCE_PARTITION, { onEvent: onDownload });

  const view = new WebContentsView({
    webPreferences: {
      partition: PERCHANCE_PARTITION,   // aislado del resto de la app
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      // NO pongas preload que reescriba window.open/fetch: el panel se habla
      // por postMessage entre orígenes distintos y el motor inyecta <script>.
    },
  });

  win.contentView.addChildView(view);
  view.setBounds(bounds);

  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: "allow" }));  // popups/enlaces de Perchance
  wc.on("will-navigate", () => {});                      // sin preventDefault: la navegación
                                                          // entre subdominios es normal aquí
  wc.loadURL(url);

  return {
    view,
    webContents: wc,
    session: wc.session,
    openDownloaded: (filePath) => shell.showItemInFolder(filePath),
    openFile: (filePath) => shell.openPath(filePath),
    load: (u) => wc.loadURL(u),
    destroy: () => { try { win.contentView.removeChildView(view); view.webContents.close(); } catch {} },
  };
}

// ===========================================================================
// 5. Compatibilidad con <webview> de renderer
// ===========================================================================
// Si en vez de WebContentsView usas la etiqueta <webview>, la ventana anfitriona
// necesita webPreferences.webviewTag = true, y el elemento:
//
//   <webview src="https://perchance.org/" partition="persist:perchance"
//            allowpopups
//            webpreferences="contextIsolation=yes,sandbox=yes,backgroundThrottling=no">
//
// El pipeline de descargas sigue siendo el de la partition, así que basta con
// llamar installPerchanceDownloads()/installPerchanceNetwork() en main (una vez).
// OJO: si te olvidas del atributo partition, la webview usa la session por
// defecto y ahí tu capa estricta ya tiene registrado su cancelador.

module.exports = {
  PERCHANCE_PARTITION,
  isPerchanceHost,
  isAllowedUrl,
  isGoogleHost,
  installPerchanceDownloads,
  installPerchanceNetwork,
  createPerchancePanel,
  downloadFolder,
  DEFAULT_FOLDER,
};

// ===========================================================================
// CHECKLIST para "sigue sin descargar"
// ===========================================================================
// 1. Busca en tu app (antes de tocar nada):
//      grep -rn "will-download" src/
//    Si algo hace preventDefault() o item.cancel()  -> ese es el culpable.
//    Igual con:
//      app.on("web-contents-created", (e, wc) => wc.session.on("will-download", e => e.preventDefault()))
//    y con `webPreferences: { ... }` con "disableDialogs" / kiosco.
//
// 2. Comprueba que el handler ve el evento. Añade un console.log y prueba el
//    botón ️. Si NO aparece:
//       - el panel no está en partition:"persist:perchance"
//       - o el botón que pulsas es el de un iframe (image-generation.perchance.org)
//         y estás enviando el clic al frame equivocado.
//
// 3. Si aparece "start" pero luego "done" con state != "completed", el problema
//    es de escritura (carpeta inexistente / permisos / cuota). El log te da state.
//
// 4. Verifica que se descarga: añade onDownload y mira en consola:
//      start {filename, path, totalBytes} -> progress -> done {success:true}
//
// 5. Para comprobar sin UI, en cualquier momento:
//      require("./perchance-panel").installPerchanceDownloads();
//      // y luego click en el botón desde devtools del panel.
// ===========================================================================