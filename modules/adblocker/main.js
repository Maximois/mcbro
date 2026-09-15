'use strict';

const { ipcMain, session } = require('electron');
const { ListManager, FILTER_LISTS } = require('./lists');
const { Engine } = require('./engine');

// Estado compartido del módulo (se inicializa en setup)
let cfg = null;
let authDomainsList = [];

// ── Built-in fallback domains (funciona sin descargar listas) ─
const FALLBACK_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'criteo.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', 'moatads.com',
  'sharethrough.com', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'scorecardresearch.com', 'quantserve.com',
  'media.net', 'bluekai.com', 'demdex.net', 'krxd.net', 'rlcdn.com',
  'addthis.com', 'hotjar.com', 'clarity.ms',
  'bat.bing.com', 'pixel.quantserve.com',
  'pagead2.googlesyndication.com',
  'cdn.onesignal.com', 'pushcrew.com',
  'adservice.google.com',
  'ads.linkedin.com', 'analytics.twitter.com',
  'sb.scorecardresearch.com', 'b.scorecardresearch.com',
  'c.amazon-adsystem.com',
  'creativecdn.com', 'exdynsrv.com', 'adskeeper.co.uk',
  'exoclick.com', 'popads.net', 'popunder.net',
  'trafficfactory.biz', 'adcash.com',
  'adf.ly', 'shorte.st', 'sh.st', 'bit.ly',
];

// Redes publicitarias / trackers conocidos (dominio o subdominio).
// Solo se bloquean hosts que pertenecen a estas redes, nunca por labels
// genéricos (ad/click/pop/track...) que rompen sitios legítimos.
const AD_NETWORK_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'criteo.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', 'moatads.com',
  'sharethrough.com', 'taboola.com', 'outbrain.com',
  'amazon-adsystem.com', 'scorecardresearch.com', 'quantserve.com',
  'media.net', 'bluekai.com', 'demdex.net', 'krxd.net', 'rlcdn.com',
  'addthis.com', 'hotjar.com', 'clarity.ms',
  'bat.bing.com', 'pagead2.googlesyndication.com',
  'cdn.onesignal.com', 'pushcrew.com', 'adservice.google.com',
  'ads.linkedin.com', 'analytics.twitter.com',
  'creativecdn.com', 'exdynsrv.com', 'adskeeper.co.uk',
  'exoclick.com', 'popads.net', 'popunder.net',
  'trafficfactory.biz', 'adcash.com', 'adf.ly', 'shorte.st', 'sh.st', 'bit.ly',
  'monetag.com', 'propellerads.com', 'adsterra.com', 'hilltopads.com',
  'popcash.net', 'revenuehits.com', 'juicyads.com', 'ad-maven.com',
  'onclickads.net', 'pushnotifications.com'
];

// Tokens de ruta claramente publicitarios (formato VAST, /ads/, etc.).
const AD_PATH_TOKENS = [
  '/ads/', '/adserver', '/adframe', '/popunder', '/click-redirect',
  '/popup', '/popads', '/advert', '/banner', '/vast',
  'adsbygoogle', 'pagead', 'prebid', 'adservice', 'adsystem',
  'doubleclick', 'googlesyndication', 'googleadservices'
];
const TRACKER_TOKENS = /analytics|tracking|tracker|telemetry|pixel|beacon|scorecardresearch|quantserve|demdex|hotjar|clarity\.ms/i;

function isAggressiveAdNavigation(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!host) return false;
    const lower = rawUrl.toLowerCase();
    // Redes publicitarias conocidas (dominio o subdominio).
    if (AD_NETWORK_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
    // Tokens de ruta claramente publicitarios.
    if (AD_PATH_TOKENS.some(t => lower.includes(t))) return true;
    return false;
  } catch {
    return false;
  }
}

