'use strict';

const { app, BrowserWindow, session, ipcMain, shell, dialog, Notification, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { isAggressiveAdNavigation, isTrustedResource, isVideoHost } = require('./modules/adblocker/main');

// Unique data folder per build: dev and installed app keep separate data
const DATA_DIR = app.isPackaged ? 'MC Browser' : 'mc-browser-v2-dev';
app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR));

function readGpuAccelerationPref() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'cfg.json');
    if (fs.existsSync(cfgPath)) {
      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return saved.gpuAcceleration === true;
    }
  } catch {}
  return false;
}

// Debe ejecutarse antes de app.ready; por defecto desactivada.
const GPU_RUNTIME_ACTIVE = readGpuAccelerationPref();
if (!GPU_RUNTIME_ACTIVE) {
  try { app.disableHardwareAcceleration(); } catch (e) { console.warn('[GPU]', e.message); }
}

// ✅ LOGIN WORKS: solo esta flag, nada más
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ── Stream / Media detection ────────────────────
const MEDIA_RE = /\.(m3u8|mp4|webm|mpd|ts|m4s|mkv|avi|mov)(\?|#|$)/i;
const HLS_RE   = /\.m3u8(\?|#|$)/i;
const SKIP_EXT_RE = /\.(html?|php|aspx?|jsp|json|xml|css|js|svg|woff2?|ttf|eot)(\?|#|$)/i;

let mainWin;

function normalizeSiteHost(url) {
  try {
    const value = String(url || '').trim();
    if (!value || value === 'about:blank') return '';
    return new URL(value).hostname.replace(/^\.+/, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeGlobalBlockPattern(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    const host = new URL(withScheme).hostname.replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host || '';
  } catch {
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host || '';
  }
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.in']);
function baseNavigationDomain(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  const parts = normalized.split('.');
  if (parts.length <= 2) return normalized;
  const suffix = parts.slice(-2).join('.');
  return parts.slice(-(MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2)).join('.');
}

function isSameNavigationSite(sourceUrl, targetUrl) {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);
    if (!/^https?:$/.test(source.protocol) || !/^https?:$/.test(target.protocol)) return true;
    return baseNavigationDomain(source.hostname) === baseNavigationDomain(target.hostname);
  } catch {
    return true;
  }
}

function isExplicitNavigationSite(host) {
  return isAuthDomain(host) || getPermissionRuleForHost(host, 'site') === 'allow';
}

function isExplicitMediaRedirectHost(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  if (!normalized) return false;
  const explicitMediaHosts = [
    'savefiles.com', 'playmogo.com', 'playmogo.net', 'mixdrop.co', 'mixdrop.to', 'miixdrop.top',
    'dood.wf', 'dood.la', 'dood.to', 'doodstream.com', 'voe.sx', 'voe.com',
    'mxdrop.com', 'mxdrop.to', 'lulu.to', 'mp4upload.com', 'streamwish.com', 'streamwish.to',
    'filemoon.to', 'filemoon.sx', 'filemoon.in', 'pixeldrain.com', 'mega.nz'
  ];
  return explicitMediaHosts.some(domain => normalized === domain || normalized.endsWith('.' + domain));
}

function allowNavigationTransition(sourceUrl, targetUrl) {
  try {
    const targetHost = new URL(targetUrl).hostname;
    if (isExplicitMediaRedirectHost(targetHost) || isVideoHost(targetHost)) return true;
    return isSameNavigationSite(sourceUrl, targetUrl) || isExplicitNavigationSite(targetHost);
  } catch {
    return true;
  }
}

function parseGlobalBlockRule(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('*.')) {
    const host = raw.slice(2).replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host ? { host, subdomainOnly: true } : null;
  }
  const host = normalizeGlobalBlockPattern(raw);
  return host ? { host, subdomainOnly: false } : null;
}

function isGlobalBlockMatch(requestHost, documentHost, rule) {
  if (!rule?.host) return false;
  const { host, subdomainOnly } = rule;
  if (subdomainOnly) {
    return requestHost === host || documentHost === host || requestHost.endsWith('.' + host) || documentHost.endsWith('.' + host);
  }
  if (requestHost === host || documentHost === host) return true;
  return requestHost.endsWith('.' + host) || documentHost.endsWith('.' + host);
}

function getPermissionRuleForHost(host, permission) {
  const normalizedHost = String(host || '').trim().replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
  if (!normalizedHost || !CFG.permissions) return null;

  // La UI guarda dominios sin "www"; aplicar la misma regla a sus subdominios.
  const candidates = Object.keys(CFG.permissions)
    .map(rawKey => ({ rawKey, key: String(rawKey).replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase() }))
    .filter(({ key }) => normalizedHost === key || normalizedHost.endsWith('.' + key))
    .sort((a, b) => b.key.length - a.key.length);
  for (const { rawKey } of candidates) {
    const rule = normalizePermissionMap(CFG.permissions[rawKey]);
    if (rule[permission]) return rule[permission];
  }
  return null;
}

function isSitePermissionAllowed(host) {
  return getPermissionRuleForHost(host, 'site') === 'allow';
}

function resolvePermissionDecision(host, permissionKey) {
  const rule = getPermissionRuleForHost(host, permissionKey);
  if (rule === 'allow') return true;
  if (rule === 'deny' || rule === 'block') return false;
  if (['notifications', 'geolocation', 'camera', 'microphone', 'images', 'audio', 'media'].includes(permissionKey)) return false;
  return false;
}

function setupSessionPermissionHandlers(sess) {
  const decide = (host, permission) => resolvePermissionDecision(host, String(permission || '').trim());
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(decide(normalizeSiteHost(webContents?.getURL?.() || ''), permission));
  });
  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const host = normalizeSiteHost(requestingOrigin || webContents?.getURL?.() || '');
    return decide(host, permission);
  });
}

function getAllowlistPolicyForHost(host) {
  const normalized = String(host || '').replace(/^\.+/, '').toLowerCase();
  if (!normalized) return null;
  const list = CFG.allowlist || {};
  if (list[normalized]) return list[normalized];
  if (list['.' + normalized]) return list['.' + normalized];
  for (const [key, policy] of Object.entries(list)) {
    const k = String(key).replace(/^\.+/, '').toLowerCase();
    if (!k) continue;
    if (normalized === k || normalized.endsWith('.' + k)) return policy;
    if (k.endsWith('.' + normalized)) return policy;
  }
  return null;
}

function cookieRemovalUrl(cookie, fallbackHost) {
  const domain = String(cookie?.domain || fallbackHost || '').replace(/^\./, '');
  const cookiePath = String(cookie?.path || '/');
  const secure = cookie?.secure !== false;
  const scheme = secure ? 'https' : 'http';
  return `${scheme}://${domain}${cookiePath.startsWith('/') ? cookiePath : '/' + cookiePath}`;
}

function createRequestGuard() {
  return (details) => {
    try {
      const requestHost = normalizeSiteHost(details?.url || '');
      // Fallback a referrer cuando documentUrl viene vacío (primera navegación)
      const documentHost = normalizeSiteHost(details?.documentUrl || details?.referrer || '');
      const resourceRule = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : [])
        .find(rule => rule && rule.url === details?.url && (!rule.resourceType || rule.resourceType === details?.resourceType));
      if (resourceRule?.action === 'allow') return { allow: true };
      if (resourceRule?.action === 'block') return { cancel: true };
      // Reglas personalizadas:
      //  - site-scoped: SIEMPRE aplican en su sitio (incluso en dominios auth).
      //  - globales: NO aplican en dominios auth (proteger OAuth/login).
      // El bypass de auth solo protege los permisos de contenido (más abajo).
      const customRulesArr = Array.isArray(CFG.customRules) ? CFG.customRules : [];
      const globalBlocks = customRulesArr
        .filter(rule => !rule.site)
        .map(rule => parseGlobalBlockRule(rule && rule.pattern ? rule.pattern : rule))
        .filter(Boolean);
      const siteScopedBlocks = customRulesArr
        .filter(rule => rule.site)
        .map(rule => ({ ...parseGlobalBlockRule(rule && rule.pattern ? rule.pattern : rule), site: rule.site }))
        .filter(r => r && r.host);
      // Sitio/contenedor puede abrir un dominio de la lista de bloqueo manual,
      // pero no implica desactivar adblock ni permisos de contenido en terceros.
      const siteOverridesBlock = isSitePermissionAllowed(requestHost) || isSitePermissionAllowed(documentHost);
      if (!siteOverridesBlock) {
        // Reglas site-scoped: SIEMPRE aplican en su sitio (incluso en dominios auth)
        if (documentHost && siteScopedBlocks.some(rule => {
          if (!rule.site) return false;
          const docBase = baseNavigationDomain(documentHost);
          const siteBase = baseNavigationDomain(rule.site);
          return docBase === siteBase && isGlobalBlockMatch(requestHost, documentHost, rule);
        })) {
          return { cancel: true };
        }
        // Reglas globales: NO aplican en dominios auth (proteger OAuth/login)
        if (!isAuthDomain(requestHost) && !isAuthDomain(documentHost)) {
          if (globalBlocks.some(rule => isGlobalBlockMatch(requestHost, documentHost, rule))) {
            return { cancel: true };
          }
        }
      }

      const resourceType = String(details?.resourceType || '').toLowerCase();
      const isMainFrame = resourceType === 'mainframe' || resourceType === 'main_frame';

      if (CFG.httpsOnly && isMainFrame && /^http:\/\//i.test(details.url || '')) {
        try {
          const parsed = new URL(details.url);
          const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
          if (!local) {
            parsed.protocol = 'https:';
            if (!parsed.port || parsed.port === '80') parsed.port = '';
            return { redirectURL: parsed.toString() };
          }
        } catch {}
      }

      // Permisos de contenido (images/js/audio) se evalúan sobre el documento activo.
      // site:allow en un CDN/request host ya no salta esas reglas en páginas ajenas.
      const host = normalizeSiteHost(details?.documentUrl || details?.url || '');
      if (!host) return null;
      if (isSitePermissionAllowed(host)) return null;

      // La cadena OAuth puede cargar scripts y recursos entre X, x.ai, Google y Grok.
      // Las reglas de permisos de contenido no deben cortar esos recursos.
      if (isAuthDomain(requestHost) || isAuthDomain(documentHost)) return null;

      const imageRule = getPermissionRuleForHost(host, 'images');
      const audioRule = getPermissionRuleForHost(host, 'audio');
      const jsRule = getPermissionRuleForHost(host, 'javascript');
      if ((resourceType === 'image' || resourceType === 'img') && (imageRule === 'deny' || imageRule === 'block')) {
        return { cancel: true };
      }
      if ((resourceType === 'media' || resourceType === 'audio' || resourceType === 'track') && (audioRule === 'deny' || audioRule === 'block')) {
        return { cancel: true };
      }
      if (resourceType === 'script' && (jsRule === 'deny' || jsRule === 'block')) {
        return { cancel: true };
      }
    } catch {}
    return null;
  };
}

function createWindow() {
  const sess = session.fromPartition('persist:mc');
  setupSessionPermissionHandlers(sess);

  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:mc',
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      sandbox: true,
      enableRemoteModule: false,
      webviewTag: true
    }
  });

  mainWin.loadFile(path.join(__dirname, 'src', 'renderer.html'));
  mainWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
      mainWin.webContents.openDevTools({ mode: 'detach' });
    }
  });
  // ── Hot-reload en modo dev ──
  if (process.env.MC_DEV === '1' && process.env.MC_HOT_RELOAD === '1') {
    let _reloadTimer = null;
    const watchPaths = [
      path.join(__dirname, 'src'),
      path.join(__dirname, 'modules'),
      path.join(__dirname, 'preload.js')
    ];
    const scheduleReload = () => {
      if (_reloadTimer) clearTimeout(_reloadTimer);
      _reloadTimer = setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) {
          console.log('[DEV] Hot-reload: recargando renderer...');
          mainWin.webContents.reloadIgnoringCache();
        }
      }, 300);
    };
    for (const p of watchPaths) {
      try {
        fs.watch(p, { recursive: true }, (evt, filename) => {
          if (filename && !filename.endsWith('.backup')) scheduleReload();
        });
      } catch {}
    }
    console.log('[DEV] Hot-reload activo para:', watchPaths.join(', '));
  }
}

// === UA ===
// Global: identidad nativa de Electron/Chromium (sin override).
// WhatsApp: regla especial — UA Chrome reciente que WhatsApp acepta.
const UA_WHATSAPP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// === AUTH DOMAINS (nunca bloquear estos) ===
const AUTH_DOMAINS = [
  'login.microsoftonline.com', 'login.live.com', 'login.windows.net',
  'accounts.google.com', 'accounts.youtube.com', 'oauth.googleusercontent.com',
  'google.com', 'www.google.com', 'gmail.com', 'mail.google.com',
  'googleusercontent.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com',
  'youtube.com', 'www.youtube.com', 'myaccount.google.com', 'meet.google.com',
  'drive.google.com', 'docs.google.com', 'slides.google.com', 'sheets.google.com',
  'chat.google.com', 'maps.google.com', 'play.google.com', 'accounts.google.com',
  'login.skype.com', 'graph.windows.net', 'appleid.apple.com', 'idmsa.apple.com',
  'auth0.com', 'github.com', 'api.github.com', 'copilot.microsoft.com',
  'api.copilot.microsoft.com', 'chatgpt.com', 'auth.openai.com', 'api.openai.com',
  'claude.ai', 'api.anthropic.com', 'grok.com', 'www.grok.com', 'auth.grok.com',
  'api.grok.com', 'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
  'api.x.com', 'oauth.x.com', 'auth.x.com', 'mobile.x.com', 'support.x.com',
  'x.ai', 'www.x.ai', 'accounts.x.ai', 'api.x.ai', 'oauth.x.ai', 'auth.x.ai', 'login.x.ai',
  'api.twitter.com', 'mobile.twitter.com', 'auth.twitter.com', 'id.twitter.com',
  'abs.twimg.com', 'pbs.twimg.com', 'video.twimg.com', 'twimg.com'
];

function isAuthDomain(host) {
  const normalized = String(host || '').toLowerCase().replace(/^\.+/, '');
  if (!normalized) return false;
  return AUTH_DOMAINS.some(domain => normalized === domain || normalized.endsWith('.' + domain));
}

