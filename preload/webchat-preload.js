'use strict';
(function() {
  // Solo lo mínimo indispensable: navigator.webdriver → false
  try { Object.defineProperty(navigator, 'webdriver', { get:()=>false, configurable:false }); } catch {}
  // Chrome tiene window.chrome, Electron no
  try { if (!window.chrome) window.chrome = { loadTimes:()=>({}), csi:()=>({}) }; } catch {}
  // Suprimir userAgentData para que caiga en UA normal
  try { Object.defineProperty(navigator, 'userAgentData', { get:()=>undefined, configurable:false }); } catch {}
  // platform/vendor normalizados
  try { Object.defineProperty(navigator, 'platform', { get:()=>'Win32', configurable:false }); } catch {}
  try { Object.defineProperty(navigator, 'vendor', { get:()=>'Google Inc.', configurable:false }); } catch {}
  // plugins/mimeTypes vacíos como Chrome real
  try { Object.defineProperty(navigator, 'plugins', { get:()=>[], configurable:false }); } catch {}
  try { Object.defineProperty(navigator, 'mimeTypes', { get:()=>[], configurable:false }); } catch {}
})();
