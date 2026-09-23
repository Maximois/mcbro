// perchance-panel.js
// Módulo AISLADO para el panel dedicado de Perchance.
// Vive fuera de tus restricciones: su propia partition persistente aislada, su propia session,
// su propia allowlist, su propio pipeline de descargas.
//
//   const { createPerchancePanel } = require("./perchance-panel");
//   const panel = createPerchancePanel({ win, bounds: {x:0,y:0,width:900,height:700} });
//   panel.view.webContents.loadURL("https://perchance.org/mi-generador");
//
// Sustituye al módulo anterior (perchance-network-module.js). Todo aquí es
// autocontenido: no necesita que toques la session por defecto de la app.
//
// ── NO TOCAR SANDBOX ────────────────────────────────────────────────────────
// Perchance (y el script de Cloudflare) crean frames auxiliares about:blank /
// srcdoc para burbujas, modales (ⓘ) y widgets. Chromium los ejecuta según el
// atributo sandbox del iframe padre. Si una capa "navegador estricto" reescribe
// o limpia esos atributos, el frame muere EN SILENCIO ("Blocked script
// execution in 'about:blank' ... sandboxed and the 'allow-scripts' permission
// is not set") y con él toda la parte interactiva que los usa. Aquí NO hay que
// modificar ningún atributo sandbox/allow de los frames del sitio.
//   - sin allow-scripts   → se cae la burbuja/widget
//   - sin allow-modals    → los ⓘ no abren
//   - sin allow-downloads → no descarga blob/data
//   - sin allow-same-origin → se rompe el almacenamiento/scratchpad
// Si ves "Blocked script execution" en consola, busca QUIÉN reescribe el
// sandbox del guion de la web (CSS/pageScripts/security wizard), no lo "arregles"
// cambiando webPreferences.sandbox del webview.
// ─────────────────────────────────────────────────────────────────────────────

const { app, session, WebContentsView, shell, webFrameMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { shouldAutoClearPerchanceStorage } = require("../lib/perchance");
const { startLocalProxy } = require("./perchance-proxy");

const PERCHANCE_PARTITION = "persist:perchance-clean";

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
  "cloudflare.com",
  "cloudflareinsights.com",
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
  let h = String(host).toLowerCase().replace(/\.$/, "");
  // frameOrigin / Origin a veces llegan como URL completa.
  if (h.includes("://")) {
    try { h = new URL(h).hostname; } catch { /* keep h */ }
  }
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

// Proxy local singleton: arranca una vez, apunta cada session de Perchance a
// él. Resolver por DNS del sistema es la única manera de escapar del DoH
// global estricto sin tocar la configuración de red del resto de la app.
let proxyPromises = new Map(); // partition -> Promise<port> (proxy local singleton)
function createPerchanceProxy(partition = PERCHANCE_PARTITION) {
  const ses = session.fromPartition(partition);
  if (!proxyPromises.has(partition)) {
    const p = startLocalProxy().then(({ port }) => {
      ses.setProxy({ proxyRules: `http://127.0.0.1:${port}` }).catch((e) => {
        console.warn("[perchance] error al configurar proxy local:", e.message);
      });
      return port;
    });
    proxyPromises.set(partition, p);
  }
  return proxyPromises.get(partition);
}

function installPerchanceNetwork(partition = PERCHANCE_PARTITION, opts = {}) {
  const ses = session.fromPartition(partition);
  // Red directa NO es suficiente: el resolver de Chromium es global (DoH
  // estricto de app.configureHostResolver). Si el DoH no resuelve un host del
  // ecosistema Perchance, Chromium cae con ERR_NAME_NOT_RESOLVED sin fallback.
  // Un proxy local exclusivo resuelve por el DNS del sistema (fuera del DoH)
  // y tunela CONNECT/HTTP/WS — la doc PERCHANCE-ARCHITECTURE.md lo exige.
  createPerchanceProxy().catch((e) => {
    console.warn("[perchance] no pude levantar el proxy local:", e.message);
  });

  // UA Chrome real del motor (sin mentir la major). Perchance mira UA y
  // navigator.webdriver; un Chrome inventado hace que sirva features que el
  // motor no soporta. La app ya pone --disable-blink-features=AutomationControlled.
  const chromeMajor = (process.versions && process.versions.chrome
    ? process.versions.chrome.split(".")[0] : "124");
  try {
    ses.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
    );
  } catch (e) {
    console.warn("[perchance] no pude fijar UA:", e.message);
  }

  const autoClear = shouldAutoClearPerchanceStorage({
    force: process.env.MC_PERCHANCE_CLEAR_STORAGE === '1' || process.argv.includes('--perchance-clear-storage')
  });

  // Por defecto no borramos el almacenamiento persistente del panel. Perchance
  // guarda trabajos del usuario y Scratchpad en localStorage/IndexedDB; limpiarlo
  // al arrancar hace que Chromium muestre exactamente el aviso de "not allowing
  // scratchpad/input text to be permanently stored".
  if (autoClear) {
    ses.clearCache().catch(() => {});
    ses.clearStorageData({ storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage", "shadercache", "websql"] }).catch(() => {});
  }

  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS_TO_ALLOW.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => PERMISSIONS_TO_ALLOW.has(permission));

  // Diagnóstico únicamente: nunca cancela recursos. Sirve para identificar
  // la URL concreta detrás de ERR_ADDRESS_INVALID u otro fallo de red.
  ses.webRequest.onErrorOccurred({ urls: ["*://*/*"] }, (d) => {
    console.warn("[perchance][resource-error]", d.error, d.resourceType, d.url);
  });

  if (process.env.MC_PCH_DIAG === '1') {
    ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (d, cb) => {
      if (d.resourceType === 'image' || d.resourceType === 'fetch' || d.resourceType === 'xhr' || d.resourceType === 'mainFrame' || d.resourceType === 'subFrame') {
        console.log("[PCH-IMG][req]", d.resourceType, d.url.length > 180 ? d.url.slice(0, 180) + '...' : d.url);
      }
      cb({});
    });
    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => {
      if (d.resourceType === 'image' || d.resourceType === 'fetch' || d.resourceType === 'xhr') {
        console.log("[PCH-IMG][done]", d.statusCode, d.resourceType, (d.url || '').slice(0, 180));
      }
    });
  }

  // El documento principal puede declarar CSP/XFO/COEP para bloquear los
  // plugins e iframes externos que usan los generadores.
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

  return ses;
}

