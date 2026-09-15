// modules/perchance-panel/renderer.js
// Panel de Perchance: mini-navegador en sidebar con marcadores propios.
// Usa la partición persist:perchance (allowlist, permisos, CSP/XFO y
// descargas blob/data) configurada por perchance/perchance-panel.js en el
// proceso principal. El <webview> navega libremente (mainFrame permitido) y
// los recursos del ecosistema Perchance cargan sin bloqueos.

(function () {
  'use strict';

  const HOME = 'https://perchance.org/4cffvbcm0c';
  const NEW_TAB = 'https://www.google.com/';
  const PARTITION = 'persist:perchance';
  const NATIVE_UA = navigator.userAgent;
  const BM_KEY = 'mc_perchance_bookmarks';
  const HIST_KEY = 'mc_perchance_history';
  const WIDTH_KEY = 'mc-panel-w-pch';
  const MAX_HISTORY = 200;

  let bookmarks = load(BM_KEY, []);
  let history = load(HIST_KEY, []);
  let tabs = [];
  let activeId = null;
  let tabSeq = 0;
  const loadTimers = new WeakMap();
  const loadRetries = new WeakMap();

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
        <button class="pch-nav-btn" id="pch-history-btn" onclick="PerchancePanel.toggleHistory()" title="Historial">&#128337;</button>
      </div>
      <div class="pch-bookmarks" id="pch-bookmarks"></div>
      <div class="pch-history" id="pch-history" style="display:none"></div>
      <div class="pch-wv-container" id="pch-wv-container"></div>
    `;
    const main = document.getElementById('main');
    if (main) main.appendChild(sb); else document.body.appendChild(sb);
    if (window.PanelResize && typeof window.PanelResize.attach === 'function') {
      window.PanelResize.attach(sb, WIDTH_KEY, 420);
    }
    addTab(HOME);
    renderBookmarks();
    renderHistory();
  }

  function createWebview() {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', PARTITION);
    wv.setAttribute('useragent', NATIVE_UA);
    wv.setAttribute('allowpopups', '');
    wv.style.display = 'none';
    const container = document.getElementById('pch-wv-container');
    if (container) container.appendChild(wv);
    wv.addEventListener('did-start-navigation', (e) => {
      if (e.isMainFrame !== false) setUserAgentForUrl(wv, e.url);
    });
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
    wv.addEventListener('dom-ready', () => {
      try {
        if (!wv.getURL()) wv.loadURL(HOME);
        installNavInterceptor(wv);
      } catch {}
    });
    // Fallback: si un enlace/popup escapa al interceptor inyectado, navega
    // dentro del panel en vez de abrir popups sueltos o pestañas del navegador.
    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      const url = e.url || '';
      if (!url) return;
      addTab(url);
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

  function setUserAgentForUrl(wv, url) {
    try {
      wv.setAttribute('useragent', NATIVE_UA);
    } catch { wv.setAttribute('useragent', NATIVE_UA); }
  }

  // Intercepta window.open y clics en <a target="_blank"> para navegar dentro
  // del panel (mismo webview) en vez de abrir popups.
  function installNavInterceptor(wv) {
    try {
      wv.executeJavaScript(`(() => {
        if (window.__mcPchNavInstalled) return;
        window.__mcPchNavInstalled = true;
        const go = (url) => { if (url) location.href = url; };
        const origOpen = window.open;
        window.open = function(url, name, features) { go(url); return null; };
        document.addEventListener('click', (e) => {
          const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
          if (a && a.href) { e.preventDefault(); go(a.href); }
        }, true);
      })()`).catch(() => {});
    } catch {}
  }

  function addTab(url) {
    const id = ++tabSeq;
    const wv = createWebview();
    const initialUrl = url || NEW_TAB;
    const tab = { id, title: 'Nueva pestaña', url: initialUrl, wv };
    tabs.push(tab);
    setUserAgentForUrl(wv, initialUrl);
    wv.setAttribute('src', initialUrl);
    switchTab(id);
    renderTabs();
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const [tab] = tabs.splice(idx, 1);
    try { tab.wv.remove(); } catch {}
    if (activeId === id) {
      const next = tabs[idx] || tabs[idx - 1];
      activeId = next ? next.id : null;
    }
    if (!tabs.length) addTab(HOME);
    else if (activeId) switchTab(activeId);
    renderTabs();
  }

  function switchTab(id) {
    activeId = id;
    tabs.forEach(t => { t.wv.style.display = t.id === id ? 'flex' : 'none'; });
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
    el.classList.toggle('open');
    syncToggleBtn(opening);
    if (opening) {
      const wv = getWv();
      if (wv) { try { if (!wv.getURL()) wv.loadURL(HOME); } catch {} }
    }
  }
  function openPanel() {
    const sb = document.getElementById('perchance-sidebar');
    if (!sb) injectPanel();
    const el = document.getElementById('perchance-sidebar');
    if (el && !el.classList.contains('open')) { el.classList.add('open'); syncToggleBtn(true); }
  }
  function closePanel() {
    const el = document.getElementById('perchance-sidebar');
    if (el && el.classList.contains('open')) { el.classList.remove('open'); syncToggleBtn(false); }
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
    setUserAgentForUrl(wv, url);
    try { wv.loadURL(url); } catch { wv.setAttribute('src', url); }
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
  function home() { navigate(HOME); }

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
    const list = document.getElementById('pch-bookmarks');
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
    const list = document.getElementById('pch-history');
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
    const list = document.getElementById('pch-history');
    if (!list) return;
    const show = list.style.display === 'none';
    list.style.display = show ? 'block' : 'none';
    if (show) renderHistory();
  }
  function openHistory(i) { const h = history[i]; if (h) navigate(h.url); }
  function removeHistory(i) {
    if (history[i]) { history.splice(i, 1); save(HIST_KEY, history); renderHistory(); }
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
      if (/^https?:\/\//i.test(url || '')) addTab(url);
    });
  }

  window.PerchancePanel = {
    toggle, open: openPanel, close: closePanel,
    navigate, goBack, goForward, reload, home,
    addTab, closeTab, switchTab,
    toggleBookmark, removeBookmark, openBookmark,
    toggleHistory, openHistory, removeHistory
  };
})();