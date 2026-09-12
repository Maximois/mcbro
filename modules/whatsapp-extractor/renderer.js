// modules/whatsapp-extractor/renderer.js
// Módulo independiente: extracción de multimedia de WhatsApp Web.
// Detecta estados, media de chat, notas de voz, perfiles y enlaces directos.
// No modifica los extractores genéricos (extractPageResources / showExtractor).

(function () {
  'use strict';

  const OVERLAY_ID = 'wa-extractor-overlay';

  const WhatsAppExtractor = {
    _resources: [],
    _filter: 'all',
    _downloads: [],
    _dlSeq: 0,
    _followRaf: null,
    _lastTop: null,
    _lastLeft: null,
    _lastHeight: null,

    init() {
      this.injectButton();
      this.ensureOverlay();
      this.loadDownloads();
    },

    // ── Botón en el panel de WhatsApp ──
    injectButton() {
      const tryInject = () => {
        const actions = document.querySelector('#wa-sidebar .wch-actions');
        if (!actions) return false;
        if (document.getElementById('wa-extract-btn')) return true;
        const btn = document.createElement('button');
        btn.id = 'wa-extract-btn';
        btn.className = 'wch-action-btn';
        btn.textContent = '📥 Extraer media';
        btn.title = 'Extraer multimedia de WhatsApp (estados, chat, voz, perfiles)';
        btn.onclick = () => this.extract();
        actions.appendChild(btn);
        return true;
      };
      if (tryInject()) return;
      const obs = new MutationObserver(() => {
        if (tryInject()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    },

    // ── Overlay dedicado, anclado al borde del panel de WhatsApp ──
    ensureOverlay() {
      const existing = document.getElementById(OVERLAY_ID);
      if (existing) {
        if (existing.parentElement !== document.body) {
          document.body.appendChild(existing);
        }
        return;
      }
      const ov = document.createElement('div');
      ov.id = OVERLAY_ID;
      ov.onclick = (e) => { if (e.target === ov) this.close(); };
      ov.innerHTML = `
        <div id="wa-extractor-dialog">
          <div class="wa-extractor-head">
            <strong>📥 Media de WhatsApp</strong>
            <span id="wa-extractor-count" style="color:var(--muted);font-size:10px;"></span>
            <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.extract()" title="Volver a extraer">🔄</button>
            <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.clearDownloads()" title="Limpiar historial de descargas">🗑</button>
            <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.close()" title="Cerrar">&#215;</button>
          </div>
          <div class="wa-extractor-filters">
            <button class="wa-extractor-filter active" data-filter="all" onclick="WhatsAppExtractor.filter('all')">Todos</button>
            <button class="wa-extractor-filter" data-filter="Perfil" onclick="WhatsAppExtractor.filter('Perfil')">Perfil</button>
            <button class="wa-extractor-filter" data-filter="Imagen" onclick="WhatsAppExtractor.filter('Imagen')">Imagen</button>
            <button class="wa-extractor-filter" data-filter="Videos" onclick="WhatsAppExtractor.filter('Videos')">Videos</button>
            <button class="wa-extractor-filter" data-filter="Descargas" onclick="WhatsAppExtractor.filter('Descargas')">Descargas</button>
          </div>
          <div id="wa-extractor-list"></div>
        </div>
      `;
      document.body.appendChild(ov);
    },

    // ── Historial de descargas de WhatsApp (panel propio, persistente) ──
    loadDownloads() {
      try {
        const raw = localStorage.getItem('mc_wa_downloads');
        if (raw) this._downloads = JSON.parse(raw);
        if (!Array.isArray(this._downloads)) this._downloads = [];
      } catch { this._downloads = []; }
    },
    saveDownloads() {
      try { localStorage.setItem('mc_wa_downloads', JSON.stringify(this._downloads.slice(0, 200))); } catch {}
    },
    trackDownload(entry) {
      this._downloads.unshift(entry);
      if (this._downloads.length > 200) this._downloads.length = 200;
      this.saveDownloads();
    },
    clearDownloads() {
      this._downloads = [];
      this.saveDownloads();
      if (this._filter === 'Descargas') this.render();
      if (typeof addSidebarLog === 'function') addSidebarLog('info', '[WA-EXTRACT] Historial de descargas limpiado');
    },
    async openDownloadFile(index) {
      const d = this._downloads[index];
      if (!d?.path) return;
      if (typeof mc?.waMediaOpenFile === 'function') {
        const res = await mc.waMediaOpenFile({ path: d.path });
        if (!res?.ok && typeof addSidebarLog === 'function') {
          addSidebarLog('blocked', '[WA-EXTRACT] No se pudo abrir: ' + (res?.error || 'desconocido'));
        }
      }
    },

    // ── Extracción (se ejecuta dentro del webview de WhatsApp) ──
    async extract() {
      const wv = document.getElementById('wa-wv');
      if (!wv || !wv.executeJavaScript) {
        this.showMessage('El panel de WhatsApp no está disponible. Abrí el panel con Ctrl+Shift+Q.');
        return;
      }
      this.open();
      this.showMessage('⏳ Extrayendo multimedia de WhatsApp...');
      try {
        const data = await wv.executeJavaScript(`(async () => {
          const found = [];
          const seen = new Set();
          const add = (item) => {
            if (!item || !item.url) return;
            const key = item.url + '|' + item.type;
            if (seen.has(key)) return;
            seen.add(key);
            found.push(item);
          };
          const toDataUrl = async (blobUrl) => {
            try {
              const blob = await fetch(blobUrl).then(r => r.blob());
              if (blob.size > 60 * 1024 * 1024) return null;
              return await new Promise(res => {
                const reader = new FileReader();
                reader.onload = () => res(reader.result);
                reader.readAsDataURL(blob);
              });
            } catch { return null; }
          };
          const isFullscreenOverlay = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 250 || rect.height < 250) return false;
            let p = el.parentElement;
            while (p && p !== document.body) {
              const cs = getComputedStyle(p);
              const pr = p.getBoundingClientRect();
              if ((cs.position === 'fixed' || cs.position === 'absolute') && pr.width >= window.innerWidth * 0.6) return true;
              p = p.parentElement;
            }
            return false;
          };
          const isStatusEl = (el) => el.closest('[data-testid="status-viewer"]') || isFullscreenOverlay(el);
          const categorize = (el) => {
            const tag = el.tagName.toLowerCase();
            const isVideo = tag === 'video' || (tag === 'source' && el.parentElement?.tagName?.toLowerCase() === 'video');
            const rect = el.getBoundingClientRect();
            const small = rect.width > 0 && rect.width <= 80 && rect.height <= 80;
            if (isVideo) return 'Videos';
            const inProfileArea = el.closest('[data-testid="chat-list"], [data-testid="conversation-info-header"], [data-testid="conversation-panel-header"], [data-testid="chat-list-search"]');
            const avatarHint = el.closest('[data-testid*="avatar"], [data-testid*="profile"], [data-testid*="contact"]');
            if ((inProfileArea && small) || (avatarHint && small)) return 'Perfil';
            const isStatus = el.closest('[data-testid="status-viewer"]') || isFullscreenOverlay(el);
            if (isStatus) return 'Imagen';
            return 'Imagen';
          };
          let blobCount = 0;
          const els = [...document.querySelectorAll('img, video, audio, source')];
          for (const el of els) {
            const src = el.currentSrc || el.src;
            if (!src) continue;
            const tag = el.tagName.toLowerCase();
            const parentTag = el.parentElement?.tagName?.toLowerCase() || '';
            const type = tag === 'img' ? 'image' : (tag === 'video' || parentTag === 'video') ? 'video' : (tag === 'audio' || parentTag === 'audio') ? 'audio' : 'image';
            const cat = categorize(el);
            const label = (el.alt || el.title || '').trim() || (cat + ' ' + type);
            let url = src;
            let preview = null;
            if (src.startsWith('blob:')) {
              if (blobCount >= 100) continue;
              blobCount++;
              const dataUrl = await toDataUrl(src);
              if (!dataUrl) continue;
              url = dataUrl;
              preview = dataUrl;
            } else if (/^https?:/i.test(src)) {
              // Media de estado: convertir a data URL para descarga directa
              // (los estados son blobs de IndexedDB; la URL http puede expirar)
              if (isStatusEl(el) && blobCount < 100) {
                blobCount++;
                const dataUrl = await toDataUrl(src);
                if (dataUrl) {
                  url = dataUrl;
                  preview = dataUrl;
                } else {
                  preview = src;
                }
              } else {
                preview = src;
              }
            } else {
              continue;
            }
            add({ url, type, label, source: cat, preview });
          }
          return { title: 'WhatsApp Web', resources: found.slice(0, 500) };
        })()`);
        this._resources = Array.isArray(data?.resources) ? data.resources : [];
        this._filter = 'all';
        console.log('[WA-EXTRACT] Encontrados:', this._resources.length, this._resources.map(r => r.source + ':' + r.type).join(', '));
        this.render();
      } catch (e) {
        console.error('[WA-EXTRACT]', e);
        this.showMessage('Error al extraer: ' + (e.message || e));
      }
    },

    // ── UI ──
    open() {
      this.ensureOverlay();
      const ov = document.getElementById(OVERLAY_ID);
      const waSidebar = document.getElementById('wa-sidebar');
      if (ov && waSidebar) {
        const r = waSidebar.getBoundingClientRect();
        const width = ov.getBoundingClientRect().width || 340;
        ov.style.position = 'fixed';
        ov.style.top = r.top + 'px';
        ov.style.left = Math.max(0, r.left - width) + 'px';
        ov.style.height = r.height + 'px';
        ov.style.width = width + 'px';
      }
      if (ov) ov.classList.add('open');
      this._followPanel();
    },
    close() {
      const ov = document.getElementById(OVERLAY_ID);
      if (ov) ov.classList.remove('open');
      this._stopFollow();
    },
    // Mantiene el overlay pegado al borde izquierdo del panel de WhatsApp
    // mientras esté abierto: si el panel se mueve o se redimensiona (handle
    // de resize, cambio de tamaño de ventana, transición de apertura), el
    // overlay lo sigue. Usa requestAnimationFrame y se detiene al cerrar.
    _followPanel() {
      if (this._followRaf) return;
      const ov = document.getElementById(OVERLAY_ID);
      const waSidebar = document.getElementById('wa-sidebar');
      if (!ov || !waSidebar) return;
      const tick = () => {
        if (!ov.classList.contains('open')) { this._followRaf = null; return; }
        // Si el panel de WhatsApp se cerró, cerrar el overlay también
        if (!waSidebar.classList.contains('open')) { this.close(); return; }
        const r = waSidebar.getBoundingClientRect();
        const width = ov.getBoundingClientRect().width || 340;
        const top = Math.round(r.top);
        const left = Math.max(0, Math.round(r.left - width));
        const height = Math.round(r.height);
        if (top !== this._lastTop || left !== this._lastLeft || height !== this._lastHeight) {
          this._lastTop = top;
          this._lastLeft = left;
          this._lastHeight = height;
          ov.style.top = top + 'px';
          ov.style.left = left + 'px';
          ov.style.height = height + 'px';
        }
        this._followRaf = requestAnimationFrame(tick);
      };
      this._followRaf = requestAnimationFrame(tick);
    },
    _stopFollow() {
      if (this._followRaf) {
        cancelAnimationFrame(this._followRaf);
        this._followRaf = null;
      }
      this._lastTop = this._lastLeft = this._lastHeight = null;
    },
    showMessage(msg) {
      const list = document.getElementById('wa-extractor-list');
      const count = document.getElementById('wa-extractor-count');
      if (count) count.textContent = '';
      if (list) list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted);">${msg}</div>`;
    },
    filter(type) {
      this._filter = type;
      document.querySelectorAll('.wa-extractor-filter').forEach(b => b.classList.toggle('active', b.dataset.filter === type));
      this.render();
    },
    render() {
      const list = document.getElementById('wa-extractor-list');
      const count = document.getElementById('wa-extractor-count');
      if (!list) return;
      if (this._filter === 'Descargas') {
        if (count) count.textContent = this._downloads.length + ' descargas';
        if (!this._downloads.length) {
          list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">Sin descargas de WhatsApp todavía.<br><small style="opacity:.7">Descargá media con el botón ⬇ y aparecerá aquí con su historial.</small></div>';
          return;
        }
        list.innerHTML = this._downloads.map((d, i) => {
          const date = new Date(d.ts || Date.now()).toLocaleString();
          const size = d.size ? (d.size / 1048576).toFixed(1) + ' MB' : '';
          return `<div class="wa-extractor-item">
            <div class="wa-extractor-thumb"><span class="wa-extractor-thumb-icon">${d.type === 'video' ? 'VID' : d.type === 'audio' ? 'AUD' : 'IMG'}</span></div>
            <div class="wa-extractor-info">
              <div class="wa-extractor-label">${escapeHtml(d.filename || '')}</div>
              <div class="wa-extractor-url" title="${escapeHtml(d.path || '')}">${escapeHtml(date)} ${escapeHtml(size)}</div>
            </div>
            <div class="wa-extractor-actions">
              <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.openDownloadFile(${i})" title="Abrir archivo">📂</button>
              <button class="btn ghost btn-sm" onclick="mc.openDlFolder()" title="Abrir carpeta de descargas">🗀</button>
            </div>
          </div>`;
        }).join('');
        return;
      }
      if (count) count.textContent = this._resources.length + ' recursos';
      const items = this._resources.map((item, index) => ({ item, index }))
        .filter(({ item }) => this._filter === 'all' || item.source === this._filter);
      if (!items.length) {
        list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);">No se encontraron recursos de este tipo.<br><small style="opacity:.7">Abrí un estado en WhatsApp y volvé a extraer.</small></div>';
        return;
      }
      list.innerHTML = items.map(({ item, index }) => {
        const typeLabel = item.type === 'image' ? 'IMG' : item.type === 'video' ? 'VID' : item.type === 'audio' ? 'AUD' : 'LNK';
        const thumb = item.preview
          ? `<img src="${item.preview.replace(/"/g, '&quot;')}" onerror="this.style.display='none'">`
          : `<span class="wa-extractor-thumb-icon">${typeLabel}</span>`;
        return `<div class="wa-extractor-item">
          <div class="wa-extractor-thumb">${thumb}</div>
          <div class="wa-extractor-info">
            <div class="wa-extractor-label">${escapeHtml(item.label)} <span class="wa-extractor-src">${escapeHtml(item.source || '')}</span></div>
            <div class="wa-extractor-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url.slice(0, 90))}</div>
          </div>
          <div class="wa-extractor-actions">
            <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.openItem(${index})" title="Abrir en pestaña">↗</button>
            <button class="btn ghost btn-sm" onclick="WhatsAppExtractor.copyItem(${index})" title="Copiar URL">⧉</button>
            <button class="btn warn btn-sm" onclick="WhatsAppExtractor.download(${index})" title="Descargar">⬇</button>
          </div>
        </div>`;
      }).join('');
    },

    // ── Acciones ──
    async openItem(index) {
      const item = this._resources[index];
      if (!item?.url) return;
      if (item.url.startsWith('data:')) {
        // Las data URLs grandes no se renderizan en un webview (Chromium las descarga).
        // Guardar a archivo temporal y abrir file:// en una pestaña.
        if (typeof mc?.waMediaOpen === 'function') {
          const res = await mc.waMediaOpen({ data: item.url });
          if (res?.ok) {
            if (typeof window.addTab === 'function') window.addTab('file:///' + res.path.replace(/\\/g, '/'));
          } else if (typeof addSidebarLog === 'function') {
            addSidebarLog('blocked', '[WA-EXTRACT] Error al abrir: ' + (res?.error || 'desconocido'));
          }
        }
        return;
      }
      if (typeof window.addTab === 'function') window.addTab(item.url);
    },
    copyItem(index) {
      const item = this._resources[index];
      if (item?.url) navigator.clipboard?.writeText(item.url);
    },
    _uniqueBase(label) {
      this._dlSeq = (this._dlSeq + 1) % 100000;
      const clean = (label || 'media').replace(/[^\w\-]+/g, '_').slice(0, 60);
      return 'wa-' + clean + '-' + Date.now() + '-' + this._dlSeq + '-' + Math.random().toString(36).slice(2, 6);
    },
    async download(index) {
      const item = this._resources[index];
      if (!item?.url) return;
      if (item.url.startsWith('data:')) {
        const m = /^data:([^;,]*);base64,(.*)$/s.exec(item.url);
        if (!m) return;
        let mimeType = m[1];
        // WhatsApp a veces da blobs sin tipo MIME (o application/octet-stream) →
        // inferir del tipo del ítem para que el archivo tenga la extensión correcta.
        if (!mimeType || mimeType === 'application/octet-stream') {
          mimeType = item.type === 'video' ? 'video/mp4' : item.type === 'audio' ? 'audio/mp3' : 'image/jpeg';
        }
        const base = this._uniqueBase(item.label);
        if (typeof mc?.waMediaSave === 'function') {
          const res = await mc.waMediaSave({ data: m[2], mimeType, filename: base });
          if (res?.ok) {
            this.trackDownload({ filename: res.filename, path: res.path, size: res.size || 0, type: item.type, ts: Date.now() });
            if (typeof addSidebarLog === 'function') addSidebarLog('info', '[WA-EXTRACT] Guardado: ' + res.filename);
          } else {
            if (typeof addSidebarLog === 'function') addSidebarLog('blocked', '[WA-EXTRACT] Error: ' + (res?.error || 'desconocido'));
          }
        }
      } else if (/^https?:/i.test(item.url)) {
        // Media de WhatsApp: descargar con la sesión persist:mc (cookies).
        // Los estados son blobs de IndexedDB (data URLs); yt-dlp no aplica aquí.
        if (typeof mc?.waMediaDownload === 'function') {
          const extMatch = /\.(mp4|webm|mp3|ogg|opus|wav|jpg|jpeg|png|gif|webp)(?:[?#]|$)/i.exec(item.url);
          const ext = extMatch ? extMatch[1] : (item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'mp3' : 'jpg');
          const base = this._uniqueBase(item.label);
          const res = await mc.waMediaDownload({ url: item.url, filename: base + '.' + ext });
          if (res?.ok) {
            this.trackDownload({ filename: res.filename, path: res.path, size: res.size || 0, type: item.type, ts: Date.now() });
            if (typeof addSidebarLog === 'function') addSidebarLog('info', '[WA-EXTRACT] Guardado: ' + res.filename);
          } else {
            if (typeof addSidebarLog === 'function') addSidebarLog('blocked', '[WA-EXTRACT] Error descarga: ' + (res?.error || 'desconocido'));
          }
        }
      }
    }
  };

  window.WhatsAppExtractor = WhatsAppExtractor;
  WhatsAppExtractor.init();
})();