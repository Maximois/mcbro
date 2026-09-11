'use strict';
/**
 * MC Browser -- preload.js
 * Se ejecuta en contexto aislado ANTES que la pagina.
 * Expone API segura al renderer y aplica anti-fingerprint.
 */

const { contextBridge, ipcRenderer } = require('electron');

// -- Canales permitidos (whitelist estricta) --------
const ALLOWED = new Set([
  'req-blocked','media-detected','cookie-intercepted','stats-update',
  'dl-progress','dl-complete','dl-error','new-tab','close-tab',
  'dl-pause','dl-resume','dl-cancel','dl:open-file',
  'dl-native','dl-native-progress','dl-native-done','dl-native-tab',
  'focus-urlbar','ua-rotated','ua-changed','cookies-cleared','cache-cleared',
  'clear-all','media-cleared','show-media',
  'export-session-menu','import-session-menu',
  'popup-allowed','popup-blocked',
  'auth-session-updated',
  'streams:found',
  'ytdlp-log',
  'open-new-tab','page-extract-results','ai-element-selected','cosmetic-block-result','cosmetic-unblock-result',
  // Bookmarks
  'bookmarks:list','bookmarks:add','bookmarks:remove','bookmarks:update','bookmarks:reorder',
  // Browser history
  'history:list','history:add','history:clear',
  'proxy:set',
  'ai:config:get','ai:config:save','ai:chat','ai:models',
  'ai:dl:url','ai:dl:log','ai:dl:done',
  'ai:exec','ai:exec:log','ai:fetch:url','ai:web:fetch','ai:session:load','ai:session:cookies','ai:page:dom',
  'ai:script:run','ai:decode',
  'ai:chat:abort',
  'ai:adblock:info','ai:adblock:import','ai:adblock:test',
  'ai:page:resources',
  'ai:page:console',
  // DoH resolve
  'resolve-doh',
  // Scraping tools
  'ai:scraping:isolate','ai:scraping:analyze-structure','ai:scraping:extract-pattern',
  'ai:scraping:detect-dynamic','ai:scraping:discover-apis','ai:scraping:metrics',
  // Security analysis
  'ai:security:analyze-url','ai:security:analyze-html','ai:security:rules',
  'ai:security:rule:toggle','ai:security:rule:add',
  // Auto-scraping
  'ai:auto-scrape','ai:get-cache','ai:clear-cache',
  'ai:debug',
  // Memory & Reminders
  'memory:list','memory:search','memory:add','memory:update','memory:delete','memory:archive','memory:recent',
  'reminders:list','reminders:add','reminders:complete','reminders:delete',
  // Media save (generated images/audio/video)
  'ai:media:save',
  // WhatsApp extractor media save
  'wa:media:save','wa:media:download','wa:media:open','wa:media:open-file',
  // Chat sessions persistence
  'ai:chat:sessions:list','ai:chat:sessions:load','ai:chat:sessions:save',
  'ai:chat:sessions:delete','ai:chat:sessions:rename',
  // Lab capture as image
  'lab:capture',
  // Lab persistent state
  'lab:state:save','lab:state:load',
  // Lab recording (offscreen)
  'lab:rec:start','lab:rec:stop','lab:rec:frame',
   // Lab file system
   'lab:fs:write','lab:fs:read','lab:fs:read-binary','lab:fs:exists',
   'lab:fs:list','lab:fs:delete','lab:fs:mkdir',
   'lab:fs:save-dialog','lab:fs:open-dialog',
]);

// -- Internal state for lab recording frame callback
let _labRecFrameCb = null;