// YouTube: los streams de anuncios vienen de googlevideo.com con parámetros
// ad_ en la URL (indistinguibles por dominio, pero distinguibles por URL).
// Bloquearlos hace que YouTube salte el anuncio (como hace Brave/uBlock).
function isYouTubeAdStream(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host !== 'googlevideo.com' && !host.endsWith('.googlevideo.com')) return false;
    return /[?&]ad_/i.test(url.search) || /ad_signature/i.test(url.search);
  } catch {
    return false;
  }
}

// ── Aislamiento estricto de terceros (port desde Android) ──
// Equivalente a isUntrustedThirdPartyResource: corta recursos incrustados
// (iframe/frame/embed/object) cuyo dominio no es el del documento actual.
const VIDEO_HOSTS = [
  'mega.nz', 'pixeldrain.com', 'filemoon.to', 'filemoon.sx', 'filemoon.in',
  'savefiles', 'playmogo', 'mixdrop', 'miixdrop', 'dood', 'voe', 'mxdrop',
  'lulu', 'mp4upload', 'streamwish'
];

const TRUSTED_CROSS_ORIGINS = {
  'google.com': ['gstatic.com', 'googleusercontent.com', 'googleapis.com', 'accounts.google.com', 'oauth.googleusercontent.com'],
  'youtube.com': ['ytimg.com', 'googlevideo.com', 'googleusercontent.com'],
  'microsoft.com': ['microsoftonline.com', 'live.com', 'office.net'],
  'github.com': ['githubusercontent.com', 'githubassets.com'],
  'apple.com': ['icloud.com', 'apple-cloudkit.com'],
  'x.com': ['twitter.com', 'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'twimg.com', 'api.x.com', 'oauth.x.com'],
  'twitter.com': ['x.com', 'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'twimg.com', 'api.x.com', 'oauth.x.com'],
  'x.ai': ['x.com', 'twitter.com', 'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'accounts.x.ai', 'oauth.x.ai', 'auth.x.ai'],
  'grok.com': ['x.com', 'twitter.com', 'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'x.ai', 'accounts.x.ai'],
  'perplexity.ai': ['pplx-next-static-public.perplexity.ai', 'pplx-next-public.perplexity.ai', 'www.perplexity.ai', 'api.perplexity.ai'],
  'deepseek.com': ['api.deepseek.com', 'www.deepseek.com'],
  'whatsapp.com': ['whatsapp.net', 'whatsapp.org', 'fbcdn.net'],
  'whatsapp.net': ['whatsapp.com', 'whatsapp.org', 'fbcdn.net'],
  'facebook.com': ['instagram.com', 'facebook.net', 'connect.facebook.net', 'fbcdn.net', 'accountscenter.facebook.com', 'graph.facebook.com', 'api.instagram.com', 'cdninstagram.com'],
  'instagram.com': ['facebook.com', 'facebook.net', 'connect.facebook.net', 'fbcdn.net', 'accountscenter.facebook.com', 'graph.facebook.com', 'api.instagram.com', 'cdninstagram.com']
};

// En Electron 30: subFrame = iframe/frame, object = embed/object.
const EMBEDDED_TYPES = new Set([
  'subFrame', 'subframe', 'subdocument', 'object'
]);
const VIDEO_PATH_RE = /(?:^|[/?_-])(embed|player|watch|video|stream|playlist|manifest|play|e|f)(?:[/?_.=-]|$)|\.(?:m3u8|mpd|mp4|webm|ts|m4s)(?:[?#]|$)/i;

function isPerchanceHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\.+/, '');
  return value === 'perchance.org' || value.endsWith('.perchance.org');
}

function isPerchanceCompatibilityRequest(resourceHost, documentHost) {
  if (!isPerchanceHost(documentHost)) return false;
  const host = String(resourceHost || '').toLowerCase().replace(/^\.+/, '');
  return isPerchanceHost(host) || host === 'esm.sh' || host.endsWith('.esm.sh') ||
    host === 'user.uploads.dev' || host.endsWith('.user.uploads.dev') ||
    host === 'aigc.uploads.dev' || host.endsWith('.aigc.uploads.dev') ||
    host === 'editable.uploads.dev' || host.endsWith('.editable.uploads.dev') ||
    host === 'cdn.jsdelivr.net' || host === 'cdnjs.cloudflare.com' || host === 'unpkg.com' ||
    host === 'huggingface.co' || host.endsWith('.huggingface.co') ||
    host === 'hf.co' || host.endsWith('.hf.co') || host === 'xethub.hf.co' ||
    host === 'fonts.googleapis.com' || host === 'gstatic.com' || host.endsWith('.gstatic.com') ||
    host === 'static.cloudflareinsights.com';
}

function isVideoHost(host) {
  return VIDEO_HOSTS.some(v => host === v || host.includes(v));
}

function isSiteAllowed(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost || !cfg?.permissions) return false;
  return Object.entries(cfg.permissions).some(([rawDomain, value]) => {
    const domain = normalizeHost(rawDomain).replace(/^www\./, '');
    const rules = value && typeof value === 'object' ? value : {};
    return rules.site === 'allow' && (normalizedHost === domain || normalizedHost.endsWith('.' + domain));
  });
}

function isExplicitlyBlocked(host, documentUrl) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost || !Array.isArray(cfg?.customRules)) return false;
  let docHost = '';
  try {
    if (documentUrl) docHost = new URL(documentUrl).hostname.toLowerCase();
  } catch {}
  const isAuth = (h) => h && authDomainsList.some(d => h === d || h.endsWith('.' + d));
  return cfg.customRules.some(rule => {
    const pattern = String(rule?.pattern || rule || '').trim().replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
    if (!pattern) return false;
    const matches = normalizedHost === pattern || normalizedHost.endsWith('.' + pattern);
    if (!matches) return false;
    // Regla site-scoped: solo aplica si el documento coincide con el sitio
    if (rule.site) {
      return !!docHost && baseDomain(rule.site) === baseDomain(docHost);
    }
    // Regla global: NO aplica en dominios auth (proteger OAuth/login)
    if (isAuth(normalizedHost) || isAuth(docHost)) return false;
    return true;
  });
}

function isLikelyVideoResource(rawUrl, resourceType) {
  if (resourceType === 'media') return true;
  if (!EMBEDDED_TYPES.has(resourceType)) return false;
  try {
    const url = new URL(rawUrl);
    return VIDEO_PATH_RE.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.in'
]);

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/\.+$/, '');
}

