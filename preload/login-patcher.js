// === AGGRESSIVE ELECTRON SPOOFING FOR LOGIN/WEBAUTHN ===
(function() {
  // 1. Hide webdriver completely (multiple methods)
  try { delete navigator.webdriver; } catch(e) {}
  try { Object.defineProperty(navigator, 'webdriver', { value: undefined, writable: false }); } catch(e) {}
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch(e) {}
  
  // 2. Mock browser-like properties
  const props = {
    'plugins': () => [1,2,3,4,5],
    'mimeTypes': () => [1,2,3,4],
    'languages': () => ['en-US', 'en', 'es'],
    'platform': () => 'Win32',
    'vendor': () => 'Google Inc.',
    'deviceMemory': () => 8,
    'hardwareConcurrency': () => 4,
    'maxTouchPoints': () => 0,
  };
  
  Object.entries(props).forEach(([key, getter]) => {
    try { Object.defineProperty(navigator, key, { get: getter, configurable: false }); } catch(e) {}
  });
  
  // 3. Keep Client Hints consistent with the Chrome UA used by WhatsApp.
  try {
    const uad = {
        brands: [
          { brand: 'Not_A Brand', version: '99' },
          { brand: 'Google Chrome', version: '124' },
          { brand: 'Chromium', version: '124' }
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async (keys) => {
          const hints = {
            architecture: 'x86',
            model: '',
            platform: 'Windows',
            platformVersion: '10.0.0',
            uaFullVersion: '124.0.6367.78',
            bitness: '64',
            fullVersionList: uad.brands,
            wow64: false,
          };
          return Object.fromEntries((keys||[]).map(k => [k, hints[k] || '']));
        }
      };
    Object.defineProperty(navigator, 'userAgentData', {
      value: uad,
      writable: false,
      enumerable: true,
      configurable: false
    });
  } catch(e) {}
  
  // 4. Mock window.chrome API (Chrome/Chromium check)
  try {
    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
        app: { isInstalled: false },
        loadTimes: () => ({}),
        csi: () => ({})
      };
    }
  } catch(e) {}
  
  // 5. Prevent Electron detection via global objects
  try { delete window.electron; } catch(e) {}
  try { delete window.ipcRenderer; } catch(e) {}
  try { delete window.api; } catch(e) {}
  
  // 6. Block common automation detection vectors
  const blockProps = ['__ELECTRON__', '__WEBKIT__', '__CORDOVA__', '__TAURI__', 'cordova', 'tauri'];
  blockProps.forEach(prop => {
    try { Object.defineProperty(window, prop, { get: () => undefined, configurable: false }); } catch(e) {}
  });
  
  // 7. Override fetch/XHR headers if needed (defensive)
  const origFetch = window.fetch;
  window.fetch = function(...args) {
    return origFetch.apply(this, args).then(res => {
      try {
        const headers = res.headers;
        if (headers.get('x-powered-by')?.includes('Electron')) {
          // Replace header (won't work in practice, but try)
          res.headers.delete('x-powered-by');
        }
      } catch(e) {}
      return res;
    });
  };
  
  // 8. Spoof screen properties (defensive against fingerprinting)
  try {
    Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: false });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: false });
  } catch(e) {}
  
})();

try {
  if (window.chrome) {
    if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({
      requestTime: 0, startLoadTime: 0, commitLoadTime: 0,
      finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
      firstPaintAfterLoadTime: 0, navigationType: 'other',
      wasFetchedViaSpdy: false, wasNpnNegotiated: false,
      npnNegotiatedProtocol: 'unknown', wasAlternateProtocolAvailable: false,
      connectionInfo: 'http/1.1'
    });
    if (!window.chrome.csi) window.chrome.csi = () => ({
      onloadT: Date.now(), startE: Date.now(), pageT: 'chrome',
      startSR: Date.now(), startT: Date.now()
    });
    if (!window.chrome.app) window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
    };
    if (!window.chrome.runtime) window.chrome.runtime = {};
  }
} catch(e) {}