// ===========================================================================
// 3b. Limpieza de datos del panel (caché, cookies, storage)
// ===========================================================================

async function clearPerchanceData(partition = PERCHANCE_PARTITION, opts = {}) {
  const ses = session.fromPartition(partition);
  const settings = {
    cache: opts.cache !== false,
    cookies: opts.cookies !== false,
    storage: opts.storage !== false,
  };
  const results = { ok: true, settings };
  try {
    if (settings.cache) { await ses.clearCache(); results.cache = true; }
  } catch (e) { results.cache = false; results.error = e.message; }
  try {
    if (settings.cookies) {
      await ses.cookies.flushStore();
      const cookies = await ses.cookies.get({});
      for (const c of cookies) {
        const domain = String(c.domain || '').replace(/^\./, '');
        const scheme = c.secure !== false ? 'https' : 'http';
        const p = String(c.path || '/');
        await ses.cookies.remove(`${scheme}://${domain}${p.startsWith('/') ? p : '/' + p}`, c.name).catch(() => {});
      }
      results.cookies = true;
    }
  } catch (e) { results.cookies = false; results.error = e.message; }
  try {
    if (settings.storage) {
      await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache', 'websql'] });
      results.storage = true;
    }
  } catch (e) { results.storage = false; results.error = e.message; }
  return results;
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ""; } }

// ===========================================================================
// 3c. alert/confirm → toast in-page (no diálogo nativo del SO)
// ===========================================================================
// Los ⓘ usan alert(); la galería NSFW usa confirm(+18) desde iframes chicos
// (image-generation.perchance.org). En Electron eso sale como diálogo modal
// "Una página insertada…". Lo reemplazamos por toast HTML suave.
// Avisos +18: toast + return true (return false abortaba el iframe gallery).
// Otros confirm: toast en el frame top + re-click. prompt() sigue nativo.

