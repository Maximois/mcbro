'use strict';

const { ipcMain, session } = require('electron');
const { ListManager, FILTER_LISTS } = require('./lists');
const { Engine } = require('./engine');

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
const TRACKER_TOKENS = /analytics|tracking|tracker|telemetry|pixel|beacon|scorecardresearch|quantserve|demdex|hotjar|clarity\.ms|connect\.facebook/i;

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

// ── Aislamiento estricto de terceros (port desde Android) ──
// Equivalente a isUntrustedThirdPartyResource: corta recursos incrustados
// (iframe/frame/embed/object) cuyo dominio no es el del documento actual.
const VIDEO_HOSTS = [
  'mega.nz', 'filemoon', 'savefiles', 'dood', 'voe',
  'mxdrop', 'lulu', 'mp4upload'
];

const TRUSTED_CROSS_ORIGINS = {
  'google.com': ['gstatic.com', 'googleusercontent.com', 'googleapis.com'],
  'youtube.com': ['ytimg.com', 'googlevideo.com', 'googleusercontent.com'],
  'microsoft.com': ['microsoftonline.com', 'live.com', 'office.net'],
  'github.com': ['githubusercontent.com', 'githubassets.com'],
  'apple.com': ['icloud.com', 'apple-cloudkit.com']
};

// En Electron 30: subFrame = iframe/frame, object = embed/object.
const EMBEDDED_TYPES = new Set([
  'subFrame', 'subframe', 'subdocument', 'object'
]);
const VIDEO_PATH_RE = /(?:^|[/?_-])(embed|player|watch|video|stream|playlist|manifest|play|e|f)(?:[/?_.=-]|$)|\.(?:m3u8|mpd|mp4|webm|ts|m4s)(?:[?#]|$)/i;

function isVideoHost(host) {
  return VIDEO_HOSTS.some(v => host === v || host.includes(v));
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
      } catch {}
    }
    if (requestCb) requestCb(details);
    if (mediaCb) mediaCb(details.url, details.documentUrl || details.referrer || '', details.resourceType);
    if (!isEnabled() && !strictDomainIsolation) return callback({ cancel: false });
    try {
      const url = new URL(details.url);
      const host = url.hostname.toLowerCase();

      // Always allow auth/login domains
      for (const ad of allowedDomains) {
        if (host === ad || host.endsWith('.' + ad)) {
          return callback({ cancel: false });
        }
      }

      const isTrackerRequest = TRACKER_TOKENS.test(details.url);
      if (isCategoryEnabled('trackers') && isTrackerRequest) {
        if (blockCb) blockCb(details, 'trackers');
        return callback({ cancel: true });
      }
      if (isCategoryEnabled('ads') && isAggressiveAdNavigation(details.url)) {
        if (blockCb) blockCb(details, 'ads');
        return callback({ cancel: true });
      }

      const documentUrl = details.documentUrl || details.referrer || '';
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

// ── Setup ──────────────────────────────────────────────────
function setup(ctx) {
  if (!ctx) return;
  const { cfg, saveCfg, emit, session: targetSession, allowedDomains, mediaCallback, blockCallback, requestCallback, requestGuard } = ctx;
  const sess = targetSession || session.fromPartition('persist:mc');
  const allowed = allowedDomains || [];

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

  return { manager, toggleBlocking };
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