function baseDomain(host) {
  const normalized = normalizeHost(host);
  const parts = normalized.split('.');
  if (parts.length <= 2) return normalized;
  const suffix = parts.slice(-2).join('.');
  const labelCount = MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2;
  return parts.slice(-labelCount).join('.');
}

function sameDomainOrSub(hostA, hostB) {
  const first = normalizeHost(hostA);
  const second = normalizeHost(hostB);
  if (!first || !second) return false;
  if (first === second || first.endsWith('.' + second) || second.endsWith('.' + first)) return true;
  // Subdominios hermanos del mismo dominio registrable (cdn.x.com vs www.x.com).
  return baseDomain(first) === baseDomain(second);
}

function isUntrustedThirdPartyResource(rawUrl, rawDocUrl) {
  try {
    const resHost = new URL(rawUrl).hostname.toLowerCase();
    const docHost = new URL(rawDocUrl).hostname.toLowerCase();
    if (!resHost || !docHost) return false;
    // Mismo dominio o subdominio del documento actual → confiable.
    if (sameDomainOrSub(resHost, docHost)) return false;
    // Hosts de vídeo conocidos siempre permitidos (streams embebidos).
    if (isVideoHost(resHost)) return false;
    return true;
  } catch {
    return false;
  }
}

function isTrustedResource(rawUrl, rawDocUrl) {
  try {
    const resource = new URL(rawUrl);
    const document = new URL(rawDocUrl);
    if (!/^https?:$/.test(resource.protocol) || !/^https?:$/.test(document.protocol)) return true;
    const resourceHost = resource.hostname.toLowerCase();
    const documentHost = document.hostname.toLowerCase();
    if (sameDomainOrSub(resourceHost, documentHost) || isVideoHost(resourceHost)) return true;
    return Object.entries(TRUSTED_CROSS_ORIGINS).some(([site, origins]) => {
      const onSite = documentHost === site || documentHost.endsWith('.' + site);
      return onSite && origins.some(origin => resourceHost === origin || resourceHost.endsWith('.' + origin));
    });
  } catch {
    return true;
  }
}