const ALERT_BUBBLE_SCRIPT = `(() => {
  try {
    if (window.__mcPchDialogBubbles === 4) return 'already';
    window.__mcPchDialogBubbles = 4;
    const CSS = \`
#mc-pch-toast-root{position:fixed;inset:auto 12px 12px auto;z-index:2147483646;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none;max-width:min(400px,calc(100vw - 24px));font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.mc-pch-toast{pointer-events:auto;background:#1b1f24;color:#e8eaed;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);padding:10px 12px 10px 14px;display:flex;flex-direction:column;gap:10px;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;max-width:100%}
.mc-pch-toast.show{opacity:1;transform:translateY(0)}
.mc-pch-toast-row{display:flex;gap:10px;align-items:flex-start}
.mc-pch-toast-msg{flex:1;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto}
.mc-pch-toast-x{flex:none;border:0;background:transparent;color:#9aa0a6;cursor:pointer;font-size:16px;line-height:1;padding:0 2px}
.mc-pch-toast-x:hover{color:#fff}
.mc-pch-toast-actions{display:flex;gap:8px;justify-content:flex-end}
.mc-pch-toast-btn{border:0;border-radius:8px;padding:6px 12px;font:12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer}
.mc-pch-toast-btn.cancel{background:rgba(255,255,255,.08);color:#c5c8ce}
.mc-pch-toast-btn.cancel:hover{background:rgba(255,255,255,.14)}
.mc-pch-toast-btn.ok{background:#3b82f6;color:#fff}
.mc-pch-toast-btn.ok:hover{background:#2563eb}
.mc-pch-toast.warn{border-color:rgba(251,191,36,.35)}
\`;
    const ensureRoot = () => {
      let root = document.getElementById('mc-pch-toast-root');
      const style = document.getElementById('mc-pch-toast-style');
      if (style) style.textContent = CSS;
      else {
        const s = document.createElement('style');
        s.id = 'mc-pch-toast-style';
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
      }
      if (root) return root;
      root = document.createElement('div');
      root.id = 'mc-pch-toast-root';
      (document.body || document.documentElement).appendChild(root);
      return root;
    };
    const dismiss = (el) => {
      try {
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch {} }, 200);
      } catch {}
    };
    const showAlert = (raw) => {
      try {
        const root = ensureRoot();
        const el = document.createElement('div');
        el.className = 'mc-pch-toast';
        const row = document.createElement('div');
        row.className = 'mc-pch-toast-row';
        const msg = document.createElement('div');
        msg.className = 'mc-pch-toast-msg';
        msg.textContent = String(raw == null ? '' : raw);
        const btn = document.createElement('button');
        btn.className = 'mc-pch-toast-x';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Cerrar');
        btn.textContent = '×';
        btn.onclick = () => dismiss(el);
        row.appendChild(msg);
        row.appendChild(btn);
        el.appendChild(row);
        root.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        const ms = Math.min(14000, Math.max(4200, 2800 + String(raw || '').length * 18));
        setTimeout(() => dismiss(el), ms);
      } catch {}
    };
    let confirmOpen = null;
    const showConfirmLocal = (raw, onPick) => {
      try {
        if (confirmOpen) {
          try { confirmOpen(false); } catch {}
          confirmOpen = null;
        }
        const root = ensureRoot();
        const el = document.createElement('div');
        el.className = 'mc-pch-toast warn';
        const row = document.createElement('div');
        row.className = 'mc-pch-toast-row';
        const msg = document.createElement('div');
        msg.className = 'mc-pch-toast-msg';
        msg.textContent = String(raw == null ? '' : raw);
        row.appendChild(msg);
        const actions = document.createElement('div');
        actions.className = 'mc-pch-toast-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'mc-pch-toast-btn cancel';
        cancel.textContent = 'Cancelar';
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.className = 'mc-pch-toast-btn ok';
        ok.textContent = 'Aceptar';
        const finish = (value) => {
          if (confirmOpen !== finish) return;
          confirmOpen = null;
          dismiss(el);
          try { onPick(!!value); } catch {}
        };
        confirmOpen = finish;
        cancel.onclick = () => finish(false);
        ok.onclick = () => finish(true);
        actions.appendChild(cancel);
        actions.appendChild(ok);
        el.appendChild(row);
        el.appendChild(actions);
        root.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        try { ok.focus(); } catch {}
      } catch {
        try { onPick(false); } catch {}
      }
    };
    const isTop = () => {
      try { return window.top === window; } catch { return true; }
    };
    const pendingById = new Map();
    window.addEventListener('message', (ev) => {
      try {
        const d = ev && ev.data;
        if (!d || d.source !== 'mc-pch') return;
        if (d.type === 'mc-pch-confirm' && isTop()) {
          showConfirmLocal(d.message, (ok) => {
            try {
              ev.source && ev.source.postMessage({ source: 'mc-pch', type: 'mc-pch-confirm-result', id: d.id, ok: !!ok }, '*');
            } catch {}
          });
          return;
        }
        if (d.type === 'mc-pch-confirm-result' && d.id && pendingById.has(d.id)) {
          const cb = pendingById.get(d.id);
          pendingById.delete(d.id);
          try { cb(!!d.ok); } catch {}
        }
      } catch {}
    });
    const requestConfirmToast = (message, onPick) => {
      if (isTop()) {
        showConfirmLocal(message, onPick);
        return;
      }
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      pendingById.set(id, onPick);
      try {
        window.top.postMessage({ source: 'mc-pch', type: 'mc-pch-confirm', id, message: String(message == null ? '' : message) }, '*');
      } catch {
        pendingById.delete(id);
        showConfirmLocal(message, onPick);
        return;
      }
      setTimeout(() => {
        if (!pendingById.has(id)) return;
        pendingById.delete(id);
        showConfirmLocal(message, onPick);
      }, 800);
    };
    document.addEventListener('pointerdown', (e) => {
      try {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#mc-pch-toast-root')) return;
        window.__mcPchLastClickEl = t.closest('button, a, [role="button"], input[type="button"], input[type="submit"], summary, label') || t;
      } catch {}
    }, true);
    window.alert = function (message) { showAlert(message); };
    window.confirm = function (message) {
      if (typeof window.__mcPchConfirmNext === 'boolean') {
        const v = window.__mcPchConfirmNext;
        window.__mcPchConfirmNext = undefined;
        return v;
      }
      const msg = String(message == null ? '' : message);
      // Aviso +18: devolver false cancela la carga del iframe gallery
      // (ERR_ABORTED + pantalla gris). Toast informativo + true = suave y
      // no rompe la galería.
      if (/WARNING|over\\s*18|adult themes|young viewers|inappropriate for young/i.test(msg)) {
        showAlert(msg);
        return true;
      }
      const clickEl = window.__mcPchLastClickEl;
      if (!clickEl) {
        showAlert(msg);
        return true;
      }
      requestConfirmToast(msg, (ok) => {
        if (!ok) return;
        window.__mcPchConfirmNext = true;
        try {
          if (typeof clickEl.click === 'function') clickEl.click();
        } catch {
          window.__mcPchConfirmNext = undefined;
        }
      });
      return false;
    };
    return 'installed';
  } catch (e) { return 'fail ' + String(e && e.message || e); }
})()`;

