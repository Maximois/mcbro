// modules/perchance-panel/renderer.js
// Panel de Perchance: mini-navegador en sidebar con marcadores propios.
// Usa una partición temporal propia (permisos, CSP/XFO y
// descargas blob/data) configurada por perchance/perchance-panel.js en el
// proceso principal. El <webview> navega libremente (mainFrame permitido) y
// los recursos del ecosistema Perchance cargan sin bloqueos.

(function () {
  'use strict';

  const HOME_DEFAULT = 'https://perchance.org/4cffvbcm0c';
  const NEW_TAB_DEFAULT = 'https://www.google.com/';
  const PARTITION = 'persist:perchance-clean';
  const BM_KEY = 'mc_perchance_bookmarks';
  const HIST_KEY = 'mc_perchance_history';
  const SET_KEY = 'mc_perchance_settings';
  const WIDTH_KEY = 'mc-panel-w-pch';
  const MAX_HISTORY = 200;

  let bookmarks = load(BM_KEY, []);
  let history = load(HIST_KEY, []);
  let settings = load(SET_KEY, { home: HOME_DEFAULT, newTab: NEW_TAB_DEFAULT });
  let tabs = [];
  let activeId = null;
  let tabSeq = 0;
  const loadTimers = new WeakMap();
  const loadRetries = new WeakMap();

  function homeUrl() { return settings.home || HOME_DEFAULT; }
  function newTabUrl() { return settings.newTab || NEW_TAB_DEFAULT; }

  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function injectPanel() {
    if (document.getElementById('perchance-sidebar')) return;
    const sb = document.createElement('div');
    sb.id = 'perchance-sidebar';
    sb.className = 'pch-scope';
    sb.innerHTML = `
      <div class="pch-header">
        <div class="pch-title-wrapper">
          <span class="pch-sparkle">✨</span>
          <h2>Perchance</h2>
        </div>
        <button id="pch-sb-close" class="close-sidebar-btn" onclick="PerchancePanel.close()" title="Cerrar panel">&times;</button>
      </div>
      <div class="pch-tabs" id="pch-tabs"></div>
      <div class="pch-toolbar">
        <button class="pch-nav-btn" onclick="PerchancePanel.goBack()" title="Atrás">&#8592;</button>
        <button class="pch-nav-btn" onclick="PerchancePanel.goForward()" title="Adelante">&#8594;</button>
        <button class="pch-nav-btn" onclick="PerchancePanel.reload()" title="Recargar">&#8635;</button>
        <button class="pch-nav-btn" onclick="PerchancePanel.home()" title="Inicio">&#8962;</button>
        <input id="pch-urlbar" placeholder="URL o código de generador..." spellcheck="false" autocomplete="off" onkeydown="if(event.key==='Enter')PerchancePanel.navigate(this.value)"/>
        <button class="pch-nav-btn" id="pch-bookmark-btn" onclick="PerchancePanel.toggleBookmark()" title="Marcar página">&#9734;</button>
        <button class="pch-nav-btn" id="pch-panel-btn" onclick="PerchancePanel.toggleExtractor()" title="Panel: marcadores, historial y configuración">&#128209;</button>
      </div>
      <div class="pch-wv-container" id="pch-wv-container"></div>
    `;
    const main = document.getElementById('main');
    if (main) main.appendChild(sb); else document.body.appendChild(sb);
    if (window.PanelResize && typeof window.PanelResize.attach === 'function') {
      window.PanelResize.attach(sb, WIDTH_KEY, 420);
    }
    ensureExtractor();
    addTab(homeUrl());
    renderBookmarks();
    renderHistory();
  }

  function createWebview() {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('allowpopups', '');
    // CRÍTICO: no poner la vista del panel en sandbox. Cloudflare/Turnstile y
    // los widgets auxiliares de Perchance crean iframes about:blank/srcdoc con
    // scripts y modales propios; el sandbox activo bloquea esos frames en
    // silencio y hace que el captcha “se cancele” o no termine de cargar.
    // Sin preload / sin nodeIntegration: el motor de Perchance habla por
    // postMessage entre orígenes y hace eval/window.open. No reescribir nada.
    wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=no,webSecurity=yes,backgroundThrottling=no');
    wv.style.display = 'none';
    const container = document.getElementById('pch-wv-container');
    if (container) container.appendChild(wv);
    wv.addEventListener('did-navigate', () => {
      syncActive();
      const u = safeGetURL(wv);
      if (u) addHistory(u, safeGetTitle(wv));
    });
    wv.addEventListener('did-navigate-in-page', () => syncActive());
    wv.addEventListener('page-title-updated', (e) => {
      const tab = tabs.find(t => t.wv === wv);
      if (tab && e.title) { tab.title = e.title; renderTabs(); }
    });
    wv.addEventListener('did-start-loading', () => { const i = document.getElementById('pch-urlbar'); if (i) i.style.opacity = '0.55'; });
    wv.addEventListener('did-start-loading', () => {
      clearTimeout(loadTimers.get(wv));
      loadTimers.set(wv, setTimeout(() => recoverStalledLoad(wv), 20000));
    });
    wv.addEventListener('did-stop-loading', () => {
      clearTimeout(loadTimers.get(wv));
      loadRetries.delete(wv);
      const i = document.getElementById('pch-urlbar'); if (i) i.style.opacity = '1';
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) console.warn('[PCH] carga fallida:', e.errorDescription, e.errorCode, e.validatedURL);
    });
    return wv;
  }

  function recoverStalledLoad(wv) {
    if (!wv || !wv.isConnected) return;
    const retries = loadRetries.get(wv) || 0;
    if (retries >= 2) return;
    loadRetries.set(wv, retries + 1);
    try {
      if (typeof wv.reloadIgnoringCache === 'function') wv.reloadIgnoringCache();
      else wv.reload();
    } catch {}
  }

  function addTab(url) {
    const id = ++tabSeq;
    const wv = createWebview();
    const initialUrl = url || newTabUrl();
    const tab = { id, title: 'Nueva pestaña', url: initialUrl, wv };
    tabs.push(tab);
    wv.setAttribute('src', initialUrl);
    switchTab(id);
    renderTabs();
    return tab;
  }

  function suspendTabs() {
    tabs.forEach((tab) => {
      if (!tab.wv) return;
      const url = safeGetURL(tab.wv);
      if (url) tab.url = url;
      const title = safeGetTitle(tab.wv);
      if (title) tab.title = title;
      try { tab.wv.remove(); } catch {}
      tab.wv = null;
    });
  }

  function resumeTabs() {
    tabs.forEach((tab) => {
      if (tab.wv) return;
      tab.wv = createWebview();
      tab.wv.setAttribute('src', tab.url || newTabUrl());
    });
    if (activeId && tabs.some(t => t.id === activeId)) switchTab(activeId);
    else if (tabs[0]) switchTab(tabs[0].id);
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const [tab] = tabs.splice(idx, 1);
    try { tab.wv?.remove(); } catch {}
    if (activeId === id) {
      const next = tabs[idx] || tabs[idx - 1];
      activeId = next ? next.id : null;
    }
    if (!tabs.length) addTab(homeUrl());
    else if (activeId) switchTab(activeId);
    renderTabs();
  }

  function switchTab(id) {
    activeId = id;
    tabs.forEach(t => { if (t.wv) t.wv.style.display = t.id === id ? 'flex' : 'none'; });
    renderTabs();
    syncActive();
  }

  function activeTab() { return tabs.find(t => t.id === activeId) || null; }

  function renderTabs() {
    const bar = document.getElementById('pch-tabs');
    if (!bar) return;
    bar.innerHTML = tabs.map(t => `
      <div class="pch-tab ${t.id === activeId ? 'active' : ''}" onclick="PerchancePanel.switchTab(${t.id})" title="${escapeHtml(t.url || '')}">
        <span class="pch-tab-title">${escapeHtml(t.title || 'Nueva pestaña')}</span>
        <button class="pch-tab-close" onclick="event.stopPropagation();PerchancePanel.closeTab(${t.id})" title="Cerrar pestaña">&times;</button>
      </div>`).join('') + `<button class="pch-tab-add" onclick="PerchancePanel.addTab()" title="Nueva pestaña">+</button>`;
  }

  function getWv() { const t = activeTab(); return t ? t.wv : null; }

  function toggle() {
    const sb = document.getElementById('perchance-sidebar');
    if (!sb) injectPanel();
    const el = document.getElementById('perchance-sidebar');
    if (!el) return;
    const opening = !el.classList.contains('open');
    if (opening) resumeTabs();
    else suspendTabs();
    el.classList.toggle('open');
    syncToggleBtn(opening);
    if (!opening) closeExtractor();
  }
  function openPanel() {
    const sb = document.getElementById('perchance-sidebar');
    if (!sb) injectPanel();
    const el = document.getElementById('perchance-sidebar');
    if (el && !el.classList.contains('open')) {
      resumeTabs();
      el.classList.add('open');
      syncToggleBtn(true);
    }
  }
  function closePanel() {
    const el = document.getElementById('perchance-sidebar');
    if (el && el.classList.contains('open')) {
      suspendTabs();
      el.classList.remove('open');
      syncToggleBtn(false);
    }
    closeExtractor();
  }

  function syncToggleBtn(open) {
    const btn = document.getElementById('chat-toggle-pch');
    if (!btn) return;
    btn.className = 'chat-toggle ' + (open ? 'open' : 'closed');
    btn.innerHTML = open ? '&#9654;' : '&#9664;';
    btn.title = open ? 'Cerrar Perchance' : 'Abrir Perchance (Ctrl+Shift+Y)';
  }

  function navigate(raw) {
    const wv = getWv();
    if (!wv) return;
    let url = String(raw || '').trim();
    if (!url) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      // ya trae protocolo
    } else if (/^[a-z0-9]+$/i.test(url)) {
      url = 'https://perchance.org/' + url; // código de generador
    } else if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url)) {
      url = 'https://' + url; // dominio sin protocolo
    } else {
      url = 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
    }
    wv.setAttribute('src', url);
    const i = document.getElementById('pch-urlbar'); if (i) i.value = url;
  }

  function goBack() { const wv = getWv(); if (wv && wv.canGoBack && wv.canGoBack()) wv.goBack(); }
  function goForward() { const wv = getWv(); if (wv && wv.canGoForward && wv.canGoForward()) wv.goForward(); }
  function reload() {
    const wv = getWv();
    if (!wv) return;
    try {
      if (typeof wv.reloadIgnoringCache === 'function') wv.reloadIgnoringCache();
      else if (wv.reload) wv.reload();
    } catch {}
  }
  function home() { navigate(homeUrl()); }

  function syncActive() {
    const wv = getWv();
    const i = document.getElementById('pch-urlbar');
    if (!wv || !i) return;
    try { const u = wv.getURL(); if (u) i.value = u; } catch {}
    updateBookmarkBtn();
  }

  function safeGetURL(wv) { try { return wv ? (wv.getURL() || '') : ''; } catch { return ''; } }
  function safeGetTitle(wv) { try { return wv ? (wv.getTitle() || '') : ''; } catch { return ''; } }
  function currentUrl() { return safeGetURL(getWv()); }
  function currentTitle() { return safeGetTitle(getWv()); }

  function faviconFor(url) {
    try {
      const host = new URL(url).hostname;
      return host.charAt(0).toUpperCase();
    } catch { return '🔖'; }
  }

  function renderBookmarks() {
    const list = document.getElementById('pch-extractor-bookmarks') || document.getElementById('pch-bookmarks');
    if (!list) return;
    if (!bookmarks.length) {
      list.innerHTML = '<div class="pch-bm-empty">Sin marcadores.<br><small>Usá ★ para guardar el generador actual.</small></div>';
      return;
    }
    list.innerHTML = bookmarks.map((b, i) => `
      <div class="pch-bm-item" title="${escapeHtml(b.url)}">
        <span class="pch-bm-fav">${escapeHtml(b.favicon || faviconFor(b.url))}</span>
        <span class="pch-bm-title" onclick="PerchancePanel.openBookmark(${i})">${escapeHtml(b.title || b.url)}</span>
        <button class="pch-bm-del" onclick="PerchancePanel.removeBookmark(${i})" title="Quitar">&#215;</button>
      </div>`).join('');
  }

  function toggleBookmark() {
    const url = currentUrl();
    if (!url || /^(about|mc|chrome):/i.test(url)) return;
    const idx = bookmarks.findIndex(b => b.url === url);
    if (idx >= 0) { bookmarks.splice(idx, 1); }
    else { bookmarks.push({ url, title: currentTitle() || url, favicon: faviconFor(url), added: Date.now() }); }
    save(BM_KEY, bookmarks);
    renderBookmarks();
    updateBookmarkBtn();
  }
  function removeBookmark(i) {
    if (bookmarks[i]) { bookmarks.splice(i, 1); save(BM_KEY, bookmarks); renderBookmarks(); updateBookmarkBtn(); }
  }
  function openBookmark(i) { const b = bookmarks[i]; if (b) navigate(b.url); }
  function updateBookmarkBtn() {
    const btn = document.getElementById('pch-bookmark-btn');
    if (!btn) return;
    const url = currentUrl();
    const isBm = url && bookmarks.some(b => b.url === url);
    btn.innerHTML = isBm ? '&#9733;' : '&#9734;';
    btn.title = isBm ? 'Quitar marcador' : 'Marcar página';
  }

  // ---- Historial ----
  function addHistory(url, title) {
    if (!url || /^(about|mc|chrome):/i.test(url)) return;
    history = history.filter(h => h.url !== url);
    history.unshift({ url, title: title || url, time: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    save(HIST_KEY, history);
    renderHistory();
  }
  function renderHistory() {
    const list = document.getElementById('pch-extractor-history') || document.getElementById('pch-history');
    if (!list) return;
    if (!history.length) {
      list.innerHTML = '<div class="pch-bm-empty">Sin historial.</div>';
      return;
    }
    list.innerHTML = history.slice(0, 30).map((h, i) => `
      <div class="pch-hist-item" title="${escapeHtml(h.url)}">
        <span class="pch-bm-fav">${escapeHtml(faviconFor(h.url))}</span>
        <span class="pch-bm-title" onclick="PerchancePanel.openHistory(${i})">${escapeHtml(h.title || h.url)}</span>
        <button class="pch-bm-del" onclick="PerchancePanel.removeHistory(${i})" title="Quitar">&#215;</button>
      </div>`).join('');
  }
  function toggleHistory() {
    openExtractor('history');
  }
  function openHistory(i) { const h = history[i]; if (h) navigate(h.url); }
  function removeHistory(i) {
    if (history[i]) { history.splice(i, 1); save(HIST_KEY, history); renderHistory(); }
  }

  // ---- Segundo panel acoplado (overlay, como el extractor de WhatsApp) ----
  const EXTRACTOR_ID = 'pch-extractor-overlay';
  let extractorTab = 'bookmarks';
  let followRaf = null;
  let lastTop = null, lastLeft = null, lastHeight = null;

  function ensureExtractor() {
    let ov = document.getElementById(EXTRACTOR_ID);
    if (ov) {
      if (ov.parentElement !== document.body) document.body.appendChild(ov);
      return ov;
    }
    ov = document.createElement('div');
    ov.id = EXTRACTOR_ID;
    ov.className = 'pch-scope';
    ov.onclick = (e) => { if (e.target === ov) closeExtractor(); };
    ov.innerHTML = `
      <div id="pch-extractor-dialog">
        <div class="pch-extractor-head">
          <strong>📑 Panel de Perchance</strong>
          <span id="pch-extractor-count" style="color:var(--muted);font-size:10px;"></span>
          <button class="btn ghost btn-sm" onclick="PerchancePanel.clearAllData()" title="Borrar todos los datos">🗑</button>
          <button class="btn ghost btn-sm" onclick="PerchancePanel.closeExtractor()" title="Cerrar">&#215;</button>
        </div>
        <div class="pch-extractor-tabs">
          <button class="pch-extractor-tab active" data-tab="bookmarks" onclick="PerchancePanel.switchExtractorTab('bookmarks')">Marcadores</button>
          <button class="pch-extractor-tab" data-tab="history" onclick="PerchancePanel.switchExtractorTab('history')">Historial</button>
          <button class="pch-extractor-tab" data-tab="settings" onclick="PerchancePanel.switchExtractorTab('settings')">Configuración</button>
        </div>
        <div id="pch-extractor-content">
          <div id="pch-extractor-bookmarks" class="pch-extractor-section active"></div>
          <div id="pch-extractor-history" class="pch-extractor-section"></div>
          <div id="pch-extractor-settings" class="pch-extractor-section"></div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    return ov;
  }

  function openExtractor(tab) {
    const sb = document.getElementById('perchance-sidebar');
    if (!sb || !sb.classList.contains('open')) openPanel();
    const ov = ensureExtractor();
    if (tab) switchExtractorTab(tab);
    ov.classList.add('open');
    followExtractor();
  }
  function closeExtractor() {
    const ov = document.getElementById(EXTRACTOR_ID);
    if (ov) ov.classList.remove('open');
    stopFollow();
  }
  function toggleExtractor(tab) {
    const ov = document.getElementById(EXTRACTOR_ID);
    if (ov && ov.classList.contains('open')) closeExtractor();
    else openExtractor(tab);
  }
  function switchExtractorTab(tab) {
    extractorTab = tab;
    document.querySelectorAll('.pch-extractor-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    ['bookmarks', 'history', 'settings'].forEach(t => {
      const sec = document.getElementById('pch-extractor-' + t);
      if (sec) sec.classList.toggle('active', t === tab);
    });
    if (tab === 'bookmarks') renderBookmarks();
    else if (tab === 'history') renderHistory();
    else if (tab === 'settings') renderSettings();
  }
  function followExtractor() {
    if (followRaf) return;
    const ov = document.getElementById(EXTRACTOR_ID);
    const sb = document.getElementById('perchance-sidebar');
    if (!ov || !sb) return;
    const tick = () => {
      if (!ov.classList.contains('open')) { followRaf = null; return; }
      if (!sb.classList.contains('open')) { closeExtractor(); return; }
      const r = sb.getBoundingClientRect();
      const width = ov.getBoundingClientRect().width || 340;
      const top = Math.round(r.top);
      const left = Math.max(0, Math.round(r.left - width));
      const height = Math.round(r.height);
      if (top !== lastTop || left !== lastLeft || height !== lastHeight) {
        lastTop = top; lastLeft = left; lastHeight = height;
        ov.style.top = top + 'px';
        ov.style.left = left + 'px';
        ov.style.height = height + 'px';
      }
      followRaf = requestAnimationFrame(tick);
    };
    followRaf = requestAnimationFrame(tick);
  }
  function stopFollow() {
    if (followRaf) { cancelAnimationFrame(followRaf); followRaf = null; }
    lastTop = lastLeft = lastHeight = null;
  }

  function renderSettings() {
    const sec = document.getElementById('pch-extractor-settings');
    if (!sec) return;
    sec.innerHTML = `
      <div class="pch-settings">
        <div class="pch-set-row">
          <label for="pch-set-home">Inicio</label>
          <input id="pch-set-home" type="text" spellcheck="false" autocomplete="off" placeholder="https://perchance.org/..." value="${escapeHtml(homeUrl())}"/>
        </div>
        <div class="pch-set-row">
          <label for="pch-set-newtab">Nueva pestaña</label>
          <input id="pch-set-newtab" type="text" spellcheck="false" autocomplete="off" placeholder="https://www.google.com/" value="${escapeHtml(newTabUrl())}"/>
        </div>
        <div class="pch-set-actions">
          <button class="pch-set-btn" onclick="PerchancePanel.saveSettings()">Guardar</button>
          <button class="pch-set-btn" onclick="PerchancePanel.resetSettings()">Restaurar</button>
        </div>
        <div class="pch-set-divider">Datos del panel</div>
        <div class="pch-set-actions">
          <button class="pch-set-btn" onclick="PerchancePanel.clearCache()">Limpiar caché</button>
          <button class="pch-set-btn" onclick="PerchancePanel.clearCookies()">Limpiar cookies</button>
          <button class="pch-set-btn" onclick="PerchancePanel.clearHistory()">Borrar historial</button>
          <button class="pch-set-btn" onclick="PerchancePanel.clearBookmarks()">Borrar marcadores</button>
          <button class="pch-set-btn pch-set-danger" onclick="PerchancePanel.clearAllData()">Borrar todo</button>
        </div>
        <div class="pch-set-row">
          <label>Descargas</label>
          <span class="pch-set-dl">~/Downloads/Perchance</span>
          <button class="pch-set-btn" onclick="PerchancePanel.openDlFolder()">Abrir</button>
        </div>
        <div class="pch-set-status" id="pch-set-status"></div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Descargas del panel (blob/data) → log
  if (window.mc && typeof mc.onPerchanceDownload === 'function') {
    mc.onPerchanceDownload((ev) => {
      if (ev && ev.type === 'done') console.log('[PERCHANCE] descarga:', ev.success ? 'OK' : 'falló', ev.filename);
    });
    mc.on('perchance-open-tab', (url) => {
      if (!/^https?:\/\//i.test(url || '')) return;
      openPanel();
      addTab(url);
    });
  }

  // ---- Configuración y gestión de datos ----
  function toggleSettings() {
    toggleExtractor('settings');
  }
  function saveSettings() {
    const h = (document.getElementById('pch-set-home')?.value || '').trim();
    const n = (document.getElementById('pch-set-newtab')?.value || '').trim();
    if (h) settings.home = h;
    if (n) settings.newTab = n;
    save(SET_KEY, settings);
    setStatus('Configuración guardada');
  }
  function resetSettings() {
    settings = { home: HOME_DEFAULT, newTab: NEW_TAB_DEFAULT };
    save(SET_KEY, settings);
    const h = document.getElementById('pch-set-home'); if (h) h.value = HOME_DEFAULT;
    const n = document.getElementById('pch-set-newtab'); if (n) n.value = NEW_TAB_DEFAULT;
    setStatus('Configuración restaurada');
  }
  function setStatus(msg) {
    const el = document.getElementById('pch-set-status');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => { if (el) el.textContent = ''; }, 2500);
  }
  async function clearCache() {
    try {
      const r = await mc.clearPerchanceData({ cache: true, cookies: false, storage: false });
      setStatus(r && r.cache ? 'Caché limpiada' : 'Error al limpiar caché');
    } catch { setStatus('Error al limpiar caché'); }
  }
  async function clearCookies() {
    try {
      const r = await mc.clearPerchanceData({ cache: false, cookies: true, storage: false });
      setStatus(r && r.cookies ? 'Cookies limpiadas' : 'Error al limpiar cookies');
    } catch { setStatus('Error al limpiar cookies'); }
  }
  function clearHistory() {
    history = [];
    save(HIST_KEY, history);
    renderHistory();
    setStatus('Historial borrado');
  }
  function clearBookmarks() {
    bookmarks = [];
    save(BM_KEY, bookmarks);
    renderBookmarks();
    updateBookmarkBtn();
    setStatus('Marcadores borrados');
  }
  async function clearAllData() {
    try { await mc.clearPerchanceData({ cache: true, cookies: true, storage: true }); } catch {}
    history = [];
    save(HIST_KEY, history);
    renderHistory();
    bookmarks = [];
    save(BM_KEY, bookmarks);
    renderBookmarks();
    updateBookmarkBtn();
    setStatus('Todos los datos borrados');
  }
  function openDlFolder() {
    try { if (window.mc && typeof mc.openPerchanceDlFolder === 'function') mc.openPerchanceDlFolder(); } catch {}
  }

  window.PerchancePanel = {
    toggle, open: openPanel, close: closePanel,
    navigate, goBack, goForward, reload, home,
    addTab, closeTab, switchTab,
    toggleBookmark, removeBookmark, openBookmark,
    toggleHistory, openHistory, removeHistory,
    toggleSettings, saveSettings, resetSettings,
    clearCache, clearCookies, clearHistory, clearBookmarks, clearAllData,
    openDlFolder,
    openExtractor, closeExtractor, toggleExtractor, switchExtractorTab
  };
})();