function isAuthRedirectFlow(targetHost, documentHost) {
  const host = String(targetHost || '').toLowerCase().replace(/^\.+/, '');
  const doc = String(documentHost || '').toLowerCase().replace(/^\.+/, '');
  if (!host && !doc) return false;
  return isAuthDomain(host) || isAuthDomain(doc) ||
    (host && doc && (host.includes('google') && doc.includes('google')))
    || (host && doc && (host.includes('x.ai') || host.includes('x.com') || host.includes('twitter.com')) && (doc.includes('grok.com') || doc.includes('x.ai') || doc.includes('x.com') || doc.includes('twitter.com')))
    || (host && doc && (host.includes('x.com') || host.includes('twitter.com')) && (doc.includes('grok.com') || doc.includes('x.com') || doc.includes('twitter.com')))
    || (host && doc && (host.includes('grok.com') || host.includes('google') || host.includes('x.ai') || host.includes('x.com') || host.includes('twitter.com')) && (doc.includes('grok.com') || doc.includes('google') || doc.includes('x.ai') || doc.includes('x.com') || doc.includes('twitter.com')));
}
function isAuthPopupUrl(rawUrl) {
  try {
    return isAuthDomain(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

// === Module action references (set after whenReady) ===
const ACTIONS = { adblockToggle: null, emit: null };

// === DoH server URL map ===
const DOH_SERVERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
  nextdns: 'https://dns.nextdns.io/dns-query',
  adguard: 'https://dns.adguard.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
};

function applyDoH() {
  try {
    if (CFG.dohEnabled) {
      const url = DOH_SERVERS[CFG.dohServer] || DOH_SERVERS.cloudflare;
      app.configureHostResolver({
        enableBuiltInResolver: true,
        secureDnsMode: CFG.dohStrict !== false ? 'secure' : 'automatic',
        secureDnsServers: [url]
      });
    } else {
      app.configureHostResolver({ secureDnsMode: 'off' });
    }
  } catch (e) { console.error('[DoH]', e.message); }
}

function applyCookiePolicy(policy) {
  if (policy === 'session') {
    try {
      const s = session.fromPartition('persist:mc');
      s.cookies.get({}).then(cookies => {
        for (const c of cookies) {
          const host = String(c.domain || '').replace(/^\.+/, '').toLowerCase();
          const allowPolicy = getAllowlistPolicyForHost(host);
          if (isAuthDomain(host) || allowPolicy === 'allow') continue;
          if (c.session === false) {
            s.cookies.remove(cookieRemovalUrl(c), c.name).catch(() => {});
          }
        }
      }).catch(() => {});
    } catch (e) { console.error('[CK]', e.message); }
  }
}

// === CFG PERSISTENCE (no toca UA ni sesión) ===
const CFG_PATH = path.join(app.getPath('userData'), 'cfg.json');
let CFG = {
  blockAds: true, blockTrackers: false, blockThirdParty: false,
  strictDomainIsolation: true,
  strictDomainIsolationVersion: 2,
  dohStrict: true,
  spoofUA: false, blockFingerprint: false,
  gpuAcceleration: false,
  cookiePolicy: 'allow-all', dohEnabled: false, dohServer: 'cloudflare',
  proxyEnabled: false, proxyType: 'socks5', proxyHost: '', proxyPort: 1080,
  mediaDetect: false, httpsOnly: true,
  currentUA: 'win-chrome', rotateUA: false,
  language: '', refererPolicy: '',
  downloadDir: '', allowlist: {}, customRules: [], permissions: {}, resourceRules: [], userCosmeticRules: [],
  aiConfig: {
    provider: 'ollama', ollamaUrl: 'http://localhost:11434', ollamaModel: 'qwen2.5:1.5b',
    openaiKey: '', openaiModel: 'gpt-4o',
    geminiKey: '', geminiModel: 'gemini-2.0-flash',
    groqKey: '', groqModel: 'mixtral-8x7b-32768',
    opencodeKey: '', opencodeModel: 'opencode-zen-1'
  }
};
function loadCfg() {
  try {
    if (fs.existsSync(CFG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      CFG = { ...CFG, ...saved };
      if (saved.aiConfig) CFG.aiConfig = { ...CFG.aiConfig, ...saved.aiConfig };
      if (saved.strictDomainIsolationVersion === undefined || saved.strictDomainIsolationVersion < 2) {
        CFG.strictDomainIsolation = true;
        CFG.strictDomainIsolationVersion = 2;
        saveCfg();
      }
      if (CFG.gpuAcceleration !== true) CFG.gpuAcceleration = false;
    }
  } catch {}
}
function saveCfg() {
  try {
    const dir = path.dirname(CFG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
  } catch (e) {
    console.error('[CFG] Error saving:', e.message);
  }
}
loadCfg();

// === REGLAS NATIVAS SITE-SCOPED (publicidad en YouTube) ===
// Se aplican solo dentro de youtube.com para no interferir en otros sitios.
const DEFAULT_SITE_RULES = [
  { pattern: '*.doubleclick.net', action: 'block', site: 'youtube.com' },
  { pattern: '*.googlesyndication.com', action: 'block', site: 'youtube.com' },
  { pattern: 'googleadservices.com', action: 'block', site: 'youtube.com' },
  { pattern: 'static.googleadservices.com', action: 'block', site: 'youtube.com' },
  { pattern: 'adservice.google.com', action: 'block', site: 'youtube.com' },
  { pattern: 'googletagmanager.com', action: 'block', site: 'youtube.com' }
];
function ensureDefaultSiteRules() {
  try {
    if (!Array.isArray(CFG.customRules)) CFG.customRules = [];
    let changed = false;
    for (const rule of DEFAULT_SITE_RULES) {
      // 1. Asegurar la regla site-scoped
      const exists = CFG.customRules.some(r => r && r.pattern === rule.pattern && r.site === rule.site);
      if (!exists) {
        CFG.customRules.push(rule);
        changed = true;
      }
      // 2. Convertir reglas globales del mismo patrón a site-scoped (no interferir en otros sitios)
      const globalRules = CFG.customRules.filter(r => r && r.pattern === rule.pattern && !r.site);
      for (const gr of globalRules) {
        CFG.customRules = CFG.customRules.filter(r => r !== gr);
        changed = true;
      }
    }
    // 3. Eliminar reglas globales cubiertas por wildcards site-scoped (ej. static.doubleclick.net cubierto por *.doubleclick.net)
    const siteWildcards = CFG.customRules.filter(r => r && r.site && String(r.pattern).startsWith('*.'));
    const globalRules2 = CFG.customRules.filter(r => r && !r.site);
    for (const gr of globalRules2) {
      const covered = siteWildcards.some(w => {
        const base = String(w.pattern).slice(2).toLowerCase();
        const p = String(gr.pattern).toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
        return p === base || p.endsWith('.' + base);
      });
      if (covered) {
        CFG.customRules = CFG.customRules.filter(r => r !== gr);
        changed = true;
      }
    }
    // 4. Eliminar del allowlist GLOBAL los dominios de publicidad de YouTube,
    //    para que solo apliquen como reglas site-scoped (no mezclar con globales)
    if (CFG.allowlist && typeof CFG.allowlist === 'object') {
      for (const key of Object.keys(CFG.allowlist)) {
        const k = String(key).replace(/^https?:\/\//i, '').split('/')[0].replace(/^\.+/, '').toLowerCase();
        if (!k) continue;
        const covered = DEFAULT_SITE_RULES.some(r => {
          const base = String(r.pattern).replace(/^\*\./, '').toLowerCase();
          return k === base || k.endsWith('.' + base);
        });
        if (covered) {
          delete CFG.allowlist[key];
          changed = true;
        }
      }
    }
    if (changed) saveCfg();
  } catch (e) {
    console.error('[CFG] Error applying default site rules:', e.message);
  }
}
ensureDefaultSiteRules();

// === BOOKMARKS ===
const BOOKMARKS_PATH = path.join(app.getPath('userData'), 'bookmarks.json');
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
let BOOKMARKS = [];
let HISTORY = [];

function loadBookmarks() {
  try {
    if (fs.existsSync(BOOKMARKS_PATH)) {
      BOOKMARKS = JSON.parse(fs.readFileSync(BOOKMARKS_PATH, 'utf8'));
    }
  } catch (e) { console.error('[BOOKMARKS] Load error:', e.message); }
}

function saveBookmarks() {
  try {
    const dir = path.dirname(BOOKMARKS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BOOKMARKS_PATH, JSON.stringify(BOOKMARKS, null, 2), 'utf8');
  } catch (e) { console.error('[BOOKMARKS] Save error:', e.message); }
}

loadBookmarks();

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const stored = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (Array.isArray(stored)) HISTORY = stored.slice(-2000);
    }
  } catch (e) { console.error('[HISTORY] Load error:', e.message); }
}

function saveHistory() {
  try {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(HISTORY.slice(-2000), null, 2), 'utf8');
  } catch (e) { console.error('[HISTORY] Save error:', e.message); }
}

loadHistory();

// === IPC HANDLERS (sin tocar sesión/UA) ===
// Window
ipcMain.handle('win-min', (e) => mainWin?.minimize());
ipcMain.handle('win-max', (e) => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin?.maximize());
ipcMain.handle('win-ismax', (e) => mainWin?.isMaximized() || false);
ipcMain.handle('win-close', (e) => mainWin?.close());
ipcMain.handle('webview:destroy', (_event, webContentsId) => {
  const id = Number(webContentsId);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'ID de webview inválido' };
  try {
    const guest = require('electron').webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return { ok: true, destroyed: false };
    guest.destroy();
    return { ok: true, destroyed: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
function cfgSnapshot() {
  return {
    ...CFG,
    gpuAccelerationActive: GPU_RUNTIME_ACTIVE,
    gpuAccelerationPendingRestart: CFG.gpuAcceleration === true !== GPU_RUNTIME_ACTIVE
  };
}

// Config
ipcMain.handle('get-cfg', () => cfgSnapshot());
ipcMain.handle('update-cfg', (e, patch) => {
  // Mutar CFG existente para que referencias (ctx.cfg en módulos) no queden obsoletas
  Object.assign(CFG, patch);
  if (patch.aiConfig) CFG.aiConfig = { ...CFG.aiConfig, ...patch.aiConfig };
  if ((patch.blockAds !== undefined || patch.blockTrackers !== undefined) && ACTIONS.adblockToggle) {
    ACTIONS.adblockToggle({ ads: CFG.blockAds, trackers: CFG.blockTrackers });
  }
  if (patch.dohEnabled !== undefined || patch.dohServer !== undefined) {
    applyDoH();
  }
  if (patch.cookiePolicy !== undefined) {
    applyCookiePolicy(CFG.cookiePolicy);
  }
  saveCfg();
  return cfgSnapshot();
});
ipcMain.handle('proxy:set', async (_e, settings = {}) => {
  const proxyEnabled = settings.enabled === true;
  const proxyType = String(settings.type || CFG.proxyType || 'socks5').toLowerCase();
  const proxyHost = String(settings.host || '').trim();
  const proxyPort = Number(settings.port || 1080);
  if (proxyEnabled && (!/^(http|https|socks5)$/.test(proxyType) || !proxyHost || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) {
    return { ok: false, error: 'Configuración de proxy inválida' };
  }
  try {
    const proxyRules = proxyEnabled ? `${proxyType}://${proxyHost}:${proxyPort}` : '';
    await session.fromPartition('persist:mc').setProxy(proxyEnabled ? { proxyRules } : { mode: 'direct' });
    Object.assign(CFG, { proxyEnabled, proxyType, proxyHost, proxyPort });
    saveCfg();
    return { ok: true, enabled: proxyEnabled, type: proxyType, host: proxyHost, port: proxyPort };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Stats
let STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
const MEDIA_URLS = [];
const REQ_LOG_TYPES = new Set(['main_frame', 'mainFrame', 'xmlhttprequest', 'fetch', 'websocket', 'manifest', 'script']);
const AD_REQUEST_RE = /doubleclick|googlesyndication|googleadservices|adservice|adsystem|adnxs|adsrvr|rubicon|criteo|pubmatic|openx|casalemedia|moatads|taboola|outbrain|popunder|popads|adserver|advertising|adskeeper|exoclick|adcash|monetag|trafficfactory|prebid|pagead|\/ads?(?:[/?#]|$)|\/advert(?:[/?#]|$)|\/banner(?:[/?#]|$)|\/vast(?:[/?#]|$)/i;
const TRACKER_REQUEST_RE = /analytics|google-analytics|googletagmanager|tracking|tracker|telemetry|pixel|beacon|scorecardresearch|quantserve|demdex|hotjar|clarity\.ms|connect\.facebook|facebook\.net\/tr|fingerprint|session-replay|fullstory|mouseflow|mixpanel|amplitude|matomo|segment\.io/i;
function classifyRequest(url, documentUrl) {
  if (/\.(?:m3u8|ts|m4s|mp4|aac|mp3|webm|mpd)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(url)) return 'media';
  if (AD_REQUEST_RE.test(url)) return 'ads';
  if (TRACKER_REQUEST_RE.test(url)) return 'trackers';
  if (documentUrl && !isTrustedResource(url, documentUrl)) return 'third';
  return 'request';
}
function shouldReportRequest(details) {
  try {
    const rawUrl = details?.url || '';
    const docUrl = details?.documentUrl || details?.referrer || '';
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const docHost = docUrl ? new URL(docUrl).hostname.toLowerCase() : '';
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
    if (isAuthDomain(host) || isAuthDomain(docHost) || isAuthRedirectFlow(host, docHost)) return false;
    if (host.endsWith('.whatsapp.net') || host.endsWith('.whatsapp.com')) return false;
    if (details?.resourceType === 'image' || details?.resourceType === 'stylesheet' || details?.resourceType === 'font' || details?.resourceType === 'media') return false;
    return REQ_LOG_TYPES.has(details?.resourceType);
  } catch {
    return false;
  }
}

function recordBlockedRequest(details, forcedType) {
  const type = forcedType || classifyRequest(details.url, details.documentUrl || details.referrer || '');
  if (forcedType && type === 'ads' && classifyRequest(details.url, details.documentUrl || details.referrer || '') !== 'ads') STATS.detectedAds++;
  if (forcedType && type === 'trackers' && classifyRequest(details.url, details.documentUrl || details.referrer || '') !== 'trackers') STATS.detectedTrackers++;
  if (forcedType && type === 'third' && classifyRequest(details.url, details.documentUrl || details.referrer || '') !== 'third') STATS.detectedThird++;
  if (type === 'ads') STATS.blockedAds++;
  if (type === 'trackers') STATS.blockedTrackers++;
  if (type === 'third') STATS.blockedThird++;
  if (type === 'request') STATS.requestsBlocked++;
  if (mainWin && !mainWin.isDestroyed()) {
    if (details?.resourceType === 'script') {
      mainWin.webContents.send('req-blocked', { type: 'script', resourceType: details.resourceType, blocked: true, url: details.url, msg: details.url });
    }
    mainWin.webContents.send('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart });
  }
}
function recordObservedRequest(details) {
  STATS.totalRequests++;
  if (details.resourceType === 'main_frame' || details.resourceType === 'mainFrame') STATS.pagesLoaded++;
  const type = classifyRequest(details.url, details.documentUrl || details.referrer || '');
  if (type === 'ads') STATS.detectedAds++;
  if (type === 'trackers') STATS.detectedTrackers++;
  if (type === 'third') STATS.detectedThird++;
  if (mainWin && !mainWin.isDestroyed() && shouldReportRequest(details)) {
    const short = details.url.replace(/https?:\/\//, '').substring(0, 80);
    mainWin.webContents.send('req-blocked', { type, resourceType: details.resourceType, blocked: false, url: details.url, msg: short });
    mainWin.webContents.send('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart });
  }
}
ipcMain.handle('get-stats', () => ({ ...STATS, uptime: Date.now() - STATS.uptimeStart }));
ipcMain.handle('reset-stats', () => {
  STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
  MEDIA_URLS.length = 0;
  return { ...STATS };
});
// Sysinfo
ipcMain.handle('get-sysinfo', () => ({
  hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
  cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  uptime: os.uptime(), nodeVersion: process.version, electronVersion: process.versions.electron,
  chromeVersion: process.versions.chrome,
  dlDir: CFG.downloadDir || app.getPath('downloads')
}));
ipcMain.handle('get-processes', async (event) => {
  const contexts = await event.sender.executeJavaScript(`(() => Array.from(document.querySelectorAll('webview')).map(wv => ({
    id: wv.id || '',
    webContentsId: typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : 0,
    url: (() => { try { return wv.getURL() || ''; } catch { return ''; } })()
  })))()`).catch(() => []);
  const contextByPid = new Map();
  for (const context of contexts) {
    try {
      const guest = require('electron').webContents.fromId(Number(context.webContentsId));
      if (guest && !guest.isDestroyed()) {
        // getProcessId() devuelve el ID interno de Chromium; getOSProcessId() el PID real del SO
        const osPid = typeof guest.getOSProcessId === 'function' ? guest.getOSProcessId() : guest.getProcessId();
        if (osPid) contextByPid.set(osPid, context);
      }
    } catch {}
  }
  try {
    const mainRendererPid = mainWin?.webContents ? (typeof mainWin.webContents.getOSProcessId === 'function' ? mainWin.webContents.getOSProcessId() : mainWin.webContents.getProcessId()) : 0;
    if (mainRendererPid) contextByPid.set(mainRendererPid, { role: 'Interfaz principal', url: 'file://renderer.html' });
  } catch {}
  const roleFor = (metric) => {
    const context = contextByPid.get(metric.pid);
    if (context?.role) return context.role;
    if (!context) {
      if (metric.type === 'Browser') return 'Proceso principal';
      if (metric.type === 'GPU') return 'GPU';
      if (metric.type === 'Utility') return metric.serviceName || 'Servicio auxiliar';
      return metric.type || 'Proceso Electron';
    }
    if (context.id === 'wa-wv') return 'WhatsApp Web';
    if (context.id === 'wch-wv') return 'WebChat';
    if (context.id === 'ai-wv') return 'IA Web';
    if (context.id.startsWith('webview-')) return 'Pestaña: ' + (context.url || 'Nueva pestaña');
    return 'Webview: ' + (context.url || 'about:blank');
  };
  const metrics = app.getAppMetrics();
  const memoryByPid = new Map();
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
        if (!error && stdout) {
          for (const line of stdout.split(/\r?\n/)) {
            const fields = line.match(/"(?:[^"]|"")*"|[^,]+/g) || [];
            const pid = Number(String(fields[1] || '').replace(/"/g, '').trim());
            const memoryKb = Number(String(fields[4] || '').replace(/["\s,.KB]/gi, ''));
            if (pid > 0 && Number.isFinite(memoryKb)) memoryByPid.set(pid, Math.round(memoryKb / 1024));
          }
        }
        resolve();
      });
    });
  }
  return metrics.map(metric => ({
    pid: metric.pid,
    type: metric.type,
    role: roleFor(metric),
    state: 'Activo',
    memory: memoryByPid.get(metric.pid) || Math.round((metric.memory?.workingSetSize || metric.memory?.privateBytes || 0) / 1048576),
    cpu: Number(metric.cpu?.percentCPUUsage || 0).toFixed(1),
    url: contextByPid.get(metric.pid)?.url || '',
    service: metric.serviceName || ''
  }));
});
// Media detected by the active browser session
ipcMain.handle('get-media', () => MEDIA_URLS);
// ── Helpers de descarga ──────────────────────────
function getSessionFetch() {
  try {
    const ses = session.fromPartition('persist:mc');
    // session.fetch() disponible desde Electron 28+
    if (typeof ses.fetch === 'function') return (url, opts) => ses.fetch(url, opts);
  } catch {}
  // Fallback: fetch nativo con cookies extraidas manualmente
  return null;
}

const sessionFetch = getSessionFetch();

async function chromiumFetch(url, extraHeaders = {}, signal) {
  // Usar session.fetch() si está disponible (Chromium nativo, todas las cookies)
  if (sessionFetch) {
    const headers = { ...extraHeaders };
    if (!headers['Referer']) try { headers['Referer'] = new URL(url).origin + '/'; } catch {}
    const resp = await sessionFetch(url, { headers, method: 'GET', credentials: 'include', signal });
    return resp;
  }
  // Fallback: Node fetch con cookies del Electron session
  try {
    const cookies = await session.fromPartition('persist:mc').cookies.get({ url });
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', ...extraHeaders };
    if (!headers['Referer']) try { headers['Referer'] = new URL(url).origin + '/'; } catch {}
    if (cookieStr) headers['Cookie'] = cookieStr;
    return fetch(url, { headers, signal });
  } catch {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', ...extraHeaders };
    return fetch(url, { headers, signal });
  }
}

function mediaRequestHeaders(pageUrl, fallbackUrl) {
  const headers = {};
  if (pageUrl) headers.Referer = pageUrl;
  try { headers.Origin = new URL(pageUrl || fallbackUrl).origin; } catch {}
  return headers;
}

function resolveUrl(base, segment) {
  if (segment.startsWith('http://') || segment.startsWith('https://')) return segment;
  try {
    const u = new URL(base);
    if (segment.startsWith('/')) return u.origin + segment;
    return u.origin + u.pathname.replace(/\/[^/]*$/, '/') + segment;
  } catch { return segment; }
}

async function downloadSegment(url, referer, signal) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chromiumFetch(url, referer ? { 'Referer': referer } : {}, signal);
      if (!res.ok) throw new Error(`HTTP ${res.status} en segmento`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError || new Error('No se pudo descargar el segmento');
}

function pickBestHlsVariant(manifestText, baseUrl) {
  let bestUrl = baseUrl;
  let bestScore = -1;
  for (const block of manifestText.split('#EXT-X-STREAM-INF')) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const inf = lines[0];
    const uri = lines[1].trim();
    if (!uri || uri.startsWith('#')) continue;
    const bwMatch = inf.match(/BANDWIDTH=(\d+)/i);
    const resMatch = inf.match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
    const resolution = resMatch ? parseInt(resMatch[1], 10) * parseInt(resMatch[2], 10) : 0;
    const score = bandwidth > 0 ? bandwidth : resolution;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = resolveUrl(baseUrl, uri);
    }
  }
  return bestScore >= 0 ? bestUrl : baseUrl;
}

function parseHlsSegmentUrls(mediaText, playlistUrl) {
  const urls = [];
  for (const line of mediaText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/\.m3u8(\?|#|$)/i.test(trimmed)) continue;
    urls.push(resolveUrl(playlistUrl, trimmed));
  }
  return urls;
}

function hlsSegmentIv(ivHex, mediaSeq, segmentIndex) {
  if (ivHex) {
    const iv = Buffer.alloc(16, 0);
    const parsed = Buffer.from(ivHex, 'hex');
    parsed.copy(iv, Math.max(0, 16 - parsed.length));
    return iv;
  }
  const iv = Buffer.alloc(16, 0);
  const seq = BigInt(mediaSeq + segmentIndex);
  iv.writeBigUInt64BE(seq, 8);
  return iv;
}

function decryptAes128Segment(buffer, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

async function loadHlsEncryption(mediaText, playlistUrl, pageUrl, signal) {
  const keyLine = mediaText.split('\n').find(l => /^#EXT-X-KEY:/i.test(l));
  if (!keyLine) return null;
  const attrs = keyLine.slice('#EXT-X-KEY:'.length);
  const method = (attrs.match(/METHOD=([^,]+)/i) || [])[1]?.trim().toUpperCase();
  if (!method || method === 'NONE') return null;
  if (method !== 'AES-128') {
    throw new Error(`Stream cifrado con ${method} — no soportado. Probá con yt-dlp.`);
  }
  const uriMatch = attrs.match(/URI="([^"]+)"/i);
  if (!uriMatch) throw new Error('Manifiesto HLS cifrado sin URI de clave');
  const ivHex = (attrs.match(/IV=0x([0-9a-fA-F]+)/i) || [])[1] || null;
  const keyUrl = resolveUrl(playlistUrl, uriMatch[1]);
  const referer = pageUrl || new URL(playlistUrl).origin + '/';
  const keyBuf = await downloadSegment(keyUrl, referer, signal);
  if (!keyBuf || keyBuf.length !== 16) throw new Error('Clave AES-128 inválida o inaccesible');
  const mediaSeq = parseInt((mediaText.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i) || [])[1] || '0', 10);
  return { key: keyBuf, ivHex, mediaSeq };
}

const FFMPEG_DIR = () => path.join(app.getPath('userData'), 'ffmpeg');

function findFfmpeg() {
  const pathCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(dir => path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(FFMPEG_DIR(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(app.getPath('userData'), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ...pathCandidates
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

function findFfprobe() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const candidate = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(candidate) ? candidate : null;
}

async function installFfmpegPortable() {
  const destDir = FFMPEG_DIR();
  const ffmpegExe = path.join(destDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(ffmpegExe)) return { ok: true, path: ffmpegExe };
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'FFmpeg no encontrado. Instalalo con tu gestor de paquetes (apt install ffmpeg, brew install ffmpeg).'
    };
  }
  const zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const zipPath = path.join(app.getPath('temp'), `mc-ffmpeg-${Date.now()}.zip`);
  try {
    ACTIONS.emit?.('ytdlp-log', 'Descargando FFmpeg (~90 MB, primera vez)...');
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar FFmpeg`);
    fs.mkdirSync(destDir, { recursive: true });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    ACTIONS.emit?.('ytdlp-log', 'Extrayendo FFmpeg...');
    const { execFile } = require('child_process');
    const extractDir = path.join(app.getPath('temp'), `mc-ffmpeg-extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ], { windowsHide: true }, (err) => err ? reject(err) : resolve());
    });
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const root = entries.find(e => e.isDirectory() && /ffmpeg/i.test(e.name))?.name || entries[0]?.name;
    if (!root) throw new Error('Estructura del ZIP de FFmpeg inesperada');
    const binDir = path.join(extractDir, root, 'bin');
    if (!fs.existsSync(binDir)) throw new Error('No se encontró carpeta bin en el ZIP');
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const src = path.join(binDir, name);
      const dst = path.join(destDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
    try { fs.unlinkSync(zipPath); } catch {}
    if (!fs.existsSync(ffmpegExe)) throw new Error('No se pudo extraer ffmpeg.exe');
    ACTIONS.emit?.('ytdlp-log', '✓ FFmpeg instalado en ' + destDir);
    return { ok: true, path: ffmpegExe };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      guide: 'Descargá FFmpeg Essentials desde https://www.gyan.dev/ffmpeg/builds/ y agregá ffmpeg.exe al PATH o a ' + destDir
    };
  }
}

async function ensureFfmpegAvailable() {
  if (findFfmpeg()) return { ok: true, path: findFfmpeg() };
  return installFfmpegPortable();
}

function inspectMediaFile(inputPath, inputFormat) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return Promise.resolve(null);
  return new Promise(resolve => {
    const args = ['-v', 'error'];
    if (inputFormat) args.push('-f', inputFormat);
    args.push('-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', inputPath);
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let output = '';
    proc.stdout.on('data', data => { output += data.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(output)); } catch { resolve(null); }
    });
  });
}

function remuxToMp4(inputPath, outputPath, inputFormat) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.resolve({ ok: false, error: 'FFmpeg no está instalado o no está en PATH' });
  const format = resolveMediaInputFormat(inputPath, inputFormat);
  return new Promise(resolve => {
    const inputArgs = format ? ['-f', format, '-probesize', '50M', '-analyzeduration', '100M'] : ['-probesize', '50M', '-analyzeduration', '100M'];
    const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs, '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-fflags', '+genpts+discardcorrupt', '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart', '-f', 'mp4', outputPath], { windowsHide: true });
    let error = '';
    proc.stderr.on('data', data => { error += data.toString(); });
    proc.on('error', e => resolve({ ok: false, error: `No se pudo iniciar FFmpeg: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0 && error.trim()) ACTIONS.emit?.('ytdlp-log', '[FFmpeg] ' + error.trim().split('\n').slice(-3).join(' '));
      resolve(code === 0 ? { ok: true } : {
        ok: false,
        error: error.trim() || `FFmpeg terminó con código ${code}`
      });
    });
  });
}

function transcodeToMp4(inputPath, outputPath, inputFormat) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return Promise.resolve({ ok: false, error: 'FFmpeg no está instalado o no está en PATH' });
  const format = resolveMediaInputFormat(inputPath, inputFormat);
  return new Promise(resolve => {
    const inputArgs = format ? ['-f', format] : [];
    const proc = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-probesize', '50M', '-analyzeduration', '100M',
      ...inputArgs, '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath], { windowsHide: true });
    let error = '';
    proc.stderr.on('data', data => { error += data.toString(); });
    proc.on('error', e => resolve({ ok: false, error: `No se pudo iniciar FFmpeg: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0 && error.trim()) ACTIONS.emit?.('ytdlp-log', '[FFmpeg] ' + error.trim().split('\n').slice(-3).join(' '));
      resolve(code === 0 ? { ok: true } : {
        ok: false, error: error.trim() || `FFmpeg terminó con código ${code}`
      });
    });
  });
}

function isUsableMp4(filePath) {
  try { return fs.existsSync(filePath) && fs.statSync(filePath).size > 1024; } catch { return false; }
}

function detectMediaInputFormat(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (/\.(?:ts|m2ts|mts)(?:\.|$)/i.test(lower) || lower.endsWith('.part.ts')) return 'mpegts';
  try {
    const fd = fs.openSync(filePath, 'r');
    const sample = Buffer.alloc(65536);
    const length = fs.readSync(fd, sample, 0, sample.length, 0);
    fs.closeSync(fd);
    if (length < 4) return undefined;
    if (sample.subarray(4, 8).toString() === 'ftyp' || sample.subarray(4, 8).toString() === 'styp') return 'mp4';
    let tsHits = 0;
    for (let offset = 0; offset + 188 <= length; offset += 188) {
      if (sample[offset] === 0x47) tsHits++;
    }
    if (tsHits >= 3 || (length >= 1 && sample[0] === 0x47)) return 'mpegts';
  } catch {}
  return undefined;
}

function resolveMediaInputFormat(filePath, hint) {
  if (hint) return hint;
  return detectMediaInputFormat(filePath);
}

async function finalizeMediaFile(rawPath, finalPath, inputFormat) {
  if (!fs.existsSync(rawPath)) {
    return { path: rawPath.replace(/\.source$/i, '.ts'), converted: false, error: 'No se encontró el temporal descargado' };
  }
  const ffmpegReady = await ensureFfmpegAvailable();
  if (!ffmpegReady.ok) {
    const fallbackPath = finalPath.replace(/\.mp4$/i, '.ts');
    try {
      if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
      fs.renameSync(rawPath, fallbackPath);
    } catch {}
    return { path: fallbackPath, converted: false, error: ffmpegReady.error + (ffmpegReady.guide ? ' — ' + ffmpegReady.guide : '') };
  }
  const detectedFormat = resolveMediaInputFormat(rawPath, inputFormat);
  const media = await inspectMediaFile(rawPath, detectedFormat);
  const streams = media?.streams || [];
  const hasVideo = streams.some(stream => stream.codec_type === 'video');
  const hasCompatibleVideo = streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264');
  const hasCompatibleAudio = streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac');
  if (hasVideo && hasCompatibleVideo && (!streams.some(stream => stream.codec_type === 'audio') || hasCompatibleAudio)) {
    const remuxed = await remuxToMp4(rawPath, finalPath, detectedFormat);
    if (remuxed.ok && isUsableMp4(finalPath)) {
      try { fs.unlinkSync(rawPath); } catch {}
      return { path: finalPath, converted: true, remuxed: true };
    }
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch {}
    ACTIONS.emit?.('ytdlp-log', '⚠ Remux MP4 falló, intentando recodificar...');
  } else if (hasVideo) {
    ACTIONS.emit?.('ytdlp-log', '⚠ Códec no compatible para remux directo, recodificando...');
  }
  const transcoded = await transcodeToMp4(rawPath, finalPath, detectedFormat);
  if (transcoded.ok) {
    try { fs.unlinkSync(rawPath); } catch {}
    return { path: finalPath, converted: true };
  }
  const fallbackPath = finalPath.replace(/\.mp4$/i, '.ts');
  try {
    if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);
    fs.renameSync(rawPath, fallbackPath);
  } catch { return { path: fallbackPath, converted: false, error: transcoded.error || 'No se pudo guardar el fallback' }; }
  return { path: fallbackPath, converted: false, error: transcoded.error || 'No se pudo convertir el archivo' };
}

// ── Download control registry ────────────────────
// Permite pausar / reanudar / cancelar descargas activas por ID único.
const dlRegistry = new Map(); // id -> { id, url, type, state, controller }
class PauseSignal extends Error {}

function dlRegister(id, url, type) {
  const entry = { id, url, type, state: 'active', controller: new AbortController() };
  dlRegistry.set(id, entry);
  return entry;
}
function dlWaitIfPaused(id) {
  // Resuelve 'active' cuando se reanuda, 'cancelled' si se cancela mientras espera
  return new Promise(resolve => {
    const tick = () => {
      const e = dlRegistry.get(id);
      if (!e) return resolve('active');
      if (e.state === 'cancelled') return resolve('cancelled');
      if (e.state === 'active') return resolve('active');
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ── Downloads ────────────────────────────────────
ipcMain.handle('dl-hls', async (e, { id, url, name, pageUrl }) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    const error = 'URL HLS inválida o vacía';
    ACTIONS.emit('dl-error', { id, url: url || '', error });
    ACTIONS.emit('ytdlp-log', '✗ Error HLS: ' + error);
    return { error };
  }
  const dlDir = CFG.downloadDir || app.getPath('downloads');
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
  const t0 = Date.now();
  const extraHeaders = mediaRequestHeaders(pageUrl, url);
  const entry = dlRegister(id, url, 'hls');
  let hlsOutput;
  try {
    ACTIONS.emit('dl-progress', { id, url, pct: 0, done: 0, total: 1, speed: 0 });
    ACTIONS.emit('ytdlp-log', 'Iniciando descarga HLS: ' + url.substring(0, 80));
    const res = await chromiumFetch(url, extraHeaders, entry.controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status} al cargar playlist HLS`);
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length === 0) throw new Error('Servidor devolvió 0 bytes (sesión inválida?)');
    const manifestText = raw.toString('utf8');
    if (!manifestText.includes('#EXTM3U')) {
      // No es HLS, guardar como archivo directo
      const fname = path.join(dlDir, (name || 'media_' + Date.now()) + '.mp4');
      const rawName = fname + '.part.ts';
      fs.writeFileSync(rawName, raw);
      const finalized = await finalizeMediaFile(rawName, fname);
      const resultPath = finalized.path;
      const size = (raw.length / 1048576).toFixed(1);
      ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, filename: path.basename(resultPath) });
      const mode = finalized.remuxed ? 'remux MP4' : finalized.converted ? 'recodificado MP4 H.264/AAC' : 'TS original';
      ACTIONS.emit('ytdlp-log', `✓ Descargado (${mode}): ${resultPath} (${size} MB)`);
      if (!finalized.converted) ACTIONS.emit('ytdlp-log', '⚠ ' + finalized.error + '; se conservó el archivo original');
      return { ok: true, path: resultPath, size: raw.length, converted: finalized.converted };
    }
    ACTIONS.emit('ytdlp-log', 'Manifiesto HLS detectado, descargando segmentos...');

    let playlistUrl = url;
    if (/#EXT-X-STREAM-INF/i.test(manifestText)) {
      playlistUrl = pickBestHlsVariant(manifestText, url);
    }

    const playlistHeaders = mediaRequestHeaders(pageUrl, playlistUrl);
    const mediaText = playlistUrl === url ? manifestText
      : await (async () => {
        const variant = await chromiumFetch(playlistUrl, playlistHeaders, entry.controller.signal);
        if (!variant.ok) throw new Error(`HTTP ${variant.status} al cargar variante HLS`);
        return Buffer.from(await variant.arrayBuffer()).toString('utf8');
      })();
    if (!mediaText.includes('#EXTM3U')) throw new Error('Playlist de media inválida');

    const encryption = await loadHlsEncryption(mediaText, playlistUrl, pageUrl, entry.controller.signal);
    if (encryption) ACTIONS.emit('ytdlp-log', 'Cifrado AES-128 detectado — descifrando segmentos...');

    const resolved = parseHlsSegmentUrls(mediaText, playlistUrl);
    if (!resolved.length) throw new Error('No se encontraron segmentos');
    const fname = path.join(dlDir, (name || 'stream_' + Date.now()) + '.mp4');
    const rawName = fname + '.part.ts';
    hlsOutput = fs.createWriteStream(rawName);
    let downloadedBytes = 0;
    let failedSegments = 0;
    const mapMatch = mediaText.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/i);
    if (mapMatch) {
      const initUrl = resolveUrl(playlistUrl, mapMatch[1]);
      const init = await downloadSegment(initUrl, pageUrl || new URL(playlistUrl).origin + '/', entry.controller.signal);
      if (!hlsOutput.write(init)) await new Promise(resolve => hlsOutput.once('drain', resolve));
      downloadedBytes += init.length;
    }
    const concurrency = 4;
    for (let i = 0; i < resolved.length; i += concurrency) {
      const st = await dlWaitIfPaused(id);
      if (st === 'cancelled') throw new Error('Cancelado por el usuario');
      const batch = resolved.slice(i, i + concurrency);
      const referer = pageUrl || new URL(playlistUrl).origin + '/';
      const results = await Promise.all(batch.map((segmentUrl, batchIdx) => downloadSegment(segmentUrl, referer, entry.controller.signal).catch(() => null).then(buf => {
        if (!buf || !encryption) return buf;
        try {
          const segIndex = i + batchIdx;
          const iv = hlsSegmentIv(encryption.ivHex, encryption.mediaSeq, segIndex);
          return decryptAes128Segment(buf, encryption.key, iv);
        } catch {
          return null;
        }
      })));
      for (const buffer of results) {
        if (!buffer) { failedSegments++; continue; }
        if (!hlsOutput.write(buffer)) await new Promise(resolve => hlsOutput.once('drain', resolve));
        downloadedBytes += buffer.length;
      }
      const pct = Math.round(Math.min(i + concurrency, resolved.length) / resolved.length * 100);
      const elapsed = (Date.now() - t0) / 1000;
      ACTIONS.emit('dl-progress', { id, url, pct, done: Math.min(i + concurrency, resolved.length), total: resolved.length, speed: Math.round(downloadedBytes / 1024 / Math.max(elapsed, 0.1)), kind: 'hls' });
    }

    if (failedSegments) throw new Error(`Fallaron ${failedSegments} segmentos HLS; conversión cancelada para evitar un archivo corrupto`);
    await new Promise((resolve, reject) => { hlsOutput.end(error => error ? reject(error) : resolve()); });
    ACTIONS.emit('ytdlp-log', 'Descarga completa — convirtiendo a MP4...');
    const finalized = await finalizeMediaFile(rawName, fname, mapMatch ? 'mp4' : 'mpegts');
    const resultPath = finalized.path;
    const size = (downloadedBytes / 1048576).toFixed(1);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, secs, filename: path.basename(resultPath) });
    const mode = finalized.remuxed ? 'remux MP4' : finalized.converted ? 'recodificado MP4 H.264/AAC' : 'TS original';
    ACTIONS.emit('ytdlp-log', `✓ HLS descargado (${mode}): ${resultPath} (${size} MB, ${resolved.length} segs, ${secs}s)`);
    if (!finalized.converted) ACTIONS.emit('ytdlp-log', '⚠ ' + finalized.error + '; se conservó el archivo original');
    return { ok: true, path: resultPath, size: downloadedBytes, converted: finalized.converted };
  } catch (e) {
    if (hlsOutput && !hlsOutput.closed) hlsOutput.destroy();
    const cancelled = entry.state === 'cancelled';
    ACTIONS.emit('dl-error', { id, url, error: cancelled ? 'Cancelado' : e.message, cancelled });
    ACTIONS.emit('ytdlp-log', (cancelled ? '✗ Cancelado: ' : '✗ Error HLS: ') + e.message);
    return { error: e.message };
  } finally {
    dlRegistry.delete(id);
  }
});
ipcMain.handle('dl-file', async (e, { id, url, name, pageUrl }) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    const error = 'URL multimedia inválida o vacía';
    ACTIONS.emit('dl-error', { id, url: url || '', error });
    ACTIONS.emit('ytdlp-log', '✗ Error: ' + error);
    return { error };
  }
  const dlDir = CFG.downloadDir || app.getPath('downloads');
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
  const t0 = Date.now();
  const extraHeaders = mediaRequestHeaders(pageUrl, url);
  const entry = dlRegister(id, url, 'file');
  const safeBase = String(name || 'media_' + Date.now()).replace(/[\\/:*?"<>|]/g, '_').trim() || 'media';
  const detectedExt = (() => {
    const lower = String(url || '').split('?')[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:$|[?#])/i.test(lower)) return '.png';
    if (/\.(mp3|wav|flac|ogg|m4a|aac)(?:$|[?#])/i.test(lower)) return '.mp3';
    if (/\.(mp4|m4v|webm|mkv|mov|avi|mpeg|mpg|3gp)(?:$|[?#])/i.test(lower)) return '.mp4';
    if (/\.(jpg|jpeg)(?:$|[?#])/i.test(lower)) return '.jpg';
    if (/\.(gif)(?:$|[?#])/i.test(lower)) return '.gif';
    if (/\.(webp)(?:$|[?#])/i.test(lower)) return '.webp';
    return '.bin';
  })();
  const finalNameBase = safeBase.toLowerCase().endsWith(detectedExt.toLowerCase()) ? safeBase : safeBase + detectedExt;
  const finalTarget = path.join(dlDir, finalNameBase);
  const rawName = finalTarget + '.part';
  let output;
  try {
    ACTIONS.emit('dl-progress', { id, url, pct: 0, done: 0, total: 1, speed: 0 });
    ACTIONS.emit('ytdlp-log', 'Descargando: ' + url.substring(0, 100));
    let totalLen = 0;
    let offset = 0;
    let lastSpeedT = t0;
    let lastSpeedBytes = 0;
    while (true) {
      if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
      if (entry.state === 'paused') { await new Promise(r => setTimeout(r, 250)); continue; }
      const headers = { ...extraHeaders };
      if (offset > 0) headers['Range'] = `bytes=${offset}-`;
      const res = await chromiumFetch(url, headers, entry.controller.signal);
      const ct = res.headers.get('content-type') || '?';
      const cl = parseInt(res.headers.get('content-length') || '0');
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} (${ct})`);
      if (res.status === 200 && offset > 0) {
        // El servidor ignoró Range → reiniciar desde cero
        if (output) { output.close(); output = null; }
        fs.writeFileSync(rawName, Buffer.alloc(0));
        totalLen = 0; offset = 0;
      }
      if (!output) output = fs.createWriteStream(rawName, { flags: offset > 0 ? 'a' : 'w' });
      ACTIONS.emit('ytdlp-log', `Respuesta: HTTP ${res.status} | Type: ${ct} | Length: ${cl}`);
      const reader = res.body.getReader();
      try {
        while (true) {
          if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
          if (entry.state === 'paused') throw new PauseSignal();
          const { done, value } = await reader.read();
          if (done) break;
          if (!output.write(Buffer.from(value))) await new Promise(resolve => output.once('drain', resolve));
          totalLen += value.length;
          offset = totalLen;
          const now = Date.now();
          if (now - lastSpeedT > 500) {
            const speed = Math.round((totalLen - lastSpeedBytes) / 1024 / ((now - lastSpeedT) / 1000));
            lastSpeedT = now; lastSpeedBytes = totalLen;
            const pct = cl > 0 ? Math.round(totalLen / cl * 100) : 0;
            ACTIONS.emit('dl-progress', { id, url, pct, done: totalLen, total: cl, speed, kind: 'file' });
          }
        }
      } catch (err) {
        await reader.cancel().catch(() => {});
        if (err instanceof PauseSignal || entry.state === 'paused') continue;
        if (entry.state === 'cancelled') throw new Error('Cancelado por el usuario');
        throw err;
      }
      break; // stream completo
    }
    if (totalLen === 0) throw new Error('Servidor devolvió 0 bytes');
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    if (fs.existsSync(finalTarget)) try { fs.unlinkSync(finalTarget); } catch {}
    fs.renameSync(rawName, finalTarget);
    const resultPath = finalTarget;
    const size = (totalLen / 1048576).toFixed(1);
    ACTIONS.emit('dl-complete', { id, url, file: resultPath, size, secs: ((Date.now()-t0)/1000).toFixed(1), filename: path.basename(resultPath) });
    ACTIONS.emit('ytdlp-log', `✓ Descargado: ${resultPath} (${size} MB)`);
    return { ok: true, path: resultPath, size: totalLen, converted: false };
  } catch (e) {
    if (output && !output.closed) output.destroy();
    const cancelled = entry.state === 'cancelled';
    ACTIONS.emit('dl-error', { id, url, error: cancelled ? 'Cancelado' : e.message, cancelled });
    ACTIONS.emit('ytdlp-log', (cancelled ? '✗ Cancelado: ' : '✗ Error: ') + e.message);
    return { error: e.message };
  } finally {
    dlRegistry.delete(id);
  }
});
// Control de descargas: pausar / reanudar / cancelar
ipcMain.handle('dl-pause', (_e, id) => {
  const e = dlRegistry.get(id);
  if (e && e.state === 'active') {
    e.state = 'paused';
    // En archivos directos abortamos el fetch para pausar de inmediato;
    // en HLS el bucle espera en el límite del lote sin perder segmentos.
    if (e.type === 'file' && e.controller) e.controller.abort();
  }
  return { ok: true };
});
ipcMain.handle('dl-resume', (_e, id) => {
  const e = dlRegistry.get(id);
  if (e && e.state === 'paused') {
    e.state = 'active';
    e.controller = new AbortController();
  }
  return { ok: true };
});
ipcMain.handle('dl-cancel', (_e, id) => {
  const e = dlRegistry.get(id);
  if (e) {
    e.state = 'cancelled';
    if (e.controller) e.controller.abort();
  }
  return { ok: true };
});
ipcMain.handle('open-dl-folder', () => { shell.openPath(CFG.downloadDir || app.getPath('downloads')); });
ipcMain.handle('dl:open-file', async (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: 'Archivo no encontrado' };
    const err = await shell.openPath(filePath);
    return err ? { error: err } : { ok: true };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('choose-dl-dir', async () => {
  const result = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths.length) {
    CFG.downloadDir = result.filePaths[0];
    saveCfg();
    return { path: result.filePaths[0] };
  }
  return {};
});
ipcMain.handle('open-external', (e, url) => {
  if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')))
    shell.openExternal(url);
});
// Cookies / Cache
const sess = () => session.fromPartition('persist:mc');
ipcMain.handle('clear-cookies', async () => {
  try {
    const cookies = await sess().cookies.get({});
    for (const c of cookies) await sess().cookies.remove(cookieRemovalUrl(c), c.name);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('clear-cache', async () => {
  try { await sess().clearCache(); return { ok: true }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('clear-data', async (_e, opts = {}) => {
  try {
    const settings = {
      history: Boolean(opts.history),
      cache: Boolean(opts.cache),
      cookies: Boolean(opts.cookies),
      keepSessions: Boolean(opts.keepSessions)
    };

    if (settings.cookies) {
      const cookies = await sess().cookies.get({});
      const filtered = settings.keepSessions ? cookies.filter(c => !c.session) : cookies;
      for (const c of filtered) await sess().cookies.remove(cookieRemovalUrl(c), c.name);
    }

    if (settings.cache) await sess().clearCache();
    if (settings.history) {
      HISTORY = [];
      saveHistory();
    }

    return { ok: true, settings };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('clear-all', async () => {
  try {
    const cookies = await sess().cookies.get({});
    for (const c of cookies) await sess().cookies.remove(cookieRemovalUrl(c), c.name);
    await sess().clearCache();
    await sess().clearStorageData();
    HISTORY = [];
    saveHistory();
    STATS = { pagesLoaded: 0, totalRequests: 0, detectedAds: 0, detectedTrackers: 0, detectedThird: 0, blockedAds: 0, blockedTrackers: 0, blockedThird: 0, blockedCrypto: 0, detectedMedia: 0, requestsBlocked: 0, cookiesBlocked: 0, bytesDownloaded: 0, uptimeStart: Date.now() };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('add-cookie-rule', (e, { domain, policy }) => { CFG.allowlist[domain] = policy; saveCfg(); return { ok: true }; });
ipcMain.handle('remove-cookie-rule', (e, { domain }) => { delete CFG.allowlist[domain]; saveCfg(); return { ok: true }; });
ipcMain.handle('set-cookie-policy-for-domain', (e, { domain, policy }) => {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  if (!host) return { ok: false, error: 'dominio obligatorio' };
  CFG.allowlist[host] = policy;
  saveCfg();
  return { ok: true, domain: host, policy };
});
ipcMain.handle('get-site-cookies', async (e, { domain }) => {
  try {
    const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
    if (!host) return [];
    const allCookies = await sess().cookies.get({});
    const matchesHost = (cookieDomain) => {
      const normalized = String(cookieDomain || '').replace(/^\.+/, '').toLowerCase();
      if (!normalized) return false;
      if (normalized === host) return true;
      if (host.endsWith('.' + normalized) || normalized.endsWith('.' + host)) return true;
      return false;
    };
    const cookies = allCookies.filter(cookie => matchesHost(cookie.domain));
    return cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      session: !!cookie.session,
      httpOnly: !!cookie.httpOnly,
      expirationDate: cookie.expirationDate || null,
      sameSite: cookie.sameSite || 'unspecified'
    }));
  } catch (error) {
    return { error: error.message };
  }
});
ipcMain.handle('remove-site-cookie', async (e, { domain, name, path: cookiePath }) => {
  try {
    const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
    const cookiePathValue = String(cookiePath || '/');
    if (!host || !name) return { ok: false, error: 'faltan datos' };
    const removed = await sess().cookies.remove(cookieRemovalUrl({ domain: host, path: cookiePathValue, secure: true }, host), name);
    if (!removed) {
      await sess().cookies.remove(cookieRemovalUrl({ domain: host, path: cookiePathValue, secure: false }, host), name);
    }
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
// Block rules
ipcMain.handle('add-block-rule', (e, rule) => {
  if (rule && rule.pattern) { CFG.customRules.push(rule); saveCfg(); }
  return { ok: true };
});
ipcMain.handle('remove-block-rule', (e, { pattern, site }) => {
  if (site) {
    CFG.customRules = CFG.customRules.filter(r => !(r.pattern === pattern && r.site === site));
  } else {
    CFG.customRules = CFG.customRules.filter(r => r.pattern !== pattern);
  }
  saveCfg();
  return { ok: true };
});
ipcMain.handle('add-resource-rule', (e, rule = {}) => {
  const url = String(rule.url || '').trim();
  const action = rule.action === 'allow' ? 'allow' : rule.action === 'block' ? 'block' : '';
  if (!url || !action) return { ok: false, error: 'faltan URL o acción' };
  CFG.resourceRules = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : []).filter(item => item.url !== url || item.resourceType !== rule.resourceType);
  CFG.resourceRules.push({ url, action, resourceType: String(rule.resourceType || 'script') });
  saveCfg();
  return { ok: true };
});
ipcMain.handle('remove-resource-rule', (e, { url, resourceType }) => {
  CFG.resourceRules = (Array.isArray(CFG.resourceRules) ? CFG.resourceRules : []).filter(item => item.url !== url || (resourceType && item.resourceType !== resourceType));
  saveCfg();
  return { ok: true };
});
ipcMain.handle('get-resource-rules', () => Array.isArray(CFG.resourceRules) ? [...CFG.resourceRules] : []);
// Bookmarks
ipcMain.handle('bookmarks:list', () => [...BOOKMARKS]);
ipcMain.handle('bookmarks:add', (e, bookmark) => {
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), url: bookmark.url, title: bookmark.title || bookmark.url, icon: bookmark.icon || '', folder: bookmark.folder || '', ts: Date.now() };
  BOOKMARKS.unshift(entry);
  saveBookmarks();
  return entry;
});
ipcMain.handle('bookmarks:remove', (e, { id }) => {
  BOOKMARKS = BOOKMARKS.filter(b => b.id !== id);
  saveBookmarks();
  return { ok: true };
});
ipcMain.handle('bookmarks:update', (e, { id, patch }) => {
  const b = BOOKMARKS.find(b => b.id === id);
  if (b) Object.assign(b, patch);
  saveBookmarks();
  return { ok: true };
});
ipcMain.handle('bookmarks:reorder', (e, { fromIndex, toIndex }) => {
  const [item] = BOOKMARKS.splice(fromIndex, 1);
  if (item) { BOOKMARKS.splice(toIndex, 0, item); saveBookmarks(); }
  return { ok: true };
});
// Browser history
ipcMain.handle('history:list', () => [...HISTORY].reverse());
ipcMain.handle('history:add', (e, entry) => {
  if (!entry || typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url)) return { ok: false };
  const last = HISTORY[HISTORY.length - 1];
  if (last && last.url === entry.url) return { ok: true, entry: last };
  const saved = {
    url: entry.url,
    title: String(entry.title || entry.url).slice(0, 500),
    ts: Number(entry.ts) || Date.now()
  };
  HISTORY.push(saved);
  if (HISTORY.length > 2000) HISTORY = HISTORY.slice(-2000);
  saveHistory();
  return { ok: true, entry: saved };
});
ipcMain.handle('history:clear', () => {
  HISTORY = [];
  saveHistory();
  return { ok: true };
});
// Permissions
function normalizePermissionMap(value) {
  if (Array.isArray(value)) {
    const map = {};
    for (const item of value) map[item] = 'allow';
    return map;
  }
  if (value && typeof value === 'object') return value;
  return {};
}

function removePermissionEntry(domain, permission) {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  if (!host) return { ok: false, error: 'dominio obligatorio' };
  if (permission) {
    const entry = normalizePermissionMap(CFG.permissions[host]);
    delete entry[permission];
    if (Object.keys(entry).length) CFG.permissions[host] = entry;
    else delete CFG.permissions[host];
  } else {
    delete CFG.permissions[host];
  }
  saveCfg();
  return { ok: true };
}

function setPermissionEntry(domain, permission, value = 'allow') {
  const host = String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  const key = String(permission || '').trim();
  if (!host || !key) return { ok: false, error: 'faltan dominio o permiso' };
  CFG.permissions[host] = normalizePermissionMap(CFG.permissions[host]);
  CFG.permissions[host][key] = value;
  saveCfg();
  return { ok: true, permissions: CFG.permissions[host] };
}

ipcMain.handle('add-permission', (e, { domain, permission, value = 'allow' }) =>
  setPermissionEntry(domain, permission, value));
ipcMain.handle('set-site-permission', (e, { domain, permission, value = 'allow' }) =>
  setPermissionEntry(domain, permission, value));
ipcMain.handle('remove-permission', (e, { domain, permission }) => removePermissionEntry(domain, permission));
ipcMain.handle('remove-site-permission', (e, { domain, permission }) => removePermissionEntry(domain, permission));
ipcMain.handle('get-permissions', () => ({ ...CFG.permissions }));
// DoH
ipcMain.handle('resolve-doh', async (e, host) => {
  const normalizedHost = String(host || '').trim().replace(/\.$/, '').toLowerCase();
  if (!normalizedHost || normalizedHost.length > 253 || !/^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalizedHost)) {
    return { ok: false, error: 'dominio inválido', code: 'invalid-host' };
  }
  try {
    const servers = {
      cloudflare: 'https://cloudflare-dns.com/dns-query',
      google: 'https://dns.google/resolve',
      quad9: null,
      nextdns: 'https://dns.nextdns.io/resolve',
      adguard: 'https://dns.adguard.com/resolve',
      mullvad: null,
    };
    const provider = CFG.dohServer || 'cloudflare';
    if (servers[provider] === null) {
      return { ok: false, error: `${provider === 'quad9' ? 'Quad9' : 'Mullvad'} requiere DoH wire format por HTTP/2`, code: 'wire-only' };
    }
    const url = servers[provider] || servers.cloudflare;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch(`${url}?name=${encodeURIComponent(normalizedHost)}&type=A`, {
          method: 'GET', headers: { 'Accept': 'application/dns-json' }, signal: controller.signal
        });
        if (!(res.status === 408 || res.status === 429 || res.status >= 500) || attempt === 1) break;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const error = res.status === 505
        ? 'requiere HTTP/2 y formato wire RFC 8484'
        : `HTTP ${res.status}`;
      return { ok: false, error, code: res.status === 505 ? 'http2-required' : 'http-error' };
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return { ok: false, error: 'el servidor no soporta el test JSON', code: 'invalid-json' }; }
    const a = (data.Answer || []).find(x => x.type === 1);
    if (!a || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(a.data || ''))) return { ok: false, error: 'sin respuesta A', code: 'no-answer' };
    return { ok: true, ip: a.data };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'tiempo de espera agotado (8 s)' : 'no se pudo conectar con el proveedor', code: e.name === 'AbortError' ? 'timeout' : 'network-error' };
  }
});
// Session export/import
ipcMain.handle('export-session', async () => {
  try {
    const cookies = await sess().cookies.get({});
    const result = { app: 'mc-browser-v2', version: 1, cookies };
    const dir = path.join(app.getPath('documents'), DATA_DIR + '-sessions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fname = path.join(dir, `session-${Date.now()}.json`);
    fs.writeFileSync(fname, JSON.stringify(result, null, 2), 'utf8');
    return { ok: true, path: fname, count: cookies.length };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('import-session', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWin, {
      properties: ['openFile'],
      filters: [{ name: 'Session Files', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return {};
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const data = JSON.parse(raw);
    if (data.app !== 'mc-browser-v2') return { error: 'Invalid format' };
    let count = 0;
    for (const c of (data.cookies || [])) {
      try {
        await sess().cookies.set({
          url: (c.secure ? 'https://' : 'http://') + c.domain + (c.path || '/'),
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite
        });
        count++;
      } catch {}
    }
    return { ok: true, count };
  } catch (e) { return { error: e.message }; }
});
// Streams
const STREAM_SCAN_SCRIPT = `
  (function(){
    try {
      if(!window.__mcFound) window.__mcFound=[];
      const pageUrl = location.href;
      const SKIP_EXT = /\\.(html?|php|aspx?|jsp|json|xml|css|js|svg|woff2?|ttf|eot)(\\?|#|$)/i;
      const MEDIA_RE = /\\.(m3u8|mp4|webm|mpd|ts|m4s|mkv|avi|mov)(\\?|#|$)/i;
      const TOKEN_RE = /[?&](token|exp|sign|auth|st|nonce|signature|hls|m3u8|mpd|playlist)=/i;
      const isMedia = u => u && !SKIP_EXT.test(u) && !/^(about|data|javascript):/i.test(u) && (MEDIA_RE.test(u) || TOKEN_RE.test(u) || /^https?:\/\/(x\.com|twitter\.com)\/[^/]+\/status\/\d+\/video\//i.test(u));
      // Extraer usuario de un bloque de tweet (x.com): a[href="/username"] o [data-testid="User-Name"]
      function extractUserFromNode(node) {
        const links = node.querySelectorAll('a[href]');
        for (const a of links) {
          const href = a.getAttribute('href');
          const m = href.match(/^\/([a-zA-Z0-9_]{1,15})$/);
          if (m && !/^(home|explore|search|notifications|messages|settings|i|compose|login|signup|hashtag|status|photo)$/i.test(m[1])) {
            return '@' + m[1];
          }
        }
        const un = node.querySelector('[data-testid="User-Name"]');
        if (un) {
          const t = un.textContent.trim().replace(/^@/, '');
          if (t && t.length >= 2 && t.length <= 40) return '@' + t;
        }
        return null;
      }
      // Buscar el autor/usuario del post que contiene el medio recorriendo el DOM hacia arriba
      function findAuthor(el) {
        // x.com / twitter.com: article[data-testid="tweet"] más cercano → usuario del tweet
        if (el.closest) {
          const article = el.closest('article[data-testid="tweet"]');
          if (article) {
            const u = extractUserFromNode(article);
            if (u) return u;
          }
        }
        let node = el;
        for (let i = 0; i < 50 && node && node !== document.body; i++) {
          // x.com: [data-testid="User-Name"] (handle visible del tweet) en el ancestro
          if (node.querySelector) {
            const un = node.querySelector('[data-testid="User-Name"]');
            if (un) {
              const t = un.textContent.trim().replace(/^@/, '');
              if (t && t.length >= 2 && t.length <= 40) return '@' + t;
            }
          }
          // Genérico: itemprop="author"
          if (node.querySelector) {
            const auth = node.querySelector('[itemprop="author"]');
            if (auth) {
              const t = (auth.getAttribute('content') || auth.textContent || '').trim().replace(/^@/, '');
              if (t && t.length >= 2 && t.length <= 40) return '@' + t;
            }
          }
          node = node.parentElement;
        }
        return null;
      }
      // Encontrar el autor del video activo (reproduciéndose o visible en pantalla)
      function findActiveVideoAuthor() {
        const videos = document.querySelectorAll('video');
        // 1. Video reproduciéndose
        for (const v of videos) {
          if (!v.paused) {
            const a = findAuthor(v);
            if (a) return a;
          }
        }
        // 2. Video visible en pantalla
        for (const v of videos) {
          const r = v.getBoundingClientRect();
          if (r.top < window.innerHeight && r.bottom > 0 && r.width > 0) {
            const a = findAuthor(v);
            if (a) return a;
          }
        }
        // 3. Si solo hay un video, usarlo
        if (videos.length === 1) {
          const a = findAuthor(videos[0]);
          if (a) return a;
        }
        // 4. Último video del DOM (el más reciente)
        for (let i = videos.length - 1; i >= 0; i--) {
          const a = findAuthor(videos[i]);
          if (a) return a;
        }
        return null;
      }
      const add=(url,via,author)=>{
        if(!url||!isMedia(url)) return;
        const currentPage = location.href;
        const samePage = window.__mcFound.find(f => f.url === url && f.pageUrl === currentPage);
        if (samePage) {
          if (author && !samePage.author) samePage.author = author;
          return;
        }
        const existing = window.__mcFound.find(f => f.url === url && f.pageUrl !== currentPage);
        if (existing) {
          existing.pageUrl = currentPage;
          if (author && !existing.author) existing.author = author;
          return;
        }
        window.__mcFound.push({url,via,pageUrl:currentPage,author:author||null});
      };
      document.querySelectorAll('video,audio').forEach(el=>{
        const author = findAuthor(el);
        if(el.src&&isMedia(el.src)) add(el.src,'DOM:'+el.tagName,author);
        if(el.currentSrc&&el.currentSrc!==el.src&&isMedia(el.currentSrc)) add(el.currentSrc,'currentSrc',author);
        el.querySelectorAll('source').forEach(s=>{if(s.src) add(s.src,'source',author);});
      });
      document.querySelectorAll('iframe').forEach(f=>{
        const author = findAuthor(f);
        if(f.src&&isMedia(f.src)) add(f.src,'iframe',author);
      });
      try {
        performance.getEntriesByType('resource').forEach(entry => {
          if (entry.name && /\\.(m3u8|mpd|mp4|webm|mkv)(?:\\?|#|$)|manifest|playlist|stream/i.test(entry.name)) add(entry.name,'performance',findActiveVideoAuthor());
        });
      }catch(e){}
      document.querySelectorAll('link[href]').forEach(link => {
        if (/preload|video|audio|manifest/i.test(link.rel || '') && link.href) add(link.href,'preload');
      });
      document.querySelectorAll('script:not([src])').forEach(s=>{
        const m=[...s.textContent.matchAll(/(https?:\\/\\/[^"' \\n<>]{10,400}\\.(?:m3u8|mpd|mp4|webm|mkv)[^"' \\n<>]*)/gi)];
        m.forEach(x=>add(x[1],'script:inline'));
      });
      try{if(typeof jwplayer!=='undefined'&&jwplayer())
        jwplayer().getPlaylist().forEach(it=>{(it.sources||[]).forEach(s=>{if(s.file&&isMedia(s.file))add(s.file,'jwplayer');});if(it.file&&isMedia(it.file))add(it.file,'jwplayer');});
      }catch(e){}
      try{if(typeof videojs!=='undefined')
        document.querySelectorAll('.video-js').forEach(el=>{try{const s=videojs.getPlayer(el).currentSrc();if(s&&isMedia(s))add(s,'videojs');}catch(_){}});
      }catch(e){}
      ['playerSrc','streamUrl','liveUrl','hlsUrl','videoUrl','mediaUrl'].forEach(k=>{
        if(window[k]){const v=String(window[k]);if(isMedia(v))add(v,'window.'+k);}
      });
      if(!window.__mcHooked){
        window.__mcHooked=true;
        const _f=window.fetch; window.fetch=function(r,...a){
          const u=typeof r==='string'?r:(r&&r.url)||'';
          if(/\\.m3u8|\\.mpd|manifest|segment|chunk/i.test(u)) add(u,'fetch',findActiveVideoAuthor());
          return _f.apply(this,[r,...a]);
        };
        const _x=XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open=function(m,u,...a){
          if(u&&/\\.m3u8|\\.mpd|manifest|segment/i.test(u)) add(u,'xhr',findActiveVideoAuthor());
          return _x.apply(this,[m,u,...a]);
        };
      }
      return JSON.stringify(window.__mcFound);
    } catch(e) { return JSON.stringify([]); }
  })()
`;
ipcMain.handle('streams:scan', async (_e, id) => {
  if (!mainWin || mainWin.isDestroyed()) return [];
  try {
    const webviewId = Number(id);
    if (!Number.isInteger(webviewId) || webviewId < 1) return [];
    const raw = await mainWin.webContents.executeJavaScript(`
      (function(){
        const wv = document.getElementById('webview-${webviewId}');
        if (!wv) return '[]';
        return wv.executeJavaScript(${JSON.stringify(STREAM_SCAN_SCRIPT)});
      })()
    `);
    let items = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []);
    if (items.length) {
      const adHosts = ['doubleclick.net','googlesyndication.com','adnxs.com','rubiconproject.com','openx.net','casalemedia.com','contextweb.com','criteo.com','criteo.net','adsrvr.org','pubmatic.com','taboola.com','outbrain.com','mgid.com','33across.com','dotomi.com','demdex.net','krxd.net','quantserve.com','scorecardresearch.com','serving-sys.com','tidaltv.com','adsafeprotected.com','doubleverify.com','moatads.com','sharethrough.com','yieldmo.com','adtarget.biz','fwmrm.net','4dex.io'];
      items = items.filter(i => {
        try { const h = new URL(i.url).hostname; return !adHosts.some(a => h === a || h.endsWith('.' + a)); } catch { return true; }
      });
    }
    return items;
  } catch(e) { ACTIONS.emit('ytdlp-log', 'Stream scan error: ' + e.message); return []; }
});
// yt-dlp
let ytdlpPath = '';
function findYtdlp() {
  if (ytdlpPath && fs.existsSync(ytdlpPath)) return ytdlpPath;
  for (const c of [path.join(app.getPath('userData'), 'yt-dlp.exe'), 'yt-dlp.exe', 'yt-dlp']) {
    try { if (fs.existsSync(c)) { ytdlpPath = c; return c; } } catch {}
  }
  return null;
}
ipcMain.handle('ytdlp-check', () => !!findYtdlp());
ipcMain.handle('ffmpeg-check', () => ({ found: !!findFfmpeg(), path: findFfmpeg() || '' }));
ipcMain.handle('ffmpeg-install', () => installFfmpegPortable());
ipcMain.handle('ytdlp-version', async () => {
  const p = findYtdlp();
  if (!p) return '';
  try {
    return new Promise((resolve) => {
      const proc = spawn(p, ['--version'], { timeout: 5000 });
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.on('close', () => resolve(out.trim()));
      proc.on('error', () => resolve(''));
    });
  } catch { return ''; }
});
ipcMain.handle('ytdlp-install', async () => {
  try {
    const dest = path.join(app.getPath('userData'), 'yt-dlp.exe');
    ACTIONS.emit('ytdlp-log', 'Descargando yt-dlp desde GitHub...');
    const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    if (!res.ok) { ACTIONS.emit('ytdlp-log', `HTTP ${res.status} al descargar`); return { error: `HTTP ${res.status}` }; }
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    ytdlpPath = dest;
    ACTIONS.emit('ytdlp-log', '✓ yt-dlp instalado en ' + dest);
    return { ok: true, path: dest };
  } catch (e) { ACTIONS.emit('ytdlp-log', 'Error instalación: ' + e.message); return { error: e.message }; }
});
ipcMain.handle('ytdlp-analyze', async (e, url) => {
  const p = findYtdlp();
  if (!p) return { error: 'yt-dlp not found' };
  try {
    return new Promise((resolve) => {
      const proc = spawn(p, ['--no-download', '--dump-json', url], { timeout: 30000 });
      let out = '', err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const data = JSON.parse(out);
            resolve({ ok: true, title: data.title, duration: data.duration, formats: (data.formats || []).length });
          } catch { resolve({ error: 'Error parsing yt-dlp output' }); }
        } else resolve({ error: err || `Exit code ${code}` });
      });
      proc.on('error', e => resolve({ error: e.message }));
    });
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('ytdlp-download', async (e, opts) => {
  const p = findYtdlp();
  if (!p) return { error: 'yt-dlp not found' };
  const dlDir = CFG.downloadDir || app.getPath('downloads');
  try {
    return new Promise((resolve) => {
      const proc = spawn(p, [opts.url, '-o', path.join(dlDir, '%(title)s.%(ext)s'), '--no-playlist', '--print', 'after_move:filepath']);
      let output = '';
      proc.stdout.on('data', d => { output += d.toString(); try { mainWin?.webContents?.send('ytdlp-log', d.toString().trim()); } catch {} });
      proc.stderr.on('data', d => { try { mainWin?.webContents?.send('ytdlp-log', d.toString().trim()); } catch {} });
      proc.on('close', code => { if (code === 0) resolve({ ok: true, path: output.trim() }); else resolve({ error: `Exit code ${code}` }); });
      proc.on('error', e => resolve({ error: e.message }));
    });
  } catch (e) { return { error: e.message }; }
});

// === AI MODULE fallbacks (solo si el módulo AI no carga) ────
// Se definen como función pero NO se registran aún — se registran después
// del módulo AI en el catch, para que los handlers reales ganen.
const aiFallbacks = (ctx) => {
  ipcMain.handle('ai:config:get', () => ctx.aiConfig);
  ipcMain.handle('ai:config:save', (_e, cfg) => { ctx.aiConfig = { ...ctx.aiConfig, ...cfg }; ctx.saveCfg(); return ctx.aiConfig; });
  const aiUnavail = () => ({ error: 'AI module not available' });
  ['ai:chat','ai:chat:abort','ai:models','ai:dl:url','ai:exec','ai:session:load',
   'ai:page:dom','ai:web:fetch','ai:fetch:url','ai:script:run',
   'ai:page:resources','ai:page:console','ai:scraping:isolate',
   'ai:scraping:analyze-structure','ai:scraping:extract-pattern',
   'ai:scraping:detect-dynamic','ai:scraping:discover-apis','ai:scraping:metrics',
   'ai:security:analyze-url','ai:security:analyze-html',
   'ai:auto-scrape','ai:get-cache','ai:clear-cache'].forEach(ch =>
    ipcMain.handle(ch, aiUnavail));
  ipcMain.handle('ai:decode', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rules', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rule:toggle', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:security:rule:add', () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:adblock:info', () => ({ ok: true, blockAds: false, rulesCount: 0 }));
  ipcMain.handle('ai:adblock:import', async () => ({ error: 'AI module not available' }));
  ipcMain.handle('ai:adblock:test', async () => ({ error: 'AI module not available' }));
};
// NOTE: aiFallbacks() NO se llama aquí — se llama en el catch del AI module más abajo

// Resuelve las coordenadas CSS del clic derecho (para elementFromPoint).
// params.x/y vienen en DIP; la página espera píxeles CSS. Se usa la posición
// capturada por el listener 'contextmenu' inyectado en la página (exacta),
// con fallback a la escala empírica (ancho de ventana DIP / viewport CSS).
async function resolveCtxCssPoint(wc, params) {
  try {
    const pos = await wc.executeJavaScript(`(() => {
      const p = window.__mcCtxPos;
      if (p && typeof p.x === 'number' && typeof p.y === 'number' && Date.now() - p.t < 30000) {
        return { x: Math.round(p.x), y: Math.round(p.y), src: 'page' };
      }
      return null;
    })()`);
    if (pos && typeof pos.x === 'number') return pos;
  } catch {}
  let scale = 1;
  try {
    const win = wc.getOwnerBrowserWindow();
    const size = win ? win.getContentSize() : null;
    const css = await wc.executeJavaScript('({ w: window.innerWidth || 1, h: window.innerHeight || 1 })');
    if (size && size[0] > 0 && css && css.w > 0) {
      const s = size[0] / css.w;
      if (s > 0 && s < 10) scale = s;
    }
  } catch {}
  return {
    x: Math.round((Number(params.x) || 0) / scale),
    y: Math.round((Number(params.y) || 0) / scale),
    src: 'scale'
  };
}

// === WINDOW EVENTS (popups -> nueva pestaña) ────────────
app.on('web-contents-created', (event, wc) => {
  wc.on('will-redirect', (navigationEvent, url, isInPlace, isMainFrame) => {
    let targetHost = '';
    try {
      targetHost = new URL(url).hostname.toLowerCase();
    } catch {}
    const isAllowedRedirectHost = !!targetHost && (isExplicitMediaRedirectHost(targetHost) || isVideoHost(targetHost));
    // Mantener la restricción estricta: solo bloqueamos navegación externa real
    // del frame principal, o redirecciones a subframes que no entren en la lista
    // explícita de hosts multimedia permitidos.
    if (!isMainFrame && !isAllowedRedirectHost) return;
    const sourceUrl = wc.getURL();
    try {
      const sourceHost = new URL(sourceUrl).hostname;
      if (isAuthRedirectFlow(targetHost, sourceHost)) return;
    } catch {}
    if (!allowNavigationTransition(sourceUrl, url)) {
      navigationEvent.preventDefault();
      try { mainWin?.webContents?.send('req-blocked', { type: 'navigation', url, msg: 'Redirección externa bloqueada desde ' + sourceUrl }); } catch {}
    }
  });
  wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && /^https?:\/\/(?:[^/]+\.)?whatsapp\.(?:com|net)(?:\/|$)/i.test(url)) {
      wc.setUserAgent(UA_WHATSAPP);
    }
  });
  // Captura la posición del clic derecho en píxeles CSS (exacta para elementFromPoint)
  wc.on('dom-ready', () => {
    try {
      if (wc.getType() !== 'webview') return;
      wc.executeJavaScript(`(() => {
        if (window.__mcCtxPosInstalled) return;
        window.__mcCtxPosInstalled = true;
        window.__mcCtxPos = null;
        document.addEventListener('contextmenu', (e) => {
          window.__mcCtxPos = { x: e.clientX, y: e.clientY, t: Date.now() };
        }, true);
      })()`).catch(() => {});
    } catch {}
  });
  wc.on('context-menu', async (_contextEvent, params) => {
    // Reglas cosméticas del usuario aplicables al dominio actual
    let pageDomain = '';
    try { pageDomain = new URL(wc.getURL()).hostname.replace(/^www\./i, '').toLowerCase(); } catch {}
    const allRules = (Array.isArray(CFG.userCosmeticRules) ? CFG.userCosmeticRules : [])
      .map(r => String(r || '').trim())
      .filter(r => r.includes('##'));
    const domainRules = allRules.filter(r => {
      const d = r.split('##')[0].trim().toLowerCase();
      return !d || pageDomain === d || pageDomain.endsWith('.' + d);
    });

    // Detectar si el elemento bajo el cursor ya está bloqueado por una regla cosmética
    let blockedRule = null;
    try {
      const selectors = domainRules.map(r => r.split('##')[1]);
      if (selectors.length) {
        const pt = await resolveCtxCssPoint(wc, params);
        const selectorsJson = JSON.stringify(selectors)
          .replace(/\\/g, '\\\\')
          .replace(/`/g, '\\`')
          .replace(/\$\{/g, '\\${');
        const match = await wc.executeJavaScript(`(() => {
          const px = ${pt.x};
          const py = ${pt.y};
          const el = document.elementFromPoint(px, py);
          if (!el) return null;
          const selectors = ${selectorsJson};
          let node = el;
          while (node && node.nodeType === 1) {
            for (const s of selectors) {
              try { if (node.matches(s)) return { selector: s }; } catch {}
            }
            node = node.parentElement;
          }
          return null;
        })()`);
        if (match?.selector) {
          blockedRule = allRules.find(r => r.split('##')[1].trim() === match.selector) || null;
        }
      }
    } catch {}

    const template = [
      { label: 'Atrás', enabled: wc.canGoBack(), click: () => wc.goBack() },
      { label: 'Adelante', enabled: wc.canGoForward(), click: () => wc.goForward() },
      { label: 'Recargar', click: () => wc.reload() },
      { type: 'separator' },
      { role: 'copy', enabled: Boolean(params.selectionText) },
      { role: 'selectAll', enabled: Boolean(params.isEditable || params.selectionText) },
    ];

    if (params.isEditable) {
      template.push(
        { type: 'separator' },
        { role: 'cut' },
        { role: 'paste' }
      );
    }
    if (params.linkURL) {
      template.push(
        { type: 'separator' },
        {
          label: 'Abrir enlace en nueva pestaña',
          click: () => mainWin?.webContents?.send('open-new-tab', params.linkURL)
        },
        {
          label: 'Copiar dirección del enlace',
          click: () => clipboard.writeText(params.linkURL)
        },
        {
          label: 'Descargar enlace',
          click: () => {
            if (/^https?:\/\//i.test(params.linkURL)) mainWin?.webContents?.downloadURL(params.linkURL);
            else if (params.linkURL) shell.openExternal(params.linkURL).catch(() => {});
          }
        }
      );
    }
    if (params.selectionText) {
      template.push({
        label: 'Buscar selección en nueva pestaña',
        click: () => mainWin?.webContents?.send(
          'open-new-tab',
          `https://duckduckgo.com/?q=${encodeURIComponent(params.selectionText)}`
        )
      });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      template.push(
        {
          label: 'Copiar dirección de imagen',
          click: () => clipboard.writeText(params.srcURL)
        },
        {
          label: 'Descargar imagen',
          click: () => {
            if (/^https?:\/\//i.test(params.srcURL)) mainWin?.webContents?.downloadURL(params.srcURL);
          }
        }
      );
    }
    if (params.srcURL && params.mediaType !== 'none') {
      template.push(
        {
          label: 'Abrir recurso multimedia',
          click: () => mainWin?.webContents?.send('open-new-tab', params.srcURL)
        },
        {
          label: 'Descargar multimedia',
          click: () => {
            if (/^https?:\/\//i.test(params.srcURL)) mainWin?.webContents?.downloadURL(params.srcURL);
          }
        }
      );
    }
    if (blockedRule) {
      template.push(
        { type: 'separator' },
        {
          label: 'Desbloquear este elemento',
          click: async () => {
            CFG.userCosmeticRules = (CFG.userCosmeticRules || []).filter(r => r !== blockedRule);
            saveCfg();
            try { wc.reload(); } catch {}
            mainWin?.webContents?.send('cosmetic-unblock-result', { ok: true, rule: blockedRule });
          }
        }
      );
    }
    if (domainRules.length) {
      template.push(
        { type: 'separator' },
        {
          label: 'Desbloquear elemento...',
          submenu: domainRules.map(rule => ({
            label: rule.split('##')[1],
            click: () => {
              CFG.userCosmeticRules = (CFG.userCosmeticRules || []).filter(r => r !== rule);
              saveCfg();
              try { wc.reload(); } catch {}
              mainWin?.webContents?.send('cosmetic-unblock-result', { ok: true, rule });
            }
          }))
        }
      );
    }
    template.push(
      { type: 'separator' },
      {
        label: 'Bloquear este elemento',
        click: async () => {
          try {
            const pt = await resolveCtxCssPoint(wc, params);
            const px = pt.x;
            const py = pt.y;
            const info = await wc.executeJavaScript(`(() => {
              const px = ${px};
              const py = ${py};
              const isUsable = (e) => e && e.nodeType === 1 && e !== document.documentElement && e !== document.body;
              let el = document.elementFromPoint(px, py);
              if (!isUsable(el)) {
                const all = document.elementsFromPoint(px, py);
                for (const e of all) { if (isUsable(e)) { el = e; break; } }
              }
              // Refinar si el elemento es enorme (>40% del viewport): buscar iframes
              // cerca del punto (banners en blanco/colapsados o con pointer-events:none
              // que elementFromPoint ignora) o el elemento más pequeño en el punto
              if (isUsable(el)) {
                const r = el.getBoundingClientRect();
                const vw = window.innerWidth, vh = window.innerHeight;
                if (r.width * r.height > vw * vh * 0.4) {
                  let bestIframe = null, bestDist = Infinity;
                  for (const f of document.querySelectorAll('iframe')) {
                    const fr = f.getBoundingClientRect();
                    const w = fr.width || (parseInt(f.getAttribute('width'), 10) || 0);
                    const h = fr.height || (parseInt(f.getAttribute('height'), 10) || 0);
                    if (w < 8 || h < 8) continue;
                    const cx = Math.max(fr.left, Math.min(px, fr.right));
                    const cy = Math.max(fr.top, Math.min(py, fr.bottom));
                    const dist = Math.hypot(px - cx, py - cy);
                    if (dist < bestDist) { bestDist = dist; bestIframe = f; }
                  }
                  if (bestIframe && bestDist < 200) {
                    el = bestIframe;
                  } else {
                    const all = document.elementsFromPoint(px, py);
                    let best = null, bestArea = Infinity;
                    for (const e of all) {
                      if (!isUsable(e) || e === el) continue;
                      const er = e.getBoundingClientRect();
                      if (er.width < 24 || er.height < 24) continue;
                      if (er.width * er.height > vw * vh * 0.4) continue;
                      const area = er.width * er.height;
                      if (area < bestArea) { bestArea = area; best = e; }
                    }
                    if (best) el = best;
                  }
                }
              }
              if (!isUsable(el)) {
                let best = null, bestArea = Infinity, scanned = 0;
                const nodes = document.querySelectorAll('body *');
                for (const e of nodes) {
                  if (++scanned > 4000) break;
                  if (!isUsable(e)) continue;
                  const r = e.getBoundingClientRect();
                  if (r.width < 8 || r.height < 8) continue;
                  if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                    const area = r.width * r.height;
                    if (area < bestArea) { bestArea = area; best = e; }
                  }
                }
                el = best;
              }
              if (!isUsable(el)) return null;
              const cssPath = (node) => {
                const parts = [];
                let cur = node;
                while (cur && cur.nodeType === 1 && parts.length < 6) {
                  let part = cur.tagName.toLowerCase();
                  if (cur.id) {
                    part += '#' + CSS.escape(cur.id).slice(0, 80);
                    parts.unshift(part);
                    break;
                  }
                  const parent = cur.parentElement;
                  if (parent) {
                    const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
                    if (siblings.length > 1) {
                      part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
                    }
                  }
                  if (cur.classList && cur.classList.length) {
                    part += '.' + [...cur.classList].slice(0, 3).map(c => CSS.escape(c)).join('.');
                  }
                  parts.unshift(part);
                  cur = cur.parentElement;
                }
                return parts.join(' > ');
              };
              const selector = cssPath(el);
              try {
                el.setAttribute('data-mc-blocked', '1');
                el.style.setProperty('display', 'none', 'important');
                el.style.setProperty('visibility', 'hidden', 'important');
                el.style.setProperty('height', '0', 'important');
                el.style.setProperty('max-height', '0', 'important');
                el.style.setProperty('overflow', 'hidden', 'important');
              } catch {}
              return {
                selector,
                tag: el.tagName.toLowerCase(),
                domain: location.hostname.replace(/^www\\./i, '').toLowerCase(),
                pageUrl: location.href
              };
            })()`);
            if (!info?.selector || !info?.domain) {
              mainWin?.webContents?.send('cosmetic-block-result', { ok: false, error: 'No se pudo identificar el elemento' });
              return;
            }
            const raw = `${info.domain}##${info.selector}`;
            if (!Array.isArray(CFG.userCosmeticRules)) CFG.userCosmeticRules = [];
            if (!CFG.userCosmeticRules.includes(raw)) {
              CFG.userCosmeticRules.push(raw);
              saveCfg();
            }
            try {
              await wc.insertCSS(`${info.selector}{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;}`);
            } catch {}
            mainWin?.webContents?.send('cosmetic-block-result', { ok: true, rule: raw, domain: info.domain, selector: info.selector });
          } catch (error) {
            mainWin?.webContents?.send('cosmetic-block-result', { ok: false, error: error.message || 'No se pudo bloquear el elemento' });
          }
        }
      },
      {
        label: 'Diagnosticar elemento con IA (adblock)',
        click: async () => {
          try {
            const pt = await resolveCtxCssPoint(wc, params);
            const element = await wc.executeJavaScript(`(() => {
              const px = ${pt.x};
              const py = ${pt.y};
              const el = document.elementFromPoint(px, py);
              if (!el) return null;

              const adTokens = /ad|ads|advert|banner|sponsor|promo|popunder|popup|interstitial|tracking|tracker|pixel|beacon|syndication|doubleclick|taboola|outbrain|criteo|exoclick|propeller|monetag|adsterra|popads|clickadu|adcash|juicyads|trafficjunky|zergnet|revcontent|mgid|adnxs|prebid|dfp|gpt|adsbygoogle|adserver|adframe|adslot|ad-container|ad_wrapper|adblock|sponsored/i;
              const trackerHosts = /doubleclick|googlesyndication|googleadservices|adnxs|adsrvr|rubicon|criteo|pubmatic|openx|taboola|outbrain|exoclick|propeller|monetag|adsterra|popads|hotjar|clarity|scorecardresearch|quantserve|facebook\\.com\\/tr|analytics|pixel|beacon/i;

              const short = (v, n = 300) => String(v || '').slice(0, n);
              const cssPath = (node) => {
                const parts = [];
                let cur = node;
                while (cur && cur.nodeType === 1 && parts.length < 10) {
                  let part = cur.tagName.toLowerCase();
                  if (cur.id) part += '#' + CSS.escape(cur.id).slice(0, 80);
                  else if (cur.classList.length) part += '.' + [...cur.classList].slice(0, 4).map(CSS.escape).join('.');
                  parts.unshift(part);
                  cur = cur.parentElement;
                }
                return parts.join(' > ');
              };

              const styleOf = (node) => {
                try {
                  const cs = getComputedStyle(node);
                  return {
                    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                    position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents,
                    width: cs.width, height: cs.height, overflow: cs.overflow,
                    transform: short(cs.transform, 120), filter: short(cs.filter, 80)
                  };
                } catch { return {}; }
              };

              const rect = el.getBoundingClientRect();
              const attrs = Object.fromEntries([...el.attributes].slice(0, 40).map(a => [a.name, short(a.value, 400)]));
              const text = short((el.innerText || el.textContent || '').trim(), 800);
              const html = short(el.outerHTML, 5000);

              const parents = [];
              let node = el.parentElement;
              while (node && node.nodeType === 1 && parents.length < 8) {
                parents.push({
                  tag: node.tagName.toLowerCase(),
                  id: node.id || undefined,
                  classes: [...node.classList].slice(0, 6),
                  role: node.getAttribute('role') || undefined,
                  suspicious: adTokens.test((node.id || '') + ' ' + [...node.classList].join(' ') + ' ' + (node.getAttribute('data-ad') || ''))
                });
                node = node.parentElement;
              }

              const iframe = el.closest('iframe, frame, embed, object');
              const mediaEl = el.closest('video, audio, img, picture, source');
              const shadowHost = (() => {
                let n = el;
                while (n) {
                  if (n.host) return { tag: n.host.tagName?.toLowerCase(), selector: cssPath(n.host) };
                  n = n.parentNode;
                }
                return null;
              })();

              const relatedResources = (performance.getEntriesByType('resource') || [])
                .map(r => r.name)
                .filter(url => {
                  const u = url.toLowerCase();
                  const hints = [el.id, ...el.classList, el.getAttribute('src'), el.getAttribute('href'), el.getAttribute('data-src')].filter(Boolean).join(' ').toLowerCase();
                  return trackerHosts.test(u) || adTokens.test(u) || (hints && u.includes(short(hints, 40).replace(/\\s+/g, '')));
                })
                .slice(0, 20)
                .map(url => ({ url: short(url, 220), tracker: trackerHosts.test(url), adLike: adTokens.test(url) }));

              const scriptsNearby = [...document.scripts]
                .map(s => s.src || (s.textContent || '').trim().slice(0, 120))
                .filter(src => src && (trackerHosts.test(src) || adTokens.test(src)))
                .slice(0, 12);

              const suspiciousSignals = [];
              if (adTokens.test((el.id || '') + ' ' + [...el.classList].join(' ') + ' ' + Object.values(attrs).join(' '))) suspiciousSignals.push('id/class/atributos con tokens publicitarios');
              if (iframe) suspiciousSignals.push('dentro de iframe/embed/object');
              if (styleOf(el).position === 'fixed' || styleOf(el).position === 'absolute') suspiciousSignals.push('posicion flotante (' + styleOf(el).position + ', z-index ' + styleOf(el).zIndex + ')');
              if (parseFloat(styleOf(el).opacity) < 0.2) suspiciousSignals.push('opacidad muy baja');
              if (rect.width < 2 || rect.height < 2) suspiciousSignals.push('elemento casi invisible');
              if (el.tagName === 'IFRAME' && el.src && !el.src.startsWith(location.origin)) suspiciousSignals.push('iframe cross-origin: ' + short(el.src, 180));
              if (relatedResources.length) suspiciousSignals.push(relatedResources.length + ' recursos de red sospechosos');

              return {
                mode: 'adblock-diagnosis',
                tag: el.tagName.toLowerCase(),
                text,
                attributes: attrs,
                selector: cssPath(el),
                html,
                boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                computedStyle: styleOf(el),
                parents,
                iframe: iframe ? { tag: iframe.tagName.toLowerCase(), src: short(iframe.src || iframe.getAttribute('src'), 300), sandbox: iframe.getAttribute('sandbox'), allow: iframe.getAttribute('allow') } : null,
                media: mediaEl ? { tag: mediaEl.tagName.toLowerCase(), src: short(mediaEl.currentSrc || mediaEl.src || mediaEl.getAttribute('src'), 300) } : null,
                shadowHost,
                suspiciousSignals,
                relatedResources,
                scriptsNearby,
                clickPoint: { x: px, y: py },
                pageUrl: location.href,
                pageTitle: document.title || location.hostname,
                viewport: { width: innerWidth, height: innerHeight }
              };
            })()`);
            if (element) mainWin?.webContents?.send('ai-element-selected', element);
          } catch (error) {
            mainWin?.webContents?.send('ai-element-selected', { error: error.message || 'No se pudo inspeccionar el elemento' });
          }
        }
      },
      { label: 'Inspeccionar elemento', click: () => wc.inspectElement(params.x, params.y) }
    );

    template.push({
      label: 'Extraer imágenes y enlaces directos',
      click: async () => {
        try {
          const resources = await wc.executeJavaScript(`(() => {
            try {
              const found = [];
              const add = (url, type, label) => {
                if (!url || !/^https?:\\/\\//i.test(url)) return;
                let absolute;
                try { absolute = new URL(url, location.href).href; } catch (e) { return; }
                if (!found.some(item => item.url === absolute)) found.push({ url: absolute, type, label });
              };
              document.querySelectorAll('img').forEach((el, index) => add(el.currentSrc || el.src, 'image', el.alt || 'Imagen ' + (index + 1)));
              document.querySelectorAll('video, audio').forEach((el, index) => {
                add(el.currentSrc || el.src, el.tagName.toLowerCase(), el.getAttribute('title') || el.getAttribute('aria-label') || el.tagName + ' ' + (index + 1));
                el.querySelectorAll('source').forEach(source => add(source.src, el.tagName.toLowerCase(), source.type || 'source'));
              });
              document.querySelectorAll('a[href]').forEach((el, index) => add(el.href, 'link', (el.innerText || el.textContent || '').trim().slice(0, 100) || 'Enlace ' + (index + 1)));
              document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(el => add(el.content, 'image', 'Imagen social'));
              return { page: location.href, title: document.title || location.hostname, resources: found.slice(0, 500) };
            } catch (e) {
              return { page: location.href, title: document.title || location.hostname, resources: [], error: String(e && e.message || e) };
            }
          })()`);
          mainWin?.webContents?.send('page-extract-results', resources);
        } catch (error) {
          mainWin?.webContents?.send('page-extract-results', { error: error.message || 'No se pudo extraer la página' });
        }
      }
    });
    Menu.buildFromTemplate(template).popup({ window: mainWin });
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Bloquear siempre popups claramente publicitarios/de seguimiento.
    if (isAggressiveAdNavigation(url)) {
      return { action: 'deny' };
    }
    // OAuth de Google/X debe abrirse normalmente dentro de la sesión actual.
    // Forzar deny/redirect aquí rompe el flujo y evita que aparezca la pantalla
    // de login del segundo usuario.
    if (isAuthPopupUrl(url)) {
      return { action: 'allow' };
    }
    // Para TODO lo demás, impedimos que Chromium abra una ventana nativa.
    // La conversión a pestaña (una sola vez) queda exclusivamente a cargo
    // del evento 'new-window' del webview en renderer.html, que filtra por
    // mismo dominio. Evitamos aqui el segundo 'open-new-tab' que provocaba
    // la aparición de varias pestañas duplicadas al pulsar Descargar.
    return { action: 'deny' };
  });
});

// === APP LIFECYCLE ===
// Bloqueo de instancia única: si ya hay una instancia de MC Browser corriendo,
// la nueva se cierra y enfoca la ventana existente. Evita conflictos de caché/
// sesión (persist:mc) que rompen WhatsApp al lanzar el proyecto varias veces.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.focus();
      }
    } catch {}
  });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  createWindow();
  const sess = session.fromPartition('persist:mc');
  ACTIONS.emit = (ch, ...args) => { try { mainWin?.webContents?.send(ch, ...args); } catch {} };
  // Desactivado: la señalización automática de auth-session-updated provoca
  // redirecciones durante el flujo OAuth de Google/X y rompe el login de la
  // segunda cuenta. El navegador debe dejar completar la autenticación sin
  // interrumpir la sesión del proveedor.
  let authCookieTimer = null;
  if (CFG.proxyEnabled && CFG.proxyHost) {
    sess.setProxy({ proxyRules: `${CFG.proxyType || 'socks5'}://${CFG.proxyHost}:${CFG.proxyPort || 1080}` }).catch(e => console.error('[PROXY]', e.message));
  }

  // ── Descargas nativas del navegador (will-download) ──
  // Captura descargas normales (botón "Descargar", enlaces directos, etc.)
  // que no pasan por el detector de streams, y las muestra en el panel.
  sess.on('will-download', (event, item, webContents) => {
    try {
      const url = item.getURL() || '';
      const filename = item.getFilename() || 'descarga';
      const totalBytes = item.getTotalBytes();
      const pageUrl = webContents?.getURL?.() || '';
      const dlId = 'dl-native-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const dlDir = CFG.downloadDir || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      // Guardar en la carpeta de descargas configurada
      item.setSavePath(path.join(dlDir, filename));

      // Avisar al renderer para cerrar la pestaña popup que solo sirvió
      // para iniciar esta descarga (comportamiento de navegadores normales:
      // la pestaña de descarga se abre y se cierra sola).
      try {
        mainWin?.webContents?.send('dl-native-tab', { wcId: webContents?.id });
      } catch {}

      ACTIONS.emit('dl-native', {
        id: dlId,
        url,
        filename,
        totalBytes,
        pageUrl,
        state: 'active'
      });

      item.on('updated', (e, state) => {
        const received = item.getReceivedBytes();
        const pct = totalBytes > 0 ? Math.round(received / totalBytes * 100) : 0;
        ACTIONS.emit('dl-native-progress', {
          id: dlId,
          url,
          filename,
          received,
          totalBytes,
          pct,
          state
        });
      });

      item.on('done', (e, state) => {
        const received = item.getReceivedBytes();
        const size = (received / 1048576).toFixed(1);
        const filePath = item.getSavePath();
        ACTIONS.emit('dl-native-done', {
          id: dlId,
          url,
          filename,
          file: filePath,
          size,
          state,
          cancelled: state === 'cancelled' || state === 'interrupted'
        });
      });
    } catch (e) {
      console.error('[DL-NATIVE]', e.message);
    }
  });

  // ── Live request log & cookie interception ──
  sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!/^https?:\/\//i.test(d.url || '')) return cb({ requestHeaders: d.requestHeaders });
    const headers = { ...d.requestHeaders };
    const isMediaRequest = d.resourceType === 'media' || /\.(?:m3u8|mpd|ts|m4s|mp4|aac|mp3|webm)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(d.url);
    const isMainFrame = d.resourceType === 'mainFrame' || d.resourceType === 'main_frame';
    const targetHost = new URL(d.url).hostname;
    const docHost = d.documentUrl ? new URL(d.documentUrl).hostname : '';
    const isAuthDocument = !!docHost && isAuthDomain(docHost);
    if (isAuthDomain(targetHost) || isAuthDocument || isAuthRedirectFlow(targetHost, docHost)) {
      return cb({ requestHeaders: headers });
    }
    if (CFG.strictDomainIsolation && !isMainFrame && d.documentUrl && !isMediaRequest && !isTrustedResource(d.url, d.documentUrl)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'cookie') delete headers[key];
      }
    }
    if (CFG.language) headers['Accept-Language'] = `${CFG.language},en;q=0.8`;
    if (CFG.refererPolicy === 'no-referrer' && !isMediaRequest) {
      delete headers.Referer;
      delete headers.referer;
    } else if (CFG.refererPolicy === 'origin' && headers.Referer) {
      try { headers.Referer = new URL(headers.Referer).origin + '/'; } catch {}
    }
    // WhatsApp (regla especial): alinear Client Hints con UA_WHATSAPP (Chrome 140)
    // para evitar el error de "navegador no compatible"
    try {
      const host = new URL(d.url).hostname.toLowerCase();
      if (host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com') || host.endsWith('.whatsapp.net')) {
        const setHdr = (name, value) => {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
          }
          headers[name] = value;
        };
        setHdr('sec-ch-ua', '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="99"');
        setHdr('sec-ch-ua-full-version', '"140.0.0.0"');
        setHdr('sec-ch-ua-platform', '"Windows"');
        setHdr('sec-ch-ua-mobile', '?0');
      }
    } catch {}
    cb({ requestHeaders: headers });
  });
  sess.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!/^https?:\/\//i.test(d.url || '')) return cb({ responseHeaders: d.responseHeaders });
    try {
      const responseHeaders = { ...d.responseHeaders };
      const host = new URL(d.url).hostname.toLowerCase();
      const docHost = d.documentUrl ? new URL(d.documentUrl).hostname.toLowerCase() : '';
      const isMediaRequest = d.resourceType === 'media' || /\.(?:m3u8|mpd|ts|m4s|mp4|aac|mp3|webm)(?:[?#]|$)|(?:segment|chunk|playlist|\/stream(?:\/|$))/i.test(d.url);
      if (isAuthDomain(host) || isAuthDomain(docHost) || isAuthRedirectFlow(host, docHost)) {
        return cb({ responseHeaders });
      }
      const cookieKey = responseHeaders['set-cookie'] ? 'set-cookie' : 'Set-Cookie';
      if (d.responseHeaders) {
        const setCookie = d.responseHeaders['set-cookie'] || d.responseHeaders['Set-Cookie'];
        if (setCookie) {
          const domain = host;
          const thirdParty = CFG.strictDomainIsolation && d.documentUrl && !isTrustedResource(d.url, d.documentUrl) && !isMediaRequest;
          const allowPolicy = getAllowlistPolicyForHost(domain);
          const blocked = thirdParty || allowPolicy === 'block';
          if (blocked && mainWin && !mainWin.isDestroyed()) {
            for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
              mainWin.webContents.send('cookie-intercepted', { action: 'blocked', domain, cookie: c });
            }
            STATS.cookiesBlocked += Array.isArray(setCookie) ? setCookie.length : 1;
          }
          if (thirdParty || allowPolicy === 'session' || (CFG.cookiePolicy === 'session' && allowPolicy !== 'allow')) {
            const sessionCookies = (value) => String(value)
              .replace(/;\s*expires=[^;]*/gi, '')
              .replace(/;\s*max-age=[^;]*/gi, '');
            if (thirdParty) delete responseHeaders[cookieKey];
            else responseHeaders[cookieKey] = Array.isArray(setCookie)
              ? setCookie.map(sessionCookies)
              : sessionCookies(setCookie);
          }
        }
      }
      return cb({ responseHeaders });
    } catch (e) { /* ignore header parse errors */ }
    cb({});
  });
  sess.cookies.on('changed', (event, cookie, removed, cause) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const action = removed ? 'removed' : 'allowed';
    const summary = `${cookie.name || 'cookie'}=${cookie.value || ''}`.substring(0, 160);
    mainWin.webContents.send('cookie-intercepted', {
      action,
      domain: cookie.domain || '',
      cookie: summary + (removed ? ` (${cause || 'removed'})` : '')
    });
  });

  // === MEMORY SYSTEM (file-based JSON) ===
  const MEMORY_DIR = path.join(app.getPath('userData'), 'memory');
  const ENTRIES_FILE = path.join(MEMORY_DIR, 'entries.json');
  const REMINDERS_FILE = path.join(MEMORY_DIR, 'reminders.json');

  function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
  function loadJson(file, fallback = []) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    return fallback;
  }
  function saveJson(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }
  function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  ensureDir(MEMORY_DIR);

  ipcMain.handle('memory:list', (e, filters = {}) => {
    let entries = loadJson(ENTRIES_FILE, []);
    if (filters.type) entries = entries.filter(en => en.type === filters.type);
    if (filters.status) entries = entries.filter(en => en.status === filters.status);
    if (filters.tags) entries = entries.filter(en => filters.tags.some(t => (en.tags || []).includes(t)));
    return entries.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  });
  ipcMain.handle('memory:search', (e, query) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const q = String(query).toLowerCase();
    return entries.filter(en => {
      const hay = [en.title, en.summary, en.description, en.url, ...(en.tags || []), ...(en.keywords || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }).slice(0, 20);
  });
  ipcMain.handle('memory:add', (e, entry) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const now = Date.now();
    const newEntry = {
      id: genId(), type: entry.type || 'note', title: entry.title || 'Sin título',
      url: entry.url || '', summary: entry.summary || '', description: entry.description || '',
      mainHeading: entry.mainHeading || '', tags: entry.tags || [], keywords: entry.keywords || [],
      createdAt: now, updatedAt: now, importance: entry.importance || 'medium',
      status: entry.status || 'active', notes: entry.notes || '',
      reminderDate: entry.reminderDate || null, linkedEntries: entry.linkedEntries || []
    };
    entries.unshift(newEntry);
    saveJson(ENTRIES_FILE, entries);
    return newEntry;
  });
  ipcMain.handle('memory:update', (e, id, patch) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const idx = entries.findIndex(en => en.id === id);
    if (idx === -1) return { error: 'Not found' };
    entries[idx] = { ...entries[idx], ...patch, updatedAt: Date.now() };
    saveJson(ENTRIES_FILE, entries);
    return entries[idx];
  });
  ipcMain.handle('memory:delete', (e, id) => {
    const entries = loadJson(ENTRIES_FILE, []);
    saveJson(ENTRIES_FILE, entries.filter(en => en.id !== id));
    return { ok: true };
  });
  ipcMain.handle('memory:archive', (e, id) => {
    const entries = loadJson(ENTRIES_FILE, []);
    const idx = entries.findIndex(en => en.id === id);
    if (idx === -1) return { error: 'Not found' };
    entries[idx].status = 'archived';
    entries[idx].updatedAt = Date.now();
    saveJson(ENTRIES_FILE, entries);
    return entries[idx];
  });
  ipcMain.handle('memory:recent', (e, limit = 10) => {
    const entries = loadJson(ENTRIES_FILE, []);
    return entries.filter(en => en.status === 'active').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
  });

  ipcMain.handle('reminders:list', (e, filters = {}) => {
    let reminders = loadJson(REMINDERS_FILE, []);
    if (filters.pending) reminders = reminders.filter(r => !r.completed);
    return reminders.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));
  });
  ipcMain.handle('reminders:add', (e, reminder) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    const newReminder = {
      id: genId(), text: reminder.text || 'Recordatorio', completed: false,
      createdAt: Date.now(), dueDate: reminder.dueDate || null,
      priority: reminder.priority || 'normal', linkedEntryId: reminder.linkedEntryId || null
    };
    reminders.unshift(newReminder);
    saveJson(REMINDERS_FILE, reminders);
    return newReminder;
  });
  ipcMain.handle('reminders:complete', (e, id) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) return { error: 'Not found' };
    reminders[idx].completed = true;
    reminders[idx].completedAt = Date.now();
    saveJson(REMINDERS_FILE, reminders);
    return reminders[idx];
  });
  ipcMain.handle('reminders:delete', (e, id) => {
    const reminders = loadJson(REMINDERS_FILE, []);
    saveJson(REMINDERS_FILE, reminders.filter(r => r.id !== id));
    return { ok: true };
  });

  // AI module
  try {
    const m = require('./modules/ai-assistant/main');
    m.setup({ cfg: CFG, aiConfig: CFG.aiConfig, saveCfg, emit: ACTIONS.emit, getMainWin: () => mainWin });
  } catch (e) {
    console.error('[AI]', e.message);
    aiFallbacks({ aiConfig: CFG.aiConfig, saveCfg });
  }

  // WhatsApp extractor module (independiente)
  try {
    const m = require('./modules/whatsapp-extractor/main');
    m.setup({ cfg: CFG });
  } catch (e) { console.error('[WA-EXTRACT]', e.message); }

  // ── Media detection (stream hunter) ─────────────────

  function checkMedia(u, pageUrl, resourceType) {
    if (!CFG.mediaDetect) return;
    if (SKIP_EXT_RE.test(u) || /^(about|data|javascript):/i.test(u)) return;
    // Omitir segmentos HLS sueltos — solo playlists y archivos directos
    if (/\.ts(\?|#|$)/i.test(u)) return;
    if (/\/seg(?:ment)?[\d._-]/i.test(u)) return;
    const hasMediaToken = /[?&](token|exp|sign|auth|st|nonce|signature|hls|m3u8|mpd|playlist)=/i.test(u);
    if (!MEDIA_RE.test(u) && !(resourceType === 'media' && hasMediaToken)) return;
    if (MEDIA_URLS.find(m => m.url === u)) return;
    const type = HLS_RE.test(u) ? 'HLS' : u.includes('.mpd') ? 'DASH' : 'MP4';
    const entry = { url: u, pageUrl: pageUrl || '', type, ts: new Date().toISOString() };
    MEDIA_URLS.push(entry);
    if (MEDIA_URLS.length > 500) MEDIA_URLS.splice(0, MEDIA_URLS.length - 500);
    STATS.detectedMedia++;
    ACTIONS.emit('media-detected', { ...entry, count: STATS.detectedMedia });
    ACTIONS.emit('stats-update', { ...STATS, uptime: Date.now() - STATS.uptimeStart });
  }

  // Adblocker module
  try {
    const m = require('./modules/adblocker/main');
    const ret = m.setup({ cfg: CFG, saveCfg, emit: ACTIONS.emit, session: sess, allowedDomains: AUTH_DOMAINS, mediaCallback: checkMedia, requestCallback: recordObservedRequest, blockCallback: recordBlockedRequest, requestGuard: createRequestGuard() });
    if (ret && ret.toggleBlocking) ACTIONS.adblockToggle = ret.toggleBlocking;
  } catch (e) { console.error('[ADBLOCK]', e.message); }

  // Apply initial DoH config if enabled
  applyDoH();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  saveCfg();
  if (process.platform !== 'darwin') app.quit();
});