function installPerchanceAlertBubbles(partition = PERCHANCE_PARTITION) {
  const targetSes = session.fromPartition(partition);
  const injectFrame = (frame) => {
    if (!frame || typeof frame.executeJavaScript !== 'function') return;
    try {
      // Evitar executeJavaScript sobre about:blank / mid-nav: aborta subframes.
      if (typeof frame.url === 'string' && (!frame.url || frame.url === 'about:blank')) return;
      frame.executeJavaScript(ALERT_BUBBLE_SCRIPT, true).catch(() => {});
    } catch {}
  };
  const injectAll = (wc) => {
    try {
      const mf = wc.mainFrame;
      if (!mf) return;
      injectFrame(mf);
      for (const f of (mf.framesInSubtree || [])) injectFrame(f);
    } catch {}
  };
  app.on('web-contents-created', (_e, wc) => {
    try {
      if (wc.session !== targetSes) return;
    } catch { return; }
    wc.on('dom-ready', () => injectAll(wc));
    wc.on('did-finish-load', () => injectAll(wc));
    // Solo al terminar cada frame — sin reinyectar el árbol en cada navigate
    // (eso abortaba image-generation/gallery y comments-plugin).
    wc.on('did-frame-finish-load', (_ev, isMainFrame, frameProcessId, frameRoutingId) => {
      try {
        const frame = webFrameFromIds(wc, frameProcessId, frameRoutingId);
        if (frame) injectFrame(frame);
        else if (isMainFrame) injectAll(wc);
      } catch {
        if (isMainFrame) injectAll(wc);
      }
    });
  });
}

function webFrameFromIds(wc, processId, routingId) {
  try {
    if (webFrameMain && typeof webFrameMain.fromId === 'function' && processId != null && routingId != null) {
      const frame = webFrameMain.fromId(processId, routingId);
      if (frame) return frame;
    }
  } catch {}
  try {
    const mf = wc.mainFrame;
    if (!mf) return null;
    if (mf.processId === processId && mf.routingId === routingId) return mf;
    for (const f of (mf.framesInSubtree || [])) {
      if (f && f.processId === processId && f.routingId === routingId) return f;
    }
  } catch {}
  return null;
}

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
  installPerchanceAlertBubbles,
  clearPerchanceData,
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