// ── Block session request handler ──────────────────────────
function createBlockHandler(getEngine, allowedDomains, isEnabled, isCategoryEnabled, mediaCb, strictDomainIsolation, blockCb, requestCb, requestGuard) {
  return (details, callback) => {
    if (!/^https?:\/\//i.test(details.url || '')) return callback({ cancel: false });
    if (requestGuard) {
      try {
        const guard = requestGuard(details);
        if (guard?.redirectURL) return callback({ redirectURL: guard.redirectURL });
        if (guard?.cancel) return callback({ cancel: true });
        if (guard?.allow) return callback({ cancel: false });
      } catch {}
    }
    // [DIAG-AD] temporal: ver qué pasa con las peticiones de anuncios de display
    if (/doubleclick|googlesyndication|googleadservices/i.test(details.url)) {
      console.log('[DIAG-AD]', details.resourceType, '| doc:', (details.documentUrl || details.referrer || '').slice(0, 90), '| url:', details.url.slice(0, 140));
    }
    if (requestCb) requestCb(details);
    if (mediaCb) mediaCb(details.url, details.documentUrl || details.referrer || '', details.resourceType);
    if (!isEnabled() && !strictDomainIsolation) return callback({ cancel: false });
    try {
      const url = new URL(details.url);
      const host = url.hostname.toLowerCase();
      const documentUrl = details.documentUrl || details.referrer || '';
      let documentHost = '';
      try { documentHost = new URL(documentUrl).hostname.toLowerCase(); } catch {}

      // Perchance ejecuta cada generador en un subdominio propio y depende de
      // estos recursos; la excepción solo existe dentro de documentos Perchance.
      if (isPerchanceCompatibilityRequest(host, documentHost)) {
        return callback({ cancel: false });
      }

      if (isExplicitlyBlocked(host, details.documentUrl || details.referrer || '')) {
        if (blockCb) blockCb(details, 'ads');
        return callback({ cancel: true });
      }

      // YouTube: bloquear el stream del anuncio (googlevideo.com con
      // parámetros ad_). Al bloquearlo, YouTube salta el anuncio en vez de
      // mostrarlo en blanco (mismo enfoque que Brave/uBlock).
      if (isYouTubeAdStream(details.url)) {
        console.log('[DIAG-YT-AD] stream de anuncio bloqueado:', details.url.slice(0, 170));
        if (blockCb) blockCb(details, 'ads');
        return callback({ cancel: true });
      }

      // Always allow auth/login domains
      for (const ad of allowedDomains) {
        if (host === ad || host.endsWith('.' + ad)) {
          return callback({ cancel: false });
        }
      }

      // Hosts de vídeo: permitir siempre (streams embebidos).
      if (isVideoHost(host)) {
        return callback({ cancel: false });
      }

      // "Sitio / contenedor" NO desactiva el motor de listas.
      // Solo evita el heurístico de tokens de tracking (OAuth, APIs propias, etc.).
      const siteTrusted = isSiteAllowed(host);

      const isTrackerRequest = TRACKER_TOKENS.test(details.url);
      if (isCategoryEnabled('trackers') && isTrackerRequest && !siteTrusted) {
        if (blockCb) blockCb(details, 'trackers');
        return callback({ cancel: true });
      }
      if (isCategoryEnabled('ads') && isAggressiveAdNavigation(details.url)) {
        if (blockCb) blockCb(details, 'ads');
        return callback({ cancel: true });
      }

      const isEmbeddedContainer = documentUrl && EMBEDDED_TYPES.has(details.resourceType);
      if (isEmbeddedContainer) return callback({ cancel: false });

      if (
        isVideoHost(host) ||
        isLikelyVideoResource(details.url, details.resourceType) ||
        (documentUrl && isLikelyVideoResource(documentUrl, 'subFrame'))
      ) {
        return callback({ cancel: false });
      }

      const result = isEnabled() ? getEngine().match({
        url: details.url,
        type: details.resourceType || details.type || 'other',
        documentUrl: details.documentUrl || ''
      }) : { match: false };

      if (result.match) {
        const category = TRACKER_TOKENS.test(details.url) ? 'trackers' : 'ads';
        if (isCategoryEnabled(category) && blockCb) blockCb(details, category);
        if (isCategoryEnabled(category)) return callback({ cancel: true });
      }

    } catch {}
    if (/doubleclick|googlesyndication|googleadservices/i.test(details.url)) console.log('[DIAG-AD] ALLOWED');
    callback({ cancel: false });
  };
}

// ── Download filter lists on first run ─────────────────────
async function autoDownloadLists(manager, onProgress, onDone) {
  try {
    const results = await manager.updateAll(onProgress);
    if (onDone) onDone(results);
  } catch (e) {
    if (onDone) onDone({ error: e.message });
  }
}

// Selectores cosméticos integrados para YouTube. Los anuncios de display los
// renderiza YouTube inline con componentes ytw/ytd (p. ej.
// ad-button-hover-overlay-view-model, clases ytwAd...); bloquear el host no
// los oculta porque el contenido se sirve desde dominios propios de YouTube y
// el enlace a googleadservices.com solo es el click-through.
const YT_COSMETIC_SELECTORS = [
  // Componentes nuevos (ytw) de anuncios
  'ad-button-hover-overlay-view-model',
  'ad-button-view-model',
  'ad-slot-renderer',
  'ad-badge-view-model',
  '[class*="ytwAd"]',
  '[class*="AdButtonHoverOverlay"]',
  '[class*="AdButtonViewModel"]',
  '[class*="AdHoverOverlay"]',
  '[class*="AdImageHoverOverlay"]',
  '[class*="AdOverlayContainer"]',
  '[class*="AdTextOverlay"]',
  '[class*="AdImageOverlay"]',
  '[class*="AdBadge"]',
  '[class*="AdSimpleAdBadge"]',
  // Renderers clásicos de anuncios
  'ytd-display-ad-renderer',
  'ytd-in-feed-ad-layout-renderer',
  'ytd-ad-slot-renderer',
  'ytd-companion-slot-renderer',
  'ytd-promoted-video-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-banner-promo-renderer',
  'ytd-statement-banner-renderer',
  'ytd-video-masthead-ad-v3-renderer',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
  // Contenedores / overlays del reproductor
  '#masthead-ad',
  '#player-ads',
  '.ytp-ad-module',
  '.ytp-ad-overlay-container',
  '.ytp-ad-text-overlay',
  '.ytp-ad-image-overlay',
  '.ytp-ad-simple-ad-badge',
  '.ytp-ad-badge'
];

function builtInCosmeticSelectors(pageUrl) {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase();
    if (hostname !== 'youtube.com' && !hostname.endsWith('.youtube.com')) return [];
    return YT_COSMETIC_SELECTORS;
  } catch {
    return [];
  }
}