// -- API publica expuesta al renderer --------------
contextBridge.exposeInMainWorld('mc', {
  platform: process.platform,
  version:  process.versions.electron,

  // Settings / stats
  getCfg:      ()      => ipcRenderer.invoke('get-cfg'),
  updateCfg:   (patch) => ipcRenderer.invoke('update-cfg', patch),
  getStats:    ()      => ipcRenderer.invoke('get-stats'),
  resetStats:  ()      => ipcRenderer.invoke('reset-stats'),
  getMedia:    ()      => ipcRenderer.invoke('get-media'),
  getSysinfo:  ()      => ipcRenderer.invoke('get-sysinfo'),
  getProcesses:()      => ipcRenderer.invoke('get-processes'),
  getRealValues: ()     => getRealValues(),
  sendToHost: (channel, ...args) => {
    try { ipcRenderer.sendToHost(channel, ...args); } catch {}
  },

  // Ventana nativa
  minimize:   () => ipcRenderer.invoke('win-min'),
  maximize:   () => ipcRenderer.invoke('win-max'),
  close:      () => ipcRenderer.invoke('win-close'),
  isMaximized:() => ipcRenderer.invoke('win-ismax'),
  destroyWebview: (webContentsId) => ipcRenderer.invoke('webview:destroy', webContentsId),

  // Descargas
  downloadHLS:  (id,url,name,pageUrl) => ipcRenderer.invoke('dl-hls',  {id,url,name,pageUrl}),
  downloadFile: (id,url,name,pageUrl) => ipcRenderer.invoke('dl-file', {id,url,name,pageUrl}),
  dlPause:      (id) => ipcRenderer.invoke('dl-pause', id),
  dlResume:     (id) => ipcRenderer.invoke('dl-resume', id),
  dlCancel:     (id) => ipcRenderer.invoke('dl-cancel', id),
  openDlFolder: ()         => ipcRenderer.invoke('open-dl-folder'),
  openDlFile:   (path)     => ipcRenderer.invoke('dl:open-file', path),
  chooseDlDir:  ()         => ipcRenderer.invoke('choose-dl-dir'),
  openExternal: (url)      => ipcRenderer.invoke('open-external', url),

  // Cookies
  clearCookies:    ()               => ipcRenderer.invoke('clear-cookies'),
  clearCache:      ()               => ipcRenderer.invoke('clear-cache'),
  clearData:       (opts={})         => ipcRenderer.invoke('clear-data', opts),
  clearAll:        ()               => ipcRenderer.invoke('clear-all'),
  addCookieRule:   (domain,policy)  => ipcRenderer.invoke('add-cookie-rule',   {domain,policy}),
  removeCookieRule:(domain)         => ipcRenderer.invoke('remove-cookie-rule', {domain}),

  // Reglas
  addBlockRule:   (rule)    => ipcRenderer.invoke('add-block-rule',    rule),
  removeBlockRule:(pattern) => ipcRenderer.invoke('remove-block-rule', {pattern}),
  addResourceRule: (rule) => ipcRenderer.invoke('add-resource-rule', rule),
  removeResourceRule: (url, resourceType) => ipcRenderer.invoke('remove-resource-rule', {url, resourceType}),
  getResourceRules: () => ipcRenderer.invoke('get-resource-rules'),

  // Permisos granulares por dominio
  addPermission:   (domain,permission,value='allow') => ipcRenderer.invoke('add-permission',    {domain,permission,value}),
  removePermission:(domain,permission) => ipcRenderer.invoke('remove-permission', {domain,permission}),
  setSitePermission:(domain,permission,value='allow') => ipcRenderer.invoke('set-site-permission', {domain,permission,value}),
  removeSitePermission:(domain,permission) => ipcRenderer.invoke('remove-site-permission', {domain,permission}),
  getPermissions:  ()                  => ipcRenderer.invoke('get-permissions'),
  getSiteCookies:  (domain)            => ipcRenderer.invoke('get-site-cookies', {domain}),
  removeSiteCookie:(domain,name,path)   => ipcRenderer.invoke('remove-site-cookie', {domain,name,path}),
  setCookiePolicyForDomain:(domain,policy) => ipcRenderer.invoke('set-cookie-policy-for-domain',{domain,policy}),

  // Adblock cosmetics (hide leftover ad slots)
  adblockCosmetics: (url) => ipcRenderer.invoke('adblock:cosmetics', { url }),
  adblockAddCosmetic: (opts) => ipcRenderer.invoke('adblock:add-cosmetic', opts),
  adblockRemoveCosmetic: (opts) => ipcRenderer.invoke('adblock:remove-cosmetic', opts),
  adblockListCosmetics: () => ipcRenderer.invoke('adblock:list-cosmetics'),

  // DoH
  resolveDoH: (host) => ipcRenderer.invoke('resolve-doh', host),

   // Sesion
   exportSession: () => ipcRenderer.invoke('export-session'),
   importSession: () => ipcRenderer.invoke('import-session'),

   // Bookmarks
   bookmarksList:    ()       => ipcRenderer.invoke('bookmarks:list'),
   bookmarksAdd:     (bm)     => ipcRenderer.invoke('bookmarks:add', bm),
   bookmarksRemove:  (id)     => ipcRenderer.invoke('bookmarks:remove', { id }),
   bookmarksUpdate:  (id, p)  => ipcRenderer.invoke('bookmarks:update', { id, patch: p }),
   bookmarksReorder: (fi, ti) => ipcRenderer.invoke('bookmarks:reorder', { fromIndex: fi, toIndex: ti }),

  // Browser history
  historyList:  () => ipcRenderer.invoke('history:list'),
  historyAdd:   (entry) => ipcRenderer.invoke('history:add', entry),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  proxySet: (settings) => ipcRenderer.invoke('proxy:set', settings),

   // Streams
   scanStreams: (id) => ipcRenderer.invoke('streams:scan', id),

   // yt-dlp
   ytdlpCheck:    ()     => ipcRenderer.invoke('ytdlp-check'),
   ytdlpVersion:  ()     => ipcRenderer.invoke('ytdlp-version'),
   ytdlpInstall:  ()     => ipcRenderer.invoke('ytdlp-install'),
   ytdlpAnalyze:  (url)  => ipcRenderer.invoke('ytdlp-analyze', url),
   ytdlpDownload: (opts) => ipcRenderer.invoke('ytdlp-download', opts),
   ffmpegCheck:    ()     => ipcRenderer.invoke('ffmpeg-check'),
   ffmpegInstall:  ()     => ipcRenderer.invoke('ffmpeg-install'),

   // AI
   aiConfigGet:   ()     => ipcRenderer.invoke('ai:config:get'),
   aiConfigSave:  (cfg)  => ipcRenderer.invoke('ai:config:save', cfg),
   aiChat:        (opts) => ipcRenderer.invoke('ai:chat', opts),
   aiModels:      (opts) => ipcRenderer.invoke('ai:models', opts),
   aiDlUrl:       (opts) => ipcRenderer.invoke('ai:dl:url', opts),
   aiExec:        (opts) => ipcRenderer.invoke('ai:exec', opts),
   aiFetchUrl:    (opts) => ipcRenderer.invoke('ai:fetch:url', opts),
   aiWebFetch:    (opts) => ipcRenderer.invoke('ai:web:fetch', opts),
   aiSessionLoad: (opts) => ipcRenderer.invoke('ai:session:load', opts),
   aiPageDom:     (opts) => ipcRenderer.invoke('ai:page:dom', opts),

   aiScriptRun:     (opts) => ipcRenderer.invoke('ai:script:run', opts),
   aiDecode:        (opts) => ipcRenderer.invoke('ai:decode', opts),
   aiChatAbort:     ()     => ipcRenderer.invoke('ai:chat:abort'),
   aiMediaSave:     (opts) => ipcRenderer.invoke('ai:media:save', opts),
  waMediaSave:     (opts) => ipcRenderer.invoke('wa:media:save', opts),
  waMediaDownload: (opts) => ipcRenderer.invoke('wa:media:download', opts),
  waMediaOpen:     (opts) => ipcRenderer.invoke('wa:media:open', opts),
  waMediaOpenFile: (opts) => ipcRenderer.invoke('wa:media:open-file', opts),
  aiChatSessionsList:   ()        => ipcRenderer.invoke('ai:chat:sessions:list'),
  aiChatSessionsLoad:   (opts)    => ipcRenderer.invoke('ai:chat:sessions:load', opts),
  aiChatSessionsSave:   (opts)    => ipcRenderer.invoke('ai:chat:sessions:save', opts),
  aiChatSessionsDelete: (opts)    => ipcRenderer.invoke('ai:chat:sessions:delete', opts),
  aiChatSessionsRename: (opts)    => ipcRenderer.invoke('ai:chat:sessions:rename', opts),   labCapture:      (opts) => ipcRenderer.invoke('lab:capture', opts),
   labStateSave:    (state) => ipcRenderer.invoke('lab:state:save', state),
   labStateLoad:    ()     => ipcRenderer.invoke('lab:state:load'),
   labRecStart:     (opts) => ipcRenderer.invoke('lab:rec:start', opts),
   labRecStop:      ()     => ipcRenderer.invoke('lab:rec:stop'),
   labRecOnFrame:   (cb)   => { _labRecFrameCb = (_, data) => cb(data); ipcRenderer.on('lab:rec:frame', _labRecFrameCb); },
   labRecOffFrame:  ()     => { if (_labRecFrameCb) { ipcRenderer.removeListener('lab:rec:frame', _labRecFrameCb); _labRecFrameCb = null; } },
   // Lab File System
   labFsWrite:      (opts) => ipcRenderer.invoke('lab:fs:write', opts),
   labFsRead:       (opts) => ipcRenderer.invoke('lab:fs:read', opts),
   labFsReadBinary: (opts) => ipcRenderer.invoke('lab:fs:read-binary', opts),
   labFsExists:     (opts) => ipcRenderer.invoke('lab:fs:exists', opts),
   labFsList:       (opts) => ipcRenderer.invoke('lab:fs:list', opts),
   labFsDelete:     (opts) => ipcRenderer.invoke('lab:fs:delete', opts),
   labFsMkdir:      (opts) => ipcRenderer.invoke('lab:fs:mkdir', opts),
   labFsSaveDialog: (opts) => ipcRenderer.invoke('lab:fs:save-dialog', opts),
   labFsOpenDialog: ()     => ipcRenderer.invoke('lab:fs:open-dialog'),
   aiAdblockInfo:   ()     => ipcRenderer.invoke('ai:adblock:info'),
   aiAdblockImport: (opts) => ipcRenderer.invoke('ai:adblock:import', opts),
   aiAdblockTest:   (opts) => ipcRenderer.invoke('ai:adblock:test', opts),
   aiPageResources: (opts) => ipcRenderer.invoke('ai:page:resources', opts),
   aiPageConsole:   (opts) => ipcRenderer.invoke('ai:page:console', opts),

   // Scraping Tools
   aiScrapingIsolate: (opts) => ipcRenderer.invoke('ai:scraping:isolate', opts),
   aiScrapingAnalyzeStructure: (opts) => ipcRenderer.invoke('ai:scraping:analyze-structure', opts),
   aiScrapingExtractPattern: (opts) => ipcRenderer.invoke('ai:scraping:extract-pattern', opts),
   aiScrapingDetectDynamic: (opts) => ipcRenderer.invoke('ai:scraping:detect-dynamic', opts),
   aiScrapingDiscoverAPIs: (opts) => ipcRenderer.invoke('ai:scraping:discover-apis', opts),
   aiScrapingMetrics: (opts) => ipcRenderer.invoke('ai:scraping:metrics', opts),

   // Security Analysis
   aiSecurityAnalyzeUrl: (opts) => ipcRenderer.invoke('ai:security:analyze-url', opts),
   aiSecurityAnalyzeHtml: (opts) => ipcRenderer.invoke('ai:security:analyze-html', opts),
   aiSecurityRules: () => ipcRenderer.invoke('ai:security:rules'),
   aiSecurityRuleToggle: (opts) => ipcRenderer.invoke('ai:security:rule:toggle', opts),
   aiSecurityRuleAdd: (opts) => ipcRenderer.invoke('ai:security:rule:add', opts),

   // Background Analysis (Auto-Scraping)
   aiAutoScrape: (opts) => ipcRenderer.invoke('ai:auto-scrape', opts),
   aiGetCache: (opts) => ipcRenderer.invoke('ai:get-cache', opts),
   aiClearCache: (opts) => ipcRenderer.invoke('ai:clear-cache', opts),
  // Memory
  memoryList:      (filters)   => ipcRenderer.invoke('memory:list', filters),
  memorySearch:    (query)     => ipcRenderer.invoke('memory:search', query),
  memoryAdd:       (entry)     => ipcRenderer.invoke('memory:add', entry),
  memoryUpdate:    (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
  memoryDelete:    (id)        => ipcRenderer.invoke('memory:delete', id),
  memoryArchive:   (id)        => ipcRenderer.invoke('memory:archive', id),
  memoryRecent:    (limit)     => ipcRenderer.invoke('memory:recent', limit),

  // Reminders
  remindersList:      (filters)  => ipcRenderer.invoke('reminders:list', filters),
  remindersAdd:       (reminder) => ipcRenderer.invoke('reminders:add', reminder),
  remindersComplete:  (id)       => ipcRenderer.invoke('reminders:complete', id),
  remindersDelete:    (id)       => ipcRenderer.invoke('reminders:delete', id),
   // Eventos main -> renderer
   on(channel, cb) {
    if (!ALLOWED.has(channel)) return () => {};
    const fn = (_e, ...a) => cb(...a);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  once(channel, cb) {
    if (!ALLOWED.has(channel)) return;
    ipcRenderer.once(channel, (_e, ...a) => cb(...a));
  },
});

// ==================================================
//  ANTI-FINGERPRINT -- se aplica antes de cualquier script
// ==================================================
const REAL_NAV = {
  realCores: navigator.hardwareConcurrency,
  realMemory: navigator.deviceMemory,
  realPlatform: navigator.platform,
  realVendor: navigator.vendor,
  realPlugins: navigator.plugins.length,
  realMimeTypes: navigator.mimeTypes.length,
  realLanguages: navigator.languages ? [...navigator.languages] : [navigator.language],
  realUserAgent: navigator.userAgent,
};

function getRealValues() {
  return REAL_NAV;
}

// ==================================================
(function applyFP() {

  // Battery API -- siempre llena y cargando
  if (navigator.getBattery) {
    Object.defineProperty(navigator, 'getBattery', {
      value: () => Promise.resolve({
        charging:true, chargingTime:0, dischargingTime:Infinity, level:1,
        addEventListener:()=>{}, removeEventListener:()=>{},
      }),
      writable:false, configurable:false,
    });
  }

  // CPU cores normalizado
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get:()=>4, configurable:false });
  } catch {}

  // Memoria normalizada
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get:()=>8, configurable:false });
  } catch {}

  // Connection info generica
  try {
    Object.defineProperty(navigator, 'connection', {
      get:()=>({ effectiveType:'4g', rtt:50, downlink:10, saveData:false,
                 addEventListener:()=>{}, removeEventListener:()=>{} }),
      configurable:false,
    });
  } catch {}

  // WebRTC: NO forzamos relay aquí porque rompe servicios legítimos
  // como Mega (streaming/descarga p2p) y videoconferencia.

  // Canvas noise --sólo en canvas con dibujo 2D ya hecho.
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
    try {
      if (this.width * this.height < 50000) {
        const ctx = this.getContext && this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0,0,1,1);
          imageData.data[0] = (imageData.data[0] + 1) % 256;
          ctx.putImageData(imageData,0,0);
        }
      }
    } catch {}
    return origToDataURL.apply(this, [type, ...args]);
  };

  // Bloquear sensor APIs
  const blockAPIs = ['Accelerometer','Gyroscope','Magnetometer','AbsoluteOrientationSensor',
                     'RelativeOrientationSensor','AmbientLightSensor','GravitySensor','LinearAccelerationSensor'];
  blockAPIs.forEach(api => {
    if (window[api]) {
      window[api] = function() { throw new DOMException('Not allowed','NotAllowedError'); };
    }
  });

  // Speech Synthesis -- lista vacia
  if (window.speechSynthesis) {
    try {
      Object.defineProperty(window.speechSynthesis, 'getVoices', {
        value: () => [],
        configurable: false,
      });
    } catch {}
  }

})();