// ── Setup ──────────────────────────────────────────────────
function setup(ctx) {
  if (!ctx) return;
  const { cfg: ctxCfg, saveCfg, emit, session: targetSession, allowedDomains, mediaCallback, blockCallback, requestCallback, requestGuard } = ctx;
  const sess = targetSession || session.fromPartition('persist:mc');
  const allowed = allowedDomains || [];
  cfg = ctxCfg || null;
  authDomainsList = allowedDomains || [];

  const cacheDir = ctx.cacheDir || undefined;
  const manager = new ListManager(cacheDir);
  let enabledAds = cfg?.blockAds === true;
  let enabledTrackers = cfg?.blockTrackers === true;

  // Load cached lists first
  const loadResult = manager.loadCached();

  // If no cache, load fallback domains as inline rules
  if (loadResult.source === 'none') {
    const fallbackRules = FALLBACK_DOMAINS.map(d => `||${d}^`);
    manager.engine.loadLines(fallbackRules);
    // Auto-download lists in background
    autoDownloadLists(manager, (p) => {
      if (emit) emit('adblock:progress', p);
    }, (result) => {
      if (emit) emit('adblock:update-done', result);
      // Reload engine with downloaded lists
      manager.loadCached();
    });
  }

  // Enable blocking if configured (handler checks `enabled` at runtime)
  function toggleBlocking(on) {
    if (typeof on === 'object') {
      enabledAds = on.ads === true;
      enabledTrackers = on.trackers === true;
    } else {
      enabledAds = !!on;
    }
  }

  // Register handler once; it checks `enabled` and uses latest engine
  const isEnabled = () => enabledAds || enabledTrackers;
  const strictDomainIsolation = cfg?.strictDomainIsolation === true;
  const isCategoryEnabled = category => category === 'trackers' ? enabledTrackers : enabledAds;
  const blockHandler = createBlockHandler(() => manager.engine, allowed, isEnabled, isCategoryEnabled, mediaCallback, strictDomainIsolation, blockCallback, requestCallback, requestGuard);
  sess.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      blockHandler(details, callback);
    }
  );

  // Sync initial state
  // IPC handlers
  ipcMain.handle('ai:adblock:info', () => {
    const info = manager.getInfo();
    return {
      ok: true,
      enabled: isEnabled(),
      blockAds: enabledAds,
      blockTrackers: enabledTrackers,
      ruleCount: info.ruleCount,
      domainRules: info.domainRules,
      urlRules: info.urlRules,
      regexRules: info.regexRules,
      cosmeticRules: info.cosmeticRules,
      loadedLists: info.loadedLists,
      updating: info.updating,
      cacheDir: info.cacheDir
    };
  });

  ipcMain.handle('ai:adblock:import', async (_e, { url }) => {
    // Import a single filter list from URL
    try {
      const listDef = { name: 'custom-' + Date.now(), url: url || 'https://easylist.to/easylist/easylist.txt', enabled: true };
      const result = await manager.updateList(listDef);
      if (result.ok) {
        // Reload engine from cache
        manager.loadCached();
        // Re-register handler
        if (isEnabled()) {
          toggleBlocking(false);
          toggleBlocking(true);
        }
        return { ok: true, rules: result.rules };
      }
      return { error: result.error };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('ai:adblock:test', async (_e, { url, type }) => {
    const result = manager.engine.match({
      url: url || '',
      type: type || 'script',
      documentUrl: ''
    });
    return { ok: true, match: result.match, rule: result.rule ? result.rule.raw : null };
  });

  // Additional IPC for updating lists
  ipcMain.handle('adblock:update-lists', async () => {
    if (manager._updating) return { updating: true };
    const result = await manager.updateAll((progress) => {
      emit('adblock:progress', progress);
    });
    if (isEnabled()) {
      toggleBlocking(false);
      toggleBlocking(true);
    }
    return result;
  });

  ipcMain.handle('adblock:get-lists', () => {
    return FILTER_LISTS.map(l => ({
      ...l,
      cached: manager._cacheFile ? require('fs').existsSync(manager._cacheFile(l.name)) : false
    }));
  });

  ipcMain.handle('adblock:toggle', (_e, on) => {
    toggleBlocking(!!on);
    if (cfg) cfg.blockAds = !!on;
    if (saveCfg) saveCfg();
    return { enabled: !!on };
  });

  function normalizeCosmeticRule(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const exceptionIdx = text.indexOf('#@#');
    if (exceptionIdx >= 0) {
      const domain = text.substring(0, exceptionIdx).trim().toLowerCase();
      const selector = text.substring(exceptionIdx + 3).trim();
      if (!selector) return null;
      return { raw: (domain ? domain : '') + '#@#' + selector, domain, selector, exception: true };
    }
    const ci = text.indexOf('##');
    if (ci < 0) return null;
    const domain = text.substring(0, ci).trim().toLowerCase();
    const selector = text.substring(ci + 2).trim();
    if (!selector) return null;
    return { raw: (domain ? domain : '') + '##' + selector, domain, selector, exception: false };
  }

  function userCosmeticSelectors(pageUrl) {
    let hostname = '';
    try { hostname = new URL(pageUrl).hostname.toLowerCase(); } catch { return []; }
    const rules = Array.isArray(cfg?.userCosmeticRules) ? cfg.userCosmeticRules : [];
    const out = [];
    for (const item of rules) {
      const rule = typeof item === 'string' ? normalizeCosmeticRule(item) : normalizeCosmeticRule(item?.raw || `${item?.domain || ''}##${item?.selector || ''}`);
      if (!rule || rule.exception) continue;
      if (rule.domain && !(hostname === rule.domain || hostname.endsWith('.' + rule.domain))) continue;
      out.push(rule.selector);
    }
    return out;
  }

  function buildPageCosmeticCss(pageUrl) {
    const fromEngine = (cfg?.blockAds === true || enabledAds)
      ? manager.engine.buildCosmeticCss(pageUrl || '')
      : { selectors: [], css: '' };
    const userSelectors = userCosmeticSelectors(pageUrl);
    const builtIn = builtInCosmeticSelectors(pageUrl);
    const selectors = [...new Set([...(fromEngine.selectors || []), ...userSelectors, ...builtIn])];
    if (!selectors.length) return { ok: true, count: 0, selectors: [], css: '' };
    const chunks = [];
    for (let i = 0; i < selectors.length; i += 40) {
      chunks.push(selectors.slice(i, i + 40).join(',\n'));
    }
    const css = chunks
      .map(chunk => `${chunk}{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;min-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;}`)
      .join('\n');
    return { ok: true, count: selectors.length, selectors, css, userCount: userSelectors.length };
  }

  ipcMain.handle('adblock:cosmetics', (_e, { url } = {}) => {
    try {
      return buildPageCosmeticCss(url || '');
    } catch (e) {
      return { ok: false, error: e.message, count: 0, selectors: [], css: '' };
    }
  });

  ipcMain.handle('adblock:add-cosmetic', (_e, { domain, selector, raw } = {}) => {
    const rule = normalizeCosmeticRule(raw || `${String(domain || '').trim()}##${String(selector || '').trim()}`);
    if (!rule || rule.exception) return { ok: false, error: 'regla cosméticas inválida' };
    if (!cfg.userCosmeticRules) cfg.userCosmeticRules = [];
    if (cfg.userCosmeticRules.includes(rule.raw)) return { ok: true, rule: rule.raw, exists: true };
    cfg.userCosmeticRules.push(rule.raw);
    if (saveCfg) saveCfg();
    return { ok: true, rule: rule.raw };
  });

  ipcMain.handle('adblock:remove-cosmetic', (_e, { raw, domain, selector } = {}) => {
    const target = normalizeCosmeticRule(raw || `${String(domain || '').trim()}##${String(selector || '').trim()}`);
    if (!target) return { ok: false, error: 'regla inválida' };
    const before = Array.isArray(cfg.userCosmeticRules) ? cfg.userCosmeticRules.length : 0;
    cfg.userCosmeticRules = (cfg.userCosmeticRules || []).filter(item => String(item) !== target.raw);
    if (saveCfg) saveCfg();
    return { ok: true, removed: before !== cfg.userCosmeticRules.length };
  });

  ipcMain.handle('adblock:list-cosmetics', () => ({
    ok: true,
    rules: Array.isArray(cfg?.userCosmeticRules) ? [...cfg.userCosmeticRules] : []
  }));

  return { manager, toggleBlocking, buildPageCosmeticCss };
}

module.exports = {
  setup,
  FALLBACK_DOMAINS,
  isAggressiveAdNavigation,
  isUntrustedThirdPartyResource,
  isTrustedResource,
  isVideoHost,
  isLikelyVideoResource,
  sameDomainOrSub
};
