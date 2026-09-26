'use strict';

const WEB_PROVIDERS = {
  copilot:  { label: 'Copilot Web',     url: 'https://copilot.microsoft.com' },
  chatgpt:  { label: 'ChatGPT',         url: 'https://chatgpt.com' },
  claude:   { label: 'Claude',          url: 'https://claude.ai' },
  'gemini-web': { label: 'Gemini',      url: 'https://gemini.google.com' },
  deepseek: { label: 'DeepSeek',        url: 'https://deepseek.com' },
  perplexity: { label: 'Perplexity',    url: 'https://perplexity.ai' },
};

// ── Redimensionado de paneles laterales (ai-sidebar / webchat-sidebar / wa-sidebar) ──
// Agrega un handle arrastrable en el borde izquierdo del panel y persiste el
// ancho elegido en localStorage, por panel.
const PanelResize = {
  MIN: 300,
  MAX_RATIO: 0.85,
  MIN_CONTENT: 240,

  maxWidth(panelEl) {
    const parent = panelEl && panelEl.parentElement;
    if (!parent) return Math.round(window.innerWidth * PanelResize.MAX_RATIO);
    const otherWidth = Array.from(parent.children)
      .filter(child => child !== panelEl && child.id !== 'content')
      .reduce((total, child) => total + child.getBoundingClientRect().width, 0);
    const available = parent.clientWidth - otherWidth - PanelResize.MIN_CONTENT;
    const ratioMax = Math.round(window.innerWidth * PanelResize.MAX_RATIO);
    return Math.min(ratioMax, Math.max(PanelResize.MIN, Math.floor(available)));
  },

  clampWidth(width, defaultWidth, storageKey) {
    const max = Math.max(PanelResize.MIN, Math.min(
      Math.round(window.innerWidth * PanelResize.MAX_RATIO),
      Math.round(window.innerWidth - PanelResize.MIN_CONTENT)
    ));
    const saved = Number(width);
    if (!Number.isFinite(saved) || saved < PanelResize.MIN || saved > max) {
      try { localStorage.setItem(storageKey, String(defaultWidth)); } catch {}
      return defaultWidth;
    }
    return Math.round(Math.min(Math.max(saved, PanelResize.MIN), max));
  },

  attach(panelEl, storageKey, defaultWidth, dockSide) {
    if (!panelEl || panelEl.dataset.resizeAttached) return;
    panelEl.dataset.resizeAttached = '1';
    const leftDocked = dockSide === 'left';

    const saved = Number(localStorage.getItem(storageKey));
    const initial = PanelResize.clampWidth(saved, defaultWidth, storageKey);
    panelEl.style.setProperty('--panel-w', initial + 'px');

    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle' + (leftDocked ? ' right-edge' : '');
    handle.title = 'Arrastrar para redimensionar';
    panelEl.appendChild(handle);

    let startX = 0;
    let startWidth = 0;
    let activePointerId = null;

    const onMove = (e) => {
      if (activePointerId === null || e.pointerId !== activePointerId) return;
      e.preventDefault();
      const max = PanelResize.maxWidth(panelEl);
      // Panel anclado a la derecha: arrastrar a la izquierda agranda.
      // Panel anclado a la izquierda (dockSide:'left'): es al revés, arrastrar
      // a la derecha agranda — el handle está en el borde opuesto del panel.
      const delta = leftDocked ? (e.clientX - startX) : (startX - e.clientX);
      const next = Math.min(max, Math.max(PanelResize.MIN, startWidth + delta));
      panelEl.style.setProperty('--panel-w', next + 'px');
    };
    const onUp = (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try { handle.releasePointerCapture(activePointerId); } catch {}
      activePointerId = null;
      panelEl.classList.remove('resizing');
      handle.classList.remove('active');
      const finalWidth = parseInt(getComputedStyle(panelEl).getPropertyValue('--panel-w'), 10)
        || panelEl.getBoundingClientRect().width;
      const clamped = PanelResize.clampWidth(finalWidth, defaultWidth, storageKey);
      panelEl.style.setProperty('--panel-w', clamped + 'px');
      try { localStorage.setItem(storageKey, String(Math.round(clamped))); } catch {}
    };

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startWidth = panelEl.getBoundingClientRect().width;
      panelEl.classList.add('resizing');
      handle.classList.add('active');
      try { handle.setPointerCapture(activePointerId); } catch {}
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  },

  reset(panelEl, storageKey, defaultWidth) {
    if (!panelEl) return;
    const clamped = PanelResize.clampWidth(defaultWidth, defaultWidth, storageKey);
    panelEl.style.setProperty('--panel-w', clamped + 'px');
    try { localStorage.setItem(storageKey, String(clamped)); } catch {}
  }
};

function destroyEmbeddedWebview(wv) {
  if (!wv) return;
  try { wv.stop(); } catch {}
  let webContentsId = 0;
  try { webContentsId = Number(wv.getWebContentsId?.()) || 0; } catch {}
  if (webContentsId && typeof mc !== 'undefined' && typeof mc.destroyWebview === 'function') {
    mc.destroyWebview(webContentsId).catch(() => {});
  }
  try { wv.removeAttribute('src'); } catch {}
  try { wv.remove(); } catch {}
}

const AI = {
  cfg: null,
  msgs: [],
  lastPageHtml: '',
  _greeted: false,
  _wv: null,
  _labMode: false,
  // Chat session persistence
  _sessionId: null,
  _sessionName: 'Nueva sesión',
  _sessions: [],
  _saveTimer: null,
  _currentProjectUrl: '',
  _attachedImages: [],

  init() {
    console.log('[AI] init started');
    if (typeof mc === 'undefined' || !mc) {
      console.error('[AI] mc no disponible — preload no ejecutado');
      return;
    }
    this.injectPanel();
    console.log('[AI] panel injected');
    this.loadConfig();
    this.initSessions();
    mc.on('ai:debug', data => {
      console.log('[AI-DBG]', data);
      addSidebarLog('info', '[AI-CFG] ' + (data.type === 'save' ? 'Guardada' : 'Cargada') + ': ' + JSON.stringify(data.cfg).slice(0, 300));
    });
    mc.on('ai:dl:log', msg => addSidebarLog('info', '[AI] ' + msg));
    mc.on('ai:dl:done', info => {
      addSidebarLog('info', `[AI] ✓ ${info.name} (${info.size} MB)`);
      this.appendMsg('system', `✓ Descargado: ${info.name} (${info.size} MB)`);
    });
    mc.on('ai:exec:log', msg => addSidebarLog('info', '[TERM] ' + msg));
    // Init lab mode toggle style (refleja el estado real, no forzar activo)
    setTimeout(() => {
      const btn = document.getElementById('ai-lab-toggle');
      if (btn) {
        btn.style.borderColor = this._labMode ? 'var(--accent)' : 'var(--border)';
        btn.style.background = this._labMode ? 'var(--accent)' : 'transparent';
        btn.style.color = this._labMode ? '#000' : 'var(--text)';
        btn.title = this._labMode ? 'Modo Lab: activo (código → laboratorio)' : 'Modo Lab: inactivo (código → chat)';
      }
    }, 500);
  },

  async loadConfig() {
    try {
      this.cfg = await Promise.race([
        mc.aiConfigGet(),
        new Promise(r => setTimeout(() => r(null), 3000))
      ]);
    } catch { this.cfg = null; }
    // Fallback a localStorage si IPC no devolvió datos
    if (!this.cfg || !this.cfg.provider) {
      try {
        const saved = localStorage.getItem('mc_ai_cfg');
        if (saved) { this.cfg = JSON.parse(saved); addSidebarLog('info', '[AI-CFG] Cargada desde localStorage'); }
        else addSidebarLog('info', '[AI-CFG] Sin configuración previa');
      } catch {}
    } else {
      addSidebarLog('info', '[AI-CFG] Cargada cfg.json + localStorage backup disponible');
    }
    // Sincronizar localStorage con lo que vino del IPC (por si IPC no persiste)
    if (this.cfg && this.cfg.provider) {
      try { localStorage.setItem('mc_ai_cfg', JSON.stringify(this.cfg)); } catch {}
    }
    if (this.cfg) this.renderCfg();
  },

  injectPanel() {
    if (document.getElementById('ai-sidebar')) return;

    const sb = document.createElement('div');
    sb.id = 'ai-sidebar';
    sb.innerHTML = `
      <div id="ai-bg"></div>

      <div class="ai-header">
        <div class="ai-title-wrapper">
          <span class="ai-sparkle">✦</span>
          <h2>MC-AI</h2>
        </div>
        <button id="ai-sb-close" class="close-sidebar-btn" onclick="AI.close()" title="Cerrar panel">&times;</button>
      </div>

      <!-- Tabs -->
      <div class="ai-tabs">
        <button class="ai-tab active" data-aitab="chat" onclick="AI.switchTab('chat')">💬 Chat</button>
        <button class="ai-tab" data-aitab="memory" onclick="AI.switchTab('memory')">📖 Memoria</button>
        <button class="ai-tab" data-aitab="reminders" onclick="AI.switchTab('reminders')">⏰ Pendientes</button>
      </div>

      <!-- Tab: Chat -->
      <div class="ai-tab-content active" id="ai-tab-chat">
        <details id="ai-sb-cfg">
          <summary>⚙ Configuración</summary>
        <div id="ai-cfg-body">
          <div class="input-row">
            <span class="input-label">Proveedor</span>
            <select id="ai-prov" onchange="AI.onProvChange()" class="sel-input" style="flex:1;">
              <optgroup label="⚡ API">
                <option value="ollama">Ollama (local)</option>
                <option value="gemini">Gemini API</option>
                <option value="groq">Groq (gratis)</option>
                <option value="openai">OpenAI</option>
                <option value="opencode">OpenCode Zen</option>
              </optgroup>
              <optgroup label="🌐 Web">
                <option value="copilot">Copilot Web</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="claude">Claude</option>
                <option value="gemini-web">Gemini</option>
                <option value="deepseek">DeepSeek</option>
                <option value="perplexity">Perplexity</option>
              </optgroup>
            </select>
          </div>

          <div id="ai-ollama" class="ai-prov-cfg">
            <div class="input-row"><span class="input-label">Servidor</span><input id="ol-url" class="text-input" type="text" placeholder="http://localhost:11434" style="flex:1;"></div>
            <div class="input-row"><span class="input-label">Modelo</span><input id="ol-model" class="text-input" type="text" placeholder="phi3:mini" style="flex:1;"></div>
          </div>

          <div id="ai-gemini" class="ai-prov-cfg" style="display:none">
            <div class="input-row"><span class="input-label">API Key</span><input id="gm-key" class="text-input" type="password" placeholder="AIza..." style="flex:1;"><a href="https://aistudio.google.com/apikey" class="ai-key-link" title="Obtener key en Google AI Studio">🔑 Obtener</a></div>
            <div class="input-row"><span class="input-label">Modelo</span><input id="gm-model" class="text-input" type="text" placeholder="gemini-2.5-flash" style="flex:1;"></div>
          </div>

          <div id="ai-groq" class="ai-prov-cfg" style="display:none">
            <div class="input-row"><span class="input-label">API Key</span><input id="gq-key" class="text-input" type="password" placeholder="gsk_..." style="flex:1;"><a href="https://console.groq.com/keys" class="ai-key-link" title="Obtener key en Groq Console">🔑 Obtener</a></div>
            <div class="input-row"><span class="input-label">Modelo</span><input id="gq-model" class="text-input" type="text" placeholder="llama-3.1-8b-instant" style="flex:1;"></div>
          </div>

          <div id="ai-openai" class="ai-prov-cfg" style="display:none">
            <div class="input-row"><span class="input-label">API Key</span><input id="oa-key" class="text-input" type="password" placeholder="sk-..." style="flex:1;"><a href="https://platform.openai.com/api-keys" class="ai-key-link" title="Obtener key en OpenAI Platform">🔑 Obtener</a></div>
            <div class="input-row"><span class="input-label">Modelo</span><input id="oa-model" class="text-input" type="text" placeholder="gpt-4o-mini" style="flex:1;"></div>
          </div>

          <div id="ai-opencode" class="ai-prov-cfg" style="display:none">
            <div class="input-row"><span class="input-label">API Key</span><input id="oc-key" class="text-input" type="password" placeholder="sk-..." style="flex:1;"><a href="https://opencode.ai" class="ai-key-link" title="Obtener key en OpenCode Zen">🔑 Obtener</a></div>
            <div class="input-row"><span class="input-label">Modelo</span><input id="oc-model" class="text-input" type="text" placeholder="big-pickle" style="flex:1;"></div>
          </div>

          <div id="ai-models-footer" style="display:none;margin-top:6px;">
            <details>
              <summary style="font-size:10px;color:var(--muted2);cursor:pointer;user-select:none;">📦 Modelos disponibles</summary>
              <div id="ai-models-list" style="font-size:10px;max-height:150px;overflow-y:auto;margin-top:4px;padding:4px 0;scrollbar-width:thin;color:var(--muted);"></div>
            </details>
          </div>

          <button class="btn btn-sm" onclick="AI.saveCfg()" style="margin-top:2px;">Guardar</button>
          <button class="btn btn-sm ghost" onclick="AI.debugCfg()" style="font-size:9px;margin-left:4px;" title="Ver configuración actual">🔍</button>

          <div style="border-top:1px solid rgba(255,255,255,0.04);padding-top:8px;margin-top:6px;">
            <div style="font-size:10px;color:#9ca3af;margin-bottom:6px;">🎨 Fondo del chat</div>
            <div class="input-row">
              <input type="file" id="ai-bg-file" accept="image/*" style="flex:1;color:var(--muted);font-size:11px;" onchange="AI.handleBgFile(event)">
              <button class="btn btn-sm ghost" onclick="AI.clearBg()" style="font-size:10px;">✕</button>
            </div>
            <div class="input-row" style="gap:4px;">
              <input class="text-input" id="ai-bg-url" placeholder="URL de imagen" style="flex:1;font-size:11px;" onkeydown="if(event.key==='Enter')AI.applyBgUrl()">
              <button class="btn btn-sm ghost" onclick="AI.applyBgUrl()" style="font-size:10px;">OK</button>
            </div>
            <div style="text-align:right;font-size:9px;margin-top:2px;"><span onclick="AI.saveBgDefault()" style="cursor:pointer;color:#9ca3af;">♡ Guardar por defecto</span></div>
          </div>
        </div>
      </details>

      <div id="ai-session-bar" style="display:flex;align-items:center;gap:4px;padding:4px 8px;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.06);font-size:11px;">
        <span id="ai-session-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent);cursor:pointer;" onclick="AI.renameSessionPrompt()" title="Clic para renombrar">Nueva sesión</span>
        <button class="btn btn-sm ghost" onclick="AI.newSession()" title="Nueva sesión" style="font-size:13px;padding:2px 5px;">＋</button>
        <button class="btn btn-sm ghost" onclick="AI.toggleSessionList()" title="Sesiones anteriores" style="font-size:13px;padding:2px 5px;">📋</button>
        <button class="btn btn-sm ghost" onclick="AI.deleteSessionPrompt()" title="Eliminar sesión" style="font-size:11px;padding:2px 5px;">🗑</button>
      </div>
      <div id="ai-session-list" style="display:none;max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.3);border-bottom:1px solid rgba(255,255,255,0.06);scrollbar-width:thin;"></div>

      <div id="ai-msgs" class="chat-container"></div>

      <div id="ai-quick" class="quick-actions">
        <!-- Quick actions se generan dinámicamente según la página -->
      </div>

      <div class="ai-mode-pills" style="display:flex;gap:3px;padding:6px 12px 0;border-top:1px solid var(--border);">
        <button class="ai-mode-pill active" data-mode="casual" title="Conversación natural">💬</button>
        <button class="ai-mode-pill" data-mode="coder" title="Programador web pro">💻</button>
        <button class="ai-mode-pill" data-mode="gamedev" title="Game developer">🎮</button>
        <button class="ai-mode-pill" data-mode="private" title="Máxima privacidad">🔒</button>
        <button class="ai-mode-pill" data-mode="supervised" title="Requiere confirmación">🛡</button>
      </div>
      <div class="input-container" style="flex-wrap:wrap;">
          <div id="ai-attach-preview" class="attach-preview" style="display:none;flex-basis:100%;"></div>
          <textarea id="ai-inp" rows="1"
            placeholder="Pregúntale a MC-AI... (Enter para enviar, Shift+Enter para nueva línea)"
            onkeydown="AI.onKey(event)" onpaste="AI.onPaste(event)"></textarea>
        <button id="ai-attach" class="attach-btn" onclick="AI.attachImages()" title="Adjuntar imágenes">📎</button>
        <button id="ai-send" class="send-btn" onclick="AI.send()" disabled>↑</button>
        <input type="file" id="ai-file" accept="image/*" multiple style="display:none" onchange="AI.onFileSelected(event)">
      </div>
      </div><!-- fin ai-tab-chat -->

      <!-- Tab: Memoria -->
      <div class="ai-tab-content" id="ai-tab-memory">
        <div class="ai-memory-panel">
          <div class="ai-memory-search">
            <input id="ai-memory-search-input" type="text" class="text-input" placeholder="🔍 Buscar en memoria..." oninput="AI.onMemorySearch(this.value)" />
          </div>
          <div class="ai-section-title">Recientes</div>
          <div id="ai-recent-memory" class="ai-memory-list"></div>
          <div class="ai-section-title" id="ai-mem-search-title" style="display:none;">Resultados</div>
          <div id="ai-memory-results" class="ai-memory-list"></div>
        </div>
      </div>

      <!-- Tab: Recordatorios -->
      <div class="ai-tab-content" id="ai-tab-reminders">
        <div class="ai-reminders-panel">
          <div class="ai-reminders-header">
            <span>Pendientes</span>
            <button class="btn btn-sm" onclick="AI.addReminder()">+ Nuevo</button>
          </div>
          <div id="ai-reminders-list" class="ai-reminders-list"></div>
        </div>
      </div>

      <!-- Consent dialog (para modo supervisado) -->
      <div class="ai-consent-dialog" id="ai-consent-dialog" style="display:none;">
        <div class="ai-consent-body">
          <span style="font-size:20px;">🛡</span>
          <p id="ai-consent-msg">¿Querés autorizar esta acción?</p>
          <div class="ai-consent-actions">
            <button class="btn btn-sm" onclick="AI.consentResponse(true)">Autorizar</button>
            <button class="btn btn-sm ghost" onclick="AI.consentResponse(false)">Cancelar</button>
          </div>
        </div>
      </div>
    `;
    const main = document.getElementById('main');
    if (main) main.appendChild(sb); else document.body.appendChild(sb);
    PanelResize.attach(sb, 'mc-panel-w-ai', 400);

    const cfgEl = document.getElementById('ai-sb-cfg');
    const msgsEl = document.getElementById('ai-msgs');

    const inp = document.getElementById('ai-inp');
    const send = document.getElementById('ai-send');
    if (inp && send) {
      inp.addEventListener('input', () => this.updateSendState());
    }

    const modelsFooter = document.getElementById('ai-models-footer');
    const modelsList = document.getElementById('ai-models-list');
    if (modelsFooter && modelsList) {
      const details = modelsFooter.querySelector('details');
      if (details) {
        details.addEventListener('toggle', async () => {
          if (!details.open) return;
          modelsList.textContent = 'Cargando…';
          const eff = this.getEffectiveCfg();
          const res = await mc.aiModels(eff);
          if (res.error) { modelsList.textContent = 'Error: ' + res.error; return; }
          if (!res.models?.length) {
            const hints = {
              ollama: 'Instalá modelos con: ollama pull llama3.2',
              groq: '¿API key válida? Obtenela en https://groq.com',
              openai: '¿API key válida? Verificá en https://platform.openai.com',
              gemini: '¿API key válida? Obtenela en https://aistudio.google.com',
              opencode: '¿API key válida? Registrate en https://opencode.ai'
            };
            const prov = document.getElementById('ai-prov')?.value;
            modelsList.textContent = 'Sin modelos disponibles. ' + (hints[prov] || '');
            return;
          }
          modelsList.innerHTML = res.models.map(m => {
            const id = m.id || m;
            const owner = m.owned_by ? ` <span style="color:var(--muted2);font-size:8px;">(${m.owned_by})</span>` : '';
            const modelInputId = window.__aiProvModelId();
            return `<div style="padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;display:flex;align-items:center;gap:4px;" onclick="document.getElementById('${modelInputId}').value='${id.replace(/'/g,"\\'")}';document.querySelector('#ai-sb-cfg details[open]')?.removeAttribute('open');">
              <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${id}</span>${owner}
              <span style="font-size:8px;color:var(--accent);opacity:0.7;">✓</span>
            </div>`;
          }).join('');
        });
      }
    }

    window.__aiProvModelId = function() {
      const p = document.getElementById('ai-prov')?.value;
      if (p === 'ollama') return 'ol-model';
      if (p === 'gemini') return 'gm-model';
      if (p === 'groq') return 'gq-model';
      if (p === 'openai') return 'oa-model';
      if (p === 'opencode') return 'oc-model';
      return 'ol-model';
    };

    this.loadBg();
    this.initModePills();
    this.refreshMemory();
    this.refreshReminders();
    // Burbuja "✦ Preguntar a la IA" sobre texto seleccionado: OCULTA por
    // ahora (funcionalidad futura). El código de initTextSelection() se
    // mantiene; para reactivarla, descomentar la línea.
    // this.initTextSelection();

    // Abrir links de API keys en una pestaña interna del navegador
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.ai-key-link');
      if (link) {
        e.preventDefault();
        const url = link.getAttribute('href');
        if (url && typeof addTab === 'function') addTab(url);
      }
    });
  },

  toggle() {
    const sb = document.getElementById('ai-sidebar');
    if (!sb) return;
    const open = !sb.classList.contains('open');
    sb.classList.toggle('open');
    document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
    if (open) {
      // cerrar webchat si está abierto
      const wc = document.getElementById('webchat-sidebar');
      if (wc) wc.classList.remove('open');
      const wcBtn = document.getElementById('chat-toggle-web');
      if (wcBtn) { wcBtn.className = 'chat-toggle closed'; wcBtn.innerHTML = '&#9664;'; wcBtn.title = 'Abrir WebChat'; }
      // cerrar WhatsApp si está abierto
      const wa = document.getElementById('wa-sidebar');
      if (wa) wa.classList.remove('open');
      const waBtn = document.getElementById('chat-toggle-wa');
      if (waBtn) { waBtn.className = 'chat-toggle closed'; waBtn.innerHTML = '&#9664;'; waBtn.title = 'Abrir WhatsApp (Ctrl+Shift+Q)'; }
      const btn = document.querySelector('[data-panel="ai"]');
      if (btn) btn.classList.add('active');
      // Si la URL cambió, recargar sesión vinculada
      const newUrl = this._getProjectUrl();
      if (newUrl !== this._currentProjectUrl) {
        this._currentProjectUrl = newUrl;
        this.initSessions();
      }
      // si el proveedor es web, asegurar webview visible
      const prov = document.getElementById('ai-prov')?.value;
      if (prov && WEB_PROVIDERS[prov]) this.showWebview(prov);
      if (!this._greeted) {
        this._greeted = true;
        this.appendMsg('assistant', '¡Hola! Soy el asistente de MC-Browser.\n\n¿Qué haremos hoy? ¿Navegar, descargar algo?\n¿O tal vez... tratar de conquistar el mundo? 🌍');
      }
      this.updateQuickActions();
      setTimeout(() => document.getElementById('ai-inp')?.focus(), 300);
    } else {
      this.close();
      return;
    }
    // sync edge toggle
    const btn = document.getElementById('chat-toggle-ai');
    if (btn) {
      btn.className = 'chat-toggle ' + (open ? 'open' : 'closed');
      btn.innerHTML = open ? '&#9654;' : '&#9664;';
      btn.title = open ? 'Cerrar' : 'Abrir IA (Ctrl+Shift+A)';
    }
  },

  close() {
    const sb = document.getElementById('ai-sidebar');
    if (!sb) return;
    sb.classList.remove('open');
    PanelResize.reset(sb, 'mc-panel-w-ai', 400);
    try { mc.aiChatAbort(); } catch {}
    destroyEmbeddedWebview(document.getElementById('ai-wv'));
    this._wv = null;
    const btn = document.getElementById('chat-toggle-ai');
    if (btn) { btn.className = 'chat-toggle closed'; btn.innerHTML = '&#9664;'; btn.title = 'Abrir IA (Ctrl+Shift+A)'; }
  },

  renderCfg() {
    if (!this.cfg) return;
    const s = v => document.getElementById(v);
    const prov = this.cfg.provider || 'opencode';
    s('ai-prov').value = prov;
    // Siempre rellenar TODOS los campos aunque el proveedor guardado sea web
    s('ol-url').value = this.cfg.ollamaUrl || 'http://localhost:11434';
    s('ol-model').value = this.cfg.ollamaModel || 'phi3:mini';
    s('gm-key').value = this.cfg.geminiKey || '';
    s('gm-model').value = this.cfg.geminiModel || 'gemini-2.5-flash';
    s('gq-key').value = this.cfg.groqKey || '';
    s('gq-model').value = this.cfg.groqModel || 'llama-3.1-8b-instant';
    s('oa-key').value = this.cfg.openaiKey || '';
    s('oa-model').value = this.cfg.openaiModel || 'gpt-4o-mini';
    s('oc-key').value = this.cfg.opencodeKey || '';
    s('oc-model').value = this.cfg.opencodeModel || 'big-pickle';
    this.onProvChange();
  },

  onProvChange() {
    const p = document.getElementById('ai-prov')?.value;
    if (!p) return;
    document.querySelectorAll('.ai-prov-cfg').forEach(el => el.style.display = 'none');
    const isWeb = !!WEB_PROVIDERS[p];
    const isApi = !isWeb && ['ollama','gemini','groq','openai','opencode'].includes(p);
    const chatArea = document.getElementById('ai-msgs');
    const quickArea = document.getElementById('ai-quick');
    const inputArea = document.querySelector('#ai-sidebar .input-container');
    const modelsFooter = document.getElementById('ai-models-footer');
    if (modelsFooter) {
      modelsFooter.style.display = isApi ? '' : 'none';
      // Reset model list when switching providers
      const details = modelsFooter.querySelector('details');
      if (details) details.open = false;
      const list = document.getElementById('ai-models-list');
      if (list) list.textContent = 'Abrir para cargar modelos…';
    }
    // toggle webview vs chat UI
    if (isWeb) {
      if (chatArea) chatArea.style.display = 'none';
      if (quickArea) quickArea.style.display = 'none';
      if (inputArea) inputArea.style.display = 'none';
      this.showWebview(p);
    } else {
      if (chatArea) chatArea.style.display = '';
      if (quickArea) quickArea.style.display = '';
      if (inputArea) inputArea.style.display = '';
      this.hideWebview();
      const el = document.getElementById('ai-' + p);
      if (el) el.style.display = 'block';
    }
  },

  showWebview(key) {
    const info = WEB_PROVIDERS[key];
    if (!info) return;
    let wv = document.getElementById('ai-wv');
    if (!wv) {
      wv = document.createElement('webview');
      wv.id = 'ai-wv';
      wv.style.cssText = 'flex:0;border:none;height:0;min-height:0;';
      wv.setAttribute('partition', 'persist:mc');
      wv.setAttribute('allow', 'autoplay; media; encrypted-media; clipboard-read; clipboard-write');
      wv.setAttribute('webpreferences', 'contextIsolation=yes');
      const msgsEl = document.getElementById('ai-msgs');
      if (msgsEl && msgsEl.parentNode) msgsEl.parentNode.insertBefore(wv, msgsEl);
      else document.getElementById('ai-sidebar')?.appendChild(wv);
      wv.addEventListener('did-navigate', () => {
        const ctx = AI.getTabContextJSON();
        if (ctx) wv.executeJavaScript(`
          var el=document.getElementById('__mc-ctx-data');
          if(!el){el=document.createElement('div');el.id='__mc-ctx-data';el.style.display='none';document.body.appendChild(el)}
          el.textContent=${JSON.stringify(ctx)};el.dataset.context=${JSON.stringify(ctx)};
        `).catch(() => {});
      });
      wv.addEventListener('permissionrequest', (e) => {
        const permission = e?.permission || e?.request?.permission;
        if (permission === 'clipboard-read' || permission === 'clipboard-write') {
          try { e.request?.allow?.(); } catch {}
        }
      });
      wv.addEventListener('did-fail-load', e => {
        console.error('[AI-WV] fail load:', e.errorDescription, e.errorCode);
      });
    }
    console.log('[AI] showWebview', key, !!wv);
    if (!wv) return;
    const targetUrl = info.url;
    let currentUrl = '';
    try { currentUrl = wv.getURL() || ''; } catch {}
    const targetHost = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
    const currentHost = (() => { try { return new URL(currentUrl).hostname; } catch { return ''; } })();
    console.log('[AI] currentUrl:', currentUrl);
    if (!currentUrl || currentUrl === 'about:blank' || currentHost !== targetHost) {
      console.log('[AI] loading URL', targetUrl);
      try { wv.loadURL(targetUrl); } catch { wv.setAttribute('src', targetUrl); }
    }
    wv.style.flex = '1';
    wv.style.height = '';
    console.log('[AI] webview flex set to 1');
    // debug: check computed style
    setTimeout(() => {
      const cs = getComputedStyle(wv);
      console.log('[AI] wv computed:', { flex: cs.flex, height: cs.height, display: cs.display });
    }, 500);
    this._wv = key;
  },

  hideWebview() {
    const wv = document.getElementById('ai-wv');
    if (wv) { wv.style.flex = '0'; wv.style.height = '0'; }
    this._wv = null;
  },

  getTabContextJSON() {
    try {
      const tabs = typeof window.__mcGetTabs === 'function' ? window.__mcGetTabs() : [];
      const activeId = typeof window.__mcGetActiveTabId === 'function' ? window.__mcGetActiveTabId() : null;
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        totalTabs: tabs.length,
        activeTabId: activeId,
        tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === activeId }))
      });
    } catch { return null; }
  },

  // Devuelve la config efectiva según lo seleccionado en el formulario (sin guardar)
  getEffectiveCfg() {
    const s = v => document.getElementById(v)?.value?.trim() || '';
    const prov = s('ai-prov');
    const cfg = { provider: prov };
    if (prov === 'ollama') { cfg.url = s('ol-url') || 'http://localhost:11434'; cfg.model = s('ol-model') || 'phi3:mini'; }
    else if (prov === 'gemini') { cfg.key = s('gm-key'); cfg.model = s('gm-model') || 'gemini-2.5-flash'; }
    else if (prov === 'groq') { cfg.key = s('gq-key'); cfg.model = s('gq-model') || 'llama-3.1-8b-instant'; }
    else if (prov === 'openai') { cfg.key = s('oa-key'); cfg.model = s('oa-model') || 'gpt-4o-mini'; }
    else if (prov === 'opencode') { cfg.key = s('oc-key'); cfg.model = s('oc-model') || 'big-pickle'; }
    return cfg;
  },

  async saveCfg() {
    try {
      const s = v => document.getElementById(v)?.value?.trim() || '';
      const prov = s('ai-prov');
      const isWeb = !!WEB_PROVIDERS[prov];
      this.cfg = await mc.aiConfigSave(isWeb ? {
        provider: prov,
      } : {
        provider: prov,
        ollamaUrl: s('ol-url') || 'http://localhost:11434',
        ollamaModel: s('ol-model') || 'phi3:mini',
        geminiKey: s('gm-key'),
        geminiModel: s('gm-model') || 'gemini-2.5-flash',
        groqKey: s('gq-key'),
        groqModel: s('gq-model') || 'llama-3.1-8b-instant',
        openaiKey: s('oa-key'),
        openaiModel: s('oa-model') || 'gpt-4o-mini',
        opencodeKey: s('oc-key'),
        opencodeModel: s('oc-model') || 'big-pickle'
      });
      addSidebarLog('info', '[AI] Configuración guardada');
      // Backup en localStorage (sin keys sensibles)
      try {
        const safe = { ...this.cfg, opencodeKey: '', groqKey: '', openaiKey: '', geminiKey: '' };
        localStorage.setItem('mc_ai_cfg', JSON.stringify(safe));
      } catch {}
      const det = document.getElementById('ai-sb-cfg');
      if (det) det.removeAttribute('open');
    } catch (err) {
      console.error('[AI] saveCfg error:', err.message);
      addSidebarLog('error', '[AI] Error al guardar: ' + err.message);
    }
  },

  async debugCfg() {
    try {
      const raw = await mc.aiConfigGet();
      const safe = { ...raw, opencodeKey: raw?.opencodeKey ? '***' : '', groqKey: raw?.groqKey ? '***' : '', openaiKey: raw?.openaiKey ? '***' : '', geminiKey: raw?.geminiKey ? '***' : '' };
      addSidebarLog('info', '[AI-CFG] Config actual: ' + JSON.stringify(safe, null, 2).slice(0, 500));
    } catch (e) {
      addSidebarLog('error', '[AI-CFG] Error al leer config: ' + e.message);
    }
  },

  onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    if (e.key === 'Escape') { this.close(); }
  },

  async send(text) {
    if (typeof mc === 'undefined' || !mc) {
      this.appendMsg('system', '⚠️ mc no disponible — recargá la página (Ctrl+R)');
      return;
    }
    // Detener cualquier cadena anterior
    this._stopFlag = true;
    this._generation++;
    try { mc.aiChatAbort(); } catch {}
    await new Promise(r => setTimeout(r, 30));
    this._stopFlag = false;
    const inp = document.getElementById('ai-inp');
    if (!text) { text = inp?.value?.trim() || ''; }
    const imgs = this._attachedImages || [];
    if (!text && !imgs.length) return;
    if (inp) inp.value = '';
    this.setBtnMode('stop');
    // Contenido multimodal: texto + imágenes adjuntas (formato OpenAI)
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const img of imgs) content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    if (content.length === 1 && content[0].type === 'image_url') {
      content.unshift({ type: 'text', text: 'Analizá esta imagen' });
    }
    const userContent = content.length === 1 && content[0].type === 'text' ? content[0].text : content;
    // Recordatorio de modo pendiente (ver initModePills): va pegado al mensaje
    // real que recibe la API, no a lo que se muestra en pantalla — así el
    // modelo lo lee con máxima recencia sin ensuciar el chat visible.
    let apiContent = userContent;
    if (this._pendingModeNote) {
      const note = this._pendingModeNote;
      this._pendingModeNote = null;
      apiContent = Array.isArray(userContent)
        ? [{ type: 'text', text: note }, ...userContent]
        : `${note}\n\n${userContent}`;
    }
    this.msgs.push({ role: 'user', content: apiContent });
    this.appendMsg('user', userContent);
    this.clearAttachedImages();
    this.scheduleAutoSave();
    try {
      await this.continueChat(text);
    } catch (err) {
      console.error('[AI-SEND]', err);
      this.appendMsg('system', `Error: ${err.message}`);
    } finally {
      this.setBtnMode('send');
    }
  },

  // === Adjuntar / pegar imágenes ===
  attachImages() {
    const file = document.getElementById('ai-file');
    if (file) file.click();
  },

  onFileSelected(e) {
    const files = e.target?.files || [];
    for (const f of files) this.addAttachedImage(f);
    if (e.target) e.target.value = '';
  },

  onPaste(e) {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { this.addAttachedImage(file); e.preventDefault(); }
      }
    }
  },

  addAttachedImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      this._attachedImages = this._attachedImages || [];
      this._attachedImages.push({ name: file.name || 'imagen', mime: file.type, dataUrl: reader.result });
      this.renderAttachPreview();
      this.updateSendState();
    };
    reader.readAsDataURL(file);
  },

  removeAttachedImage(index) {
    this._attachedImages = this._attachedImages || [];
    this._attachedImages.splice(index, 1);
    this.renderAttachPreview();
    this.updateSendState();
  },

  clearAttachedImages() {
    this._attachedImages = [];
    this.renderAttachPreview();
    this.updateSendState();
  },

  renderAttachPreview() {
    const wrap = document.getElementById('ai-attach-preview');
    if (!wrap) return;
    const imgs = this._attachedImages || [];
    wrap.innerHTML = '';
    if (!imgs.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    imgs.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'attach-thumb';
      const pic = document.createElement('img');
      pic.src = img.dataUrl;
      pic.alt = img.name;
      const rm = document.createElement('button');
      rm.className = 'attach-remove';
      rm.textContent = '✕';
      rm.title = 'Quitar imagen';
      rm.onclick = () => this.removeAttachedImage(i);
      thumb.appendChild(pic);
      thumb.appendChild(rm);
      wrap.appendChild(thumb);
    });
  },

  updateSendState() {
    const btn = document.getElementById('ai-send');
    if (!btn) return;
    if (btn.dataset.mode === 'stop') return;
    const inp = document.getElementById('ai-inp');
    const hasText = inp?.value?.trim();
    const hasImgs = (this._attachedImages || []).length > 0;
    btn.disabled = !hasText && !hasImgs;
  },

  openMediaFull(src) {
    const overlay = document.createElement('div');
    overlay.className = 'ai-media-overlay';
    overlay.onclick = () => overlay.remove();
    const fullImg = document.createElement('img');
    fullImg.src = src;
    fullImg.className = 'ai-media-full';
    overlay.appendChild(fullImg);
    document.body.appendChild(overlay);
  },

  setBtnMode(mode) {
    const btn = document.getElementById('ai-send');
    if (!btn) return;
    btn.dataset.mode = mode;
    if (mode === 'stop') {
      btn.textContent = '■';
      btn.style.background = 'var(--danger)';
      btn.style.color = '#fff';
      btn.disabled = false;
      btn.onclick = (e) => { e.stopPropagation(); this.stop(); };
    } else {
      btn.textContent = '↑';
      btn.style.background = '';
      btn.style.color = '';
      btn.onclick = () => this.send();
      this.updateSendState();
    }
  },

  stop() {
    this._stopFlag = true;
    this.setBtnMode('send');
    try { mc.aiChatAbort(); } catch {}
    document.querySelectorAll('#ai-msgs .thinking').forEach(el => el.remove());
  },

  async continueChat(lastText = '', depth = 0) {
    // Si ya hubo un send() nuevo, abortar esta cadena obsoleta
    if (this._stopFlag) { this.setBtnMode('send'); return; }
    if (depth > 5) { this.setBtnMode('send'); this.appendMsg('system', '⏹ Máximo de iteraciones'); return; }
    const myGen = this._generation;  // Capturar generación actual
    const thinkEl = this.appendMsg('thinking', 'Pensando…');

    const t = lastText || '';
    // Detectar cambio de contexto: si el usuario cambió de tema, limpiar historial anterior
    const isSwitch = depth === 0 && t && this._isContextSwitch(t);
    if (isSwitch && this.msgs.length > 2) {
      // Mantener solo los últimos 2 mensajes (el cambio de tema actual) y descartar tarea anterior
      this.msgs = this.msgs.slice(-2);
      this.appendMsg('system', '🔄 Tema cambiado — empezando fresh');
    }
    if (depth === 0) this._lastUserMsg = t;

    let ctx = '';
    try {
      // Pestañas abiertas
      const allTabs = typeof window.__mcGetTabs === 'function' ? window.__mcGetTabs() : [];
      if (allTabs.length) {
        ctx += `\n## PESTAÑAS ABIERTAS (${allTabs.length})\n`;
        for (const tab of allTabs) {
          const marker = tab.id === (typeof window.__mcGetActiveTabId === 'function' ? window.__mcGetActiveTabId() : null) ? ' ← ACTIVA' : '';
          ctx += `  [ID ${tab.id}] ${tab.title} — ${tab.url}${marker}\n`;
        }
      }
      // Código actual del laboratorio (para que el AI pueda modificarlo)
      const labCode = document.getElementById('lab-code')?.value;
      if (labCode && labCode.trim()) {
        const bt = '`';
        ctx += '\n## CÓDIGO ACTUAL DEL LABORATORIO (edita y reemplaza con ' + bt + bt + bt + 'lab:code cuando el usuario pida cambios):\n' + bt + bt + bt + 'html\n' + labCode.slice(0, 30000) + '\n' + bt + bt + bt;
      }
      // Logs de consola del lab (errores, warnings, output)
      if (typeof labGetConsoleLogs === 'function') {
        const logs = labGetConsoleLogs();
        if (logs.length) {
          ctx += '\n## LOGS DEL LABORATORIO (últimos ' + logs.length + ' mensajes):\n';
          for (const log of logs) {
            const icon = log.type === 'error' ? '❌' : log.type === 'warn' ? '⚠️' : '📝';
            ctx += icon + ' [' + log.type + '] ' + log.text.slice(0, 300) + '\n';
          }
        }
      }
      const tabUrl = document.getElementById('urlinput')?.value;
      if (tabUrl && tabUrl !== 'mc://newtab') {
        ctx += `\nURL activa navegador: ${tabUrl}`;
        const wantsDetail = !t || t.length < 3 ||
          /página|pagina|web|url|html|site|analiza|busca|extrae|stream|video|descarga|metadata|source|src|link|player|embed|iframe/i.test(t);
        if (wantsDetail) {
          const wv = document.querySelector('.tab-webview.active');
          if (wv?.getWebContentsId) {
            const res = await mc.aiPageDom({ webContentsId: wv.getWebContentsId() });
            if (res?.html) {
              ctx += `\nHTML: ${res.html.slice(0, 30000)}`;
              this.lastPageHtml = res.html;
              
              try {
                await mc.aiAutoScrape({ url: tabUrl, html: res.html });
              } catch (e) { /* Error silencioso en background */ }
            }
          }
        }
      }
    } catch {}

    const system = `Eres MC-AI, un asistente IA integrado en MC Browser.

## MODO ACTIVO: ${this.activeMode}
## MODO LABORATORIO: ${this._labMode ? 'ACTIVO' : 'INACTIVO'}
${this._labMode ? '' : 'IMPORTANTE: El modo laboratorio está INACTIVO. NO uses el bloque lab:code. Mostrá el código HTML/CSS/JS directamente en el chat.'}
${this.activeMode === 'casual' ? 'Modo conversación natural. Respondé como un amigo inteligente: claro, directo, sin vueltas. Explicá cosas fáciles de entender. Usá emojis con moderación. No uses jerga técnica innecesaria.' : ''}${this.activeMode === 'coder' ? 'Modo PROGRAMADOR WEB PROFESIONAL. Respondé como un senior dev: preciso, técnico, con arquitectura clara. ' + (this._labMode ? 'Siempre usá lab:code para código web.' : 'El laboratorio está INACTIVO: mostrá el código web en bloques regulares del chat.') + ' Hablá de patrones, rendimiento, escalabilidad. Mostrá opciones (pero siempre la mejor). No expliques lo obvio — pasá al código directo.' : ''}${this.activeMode === 'gamedev' ? 'Modo GAME DEVELOPER. Especialista en juegos 2D (Canvas) y 3D (Three.js). ' + (this._labMode ? 'Cuando el usuario pida un juego, generá TODO el código completo en lab:code.' : 'El laboratorio está INACTIVO: generá el código del juego en bloques regulares del chat.') + ' Conocés game loops, colisiones, shaders, física, audio, input handling, UI de juegos. Sé entusiasta y técnico.' : ''}${this.activeMode === 'private' ? 'Modo PRIVADO. Máxima protección de datos. NO guardes NADA en memoria. NO guardes bookmarks, análisis, ni datos del usuario. Respondé normal pero sin persistir nada.' : ''}${this.activeMode === 'supervised' ? 'Modo SUPERVISADO. Todas las acciones técnicas (cmd, script, fetch, scraping) requieren confirmación del usuario antes de ejecutarse. Explicá qué vas a hacer ANTES de hacerlo. Pedí permiso.' : ''}

## MONITOREO DEL LABORATORIO
Tenés acceso a los logs de consola del laboratorio (en el contexto "LOGS DEL LABORATORIO"). Si hay errores (❌), UNDÍZALOS y ofrecé soluciones. Si el usuario dice "no funciona" o "tiene errores", revisá los logs primero. Los logs incluyen console.log, console.error, console.warn y errores de runtime.

## REGLAS CRÍTICAS

**CAMBIO DE CONTEXTO:** Si el usuario claramente cambió de tema (dice "otra cosa", "en vez de eso", "ahora quiero...", o pide algo completamente diferente), OLVIDÁ la tarea anterior. No la continúes, no la menciones. Empezá limpio con el nuevo pedido.

**RESPUESTAS:** NO uses bloques de código a menos que se pida explícitamente o estés en modo coder/gamedev. En modo casual, respondé con texto natural.

**REGLAS DE CÓDIGO:**
- ${this._labMode ? 'Lab ACTIVO: si el usuario pide código HTML/CSS/JS, usá SIEMPRE el bloque lab:code para escribirlo en el laboratorio web (preview en vivo).' : 'Lab INACTIVO: si el usuario pide código HTML/CSS/JS, mostralo en bloques regulares del chat. NO uses lab:code.'}
- Si el usuario pide código Node.js / scripts del sistema: usá \`\`\`script.
- Si el usuario pide comandos de terminal: usá \`\`\`cmd.
- NUNCA pongas código ejecutable en bloques regulares del chat — siempre usá la herramienta correspondiente.
- Hay un botón ✍ Lab que activa/desactiva el modo laboratorio. Por defecto está DESACTIVADO. Cuando lo activás, los bloques \`\`\`html, \`\`\`js, \`\`\`css se redirigen automáticamente al editor con preview en vivo. Si no está activo, el código se muestra normalmente en el chat.

**REGLAS PARA CAMBIOS DE DISEÑO (CRÍTICO):**
- ${this._labMode ? 'Cuando el usuario pida un cambio de diseño, color, layout, tamaño, posición, o cualquier modificación visual, **SIEMPRE** usá el bloque lab:code con el **CÓDIGO COMPLETO MODIFICADO** (no solo describas el cambio). Leé el código actual del laboratorio que te paso en el contexto, aplicá el cambio, y devolvé el HTML COMPLETO actualizado. NUNCA confirmes que aplicaste un cambio si no generaste un bloque lab:code con el código completo.' : 'Lab INACTIVO: si el usuario pide un cambio de diseño, mostrá el código completo modificado en un bloque regular del chat. NO uses lab:code.'}

Cuando el usuario pida "analiza", "extrae", "descarga", "busca contenido", o preguntas de seguridad, activa el modo técnico: usa las herramientas disponibles, genera bloques de código, sé preciso.

## PATRONES DE ARQUITECTURA — GUÍA PARA GENERAR CÓDIGO COMPLETO

Cuando el usuario pida crear algo (juego, app, visualización, etc.), analizá QUÉ componentes necesita ese proyecto y generá TODO el código completo en un solo bloque ${this._labMode ? 'lab:code' : 'de código en el chat'}. No preguntes, no describas — generá.

### 🎮 Juegos 2D (Canvas)
- Canvas + requestAnimationFrame loop
- Game loop: input → update → render
- Colisiones AABB
- Input: mapa de teclas (keydown/keyup), mouse
- Cámara: offset que sigue al jugador
- UI: HUD con score/vidas como overlay HTML

### 🎮 Juegos 3D (Three.js via CDN)
- Import map con \`<script type="importmap">\` para three + addons
- PointerLockControls para FPS
- Terreno procedural: Simplex/Perlin noise (incluir implementación inline ~80 líneas)
- Chunk system: grilla 3D, merges de geometría por tipo de bloque
- Optimización: InstancedMesh o BufferGeometry mergeado (NUNCA un mesh por cubo)
- Jugador: WASD + gravedad + salto + colisión AABB
- Raycaster: detectar bloque apuntado, highlight, romper/colocar
- Bloques: array de tipos con color, grilla como typed array
- Iluminación: DirectionalLight + AmbientLight + HemisphereLight
- Sky: color de fondo gradiente
- HUD: crosshair, barra de inventario
- ImportMap para módulos ES:
  \`<script type="importmap">{ "imports": { "three": "https://unpkg.com/three@0.160.0/build/three.module.js", "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/" }}</script>\`

### 🌐 Apps Web / Dashboards
- Layout: CSS Grid o Flexbox
- Componentes: funciones que retornan HTML
- State: objeto simple o localStorage
- Fetch API para datos
- Charts: canvas propio o librería CDN
- Tema: variables CSS dark/light

### 📊 Visualización de datos
- Canvas 2D para charts simples
- SVG para diagramas
- requestAnimationFrame para animaciones

### REGLAS PARA GENERAR CÓDIGO:
1. **Un solo HTML** — CSS en \`<style>\`, JS en \`<script>\`, sin archivos externos salvo CDN
2. **Funcional al instante** — que se pueda pegar y funcionar
3. **Comentarios de arquitectura** — explicar la estructura, no cada línea
4. **Rendimiento** — requestAnimationFrame, debounce, lazy loading
5. **Interactivo** — que el usuario pueda hacer algo desde el primer segundo
6. **Responsive** — adaptable a distintos tamaños
7. **Error handling** — try/catch donde importe

### 📁 FILE SYSTEM DEL LABORATORIO
El laboratorio tiene acceso a un file system persistente vía \`window.lab.fs\`:
- \`await lab.fs.save('archivo.json', contenido)\` — guardar archivo de texto
- \`await lab.fs.load('archivo.json')\` — leer archivo (devuelve string o null)
- \`await lab.fs.exists('archivo.json')\` — verificar si existe
- \`await lab.fs.list('.')\` — listar archivos en un directorio
- \`await lab.fs.remove('archivo.json')\` — eliminar archivo
- \`await lab.fs.mkdir('carpeta')\` — crear directorio
- \`await lab.fs.saveDialog(contenido, 'nombre.js')\` — diálogo nativo de guardar
- \`await lab.fs.openDialog()\` — diálogo nativo de abrir (devuelve {content, path, name})
- **Usar para:** guardar progreso de juegos, configuraciones, datos serializados, exportar resultados

### 📦 CDN LIBS DISPONIBLES (via importmap o script tag)
- **Three.js 3D:** \`https://unpkg.com/three@0.160.0/build/three.module.js\` (usar importmap)
- **Matter.js físicas 2D:** \`https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js\`
- **Howler.js audio:** \`https://cdnjs.cloudflare.com/ajax/libs/howler/2.2.4/howler.min.js\`
- **Planck.js Box2D:** \`https://cdnjs.cloudflare.com/ajax/libs/planck/1.0.4/planck.min.js\`
- **Chart.js gráficos:** \`https://cdn.jsdelivr.net/npm/chart.js\`
- **D3.js visualización:** \`https://cdn.jsdelivr.net/npm/d3@7\`

## SISTEMA DE MEMORIA / DIARIO
Tu memoria es un diario persistente del usuario. Guardá información de forma selectiva y PROACTIVA.

**⚠️ REGLAS DE FILTRADO — QUÉ NO GUARDAR JAMÁS:**
- ❌ NUNCA guardes páginas marcadas como peligrosas, phishing, maliciosas o sospechosas
- ❌ NUNCA guardes páginas con contenido de odio, violento, o ilegal
- ❌ NUNCA guardes publicidad, pop-ups, o páginas de tracking
- ❌ NUNCA guardes URLs con parámetros de tracking (?utm_..., ?ref=...)
- ❌ NUNCA guardes páginas genéricas de error (404, 500, timeout)
- ❌ NUNCA guardes contenido duplicado de una página ya guardada
- ❌ NUNCA guardes datos sensibles: contraseñas, tokens, datos bancarios, DNI
- ❌ NO guardes cada visita trivial — solo lo que aporta valor al usuario

**✅ CUÁNDO SÍ GUARDAR (solo lo valioso):**
- 🔹 El usuario pregunta sobre una página con interés real → GUARDÁ: título, URL, resumen
- 🔹 Hacés scraping y encontraste contenido útil → GUARDÁ: qué encontraste
- 🔹 Analizás seguridad y es SEGURA → GUARDÁ: "verificado seguro" + contexto
- 🔹 Buscás algo y hay buenos resultados → GUARDÁ: los más relevantes con URLs
- 🔹 El usuario guarda o recomienda un sitio → GUARDÁ como bookmark
- 🔹 Preferencias o datos personales que el usuario comparte voluntariamente → preference
- 🔹 Información que el usuario pide que recuerdes explícitamente → note

**ANTES de guardar, preguntate:**
1. ¿Esta información le sirve al usuario en el futuro?
2. ¿Es de una fuente confiable?
3. ¿Es un sitio seguro y legítimo?
4. ¿Aporta algo que no se pueda encontrar fácilmente?
Si la respuesta a alguna es NO → NO guardes.

**FORMATO de memory:save:**
\`\`\`memory:save
type: bookmark|note|analysis|preference|search
title: Descripción clara y corta
url: https://... (si aplica, solo si es segura)
summary: Qué encontraste o qué importa (1-2 líneas con datos concretos)
tags: tag1, tag2, tag3
\`\`\`

**Tipos disponibles:**
- \`bookmark\`: página visitada o recomendada (solo sites seguros)
- \`analysis\`: resultado de scraping, extracción, o análisis
- \`note\`: nota general, preferencia, dato personal
- \`search\`: resultado de una búsqueda relevante para el usuario
- \`preference\`: preferencia o configuración del usuario

**ANTES de responder sobre algo, consultá la memoria:**
Si el usuario pregunta sobre algo que ya hablaron, usá \`\`\`memory:search para buscar. No repitas información ya guardada.

**Antes de responder sobre un sitio web, consultá la memoria:**
Si el usuario pregunta sobre algo que ya hablaron antes, usá \`\`\`memory:search para buscar primero. No hagas la misma pregunta dos veces.

**Recordatorios:**
Cuando el usuario diga "acordame de...", "recordá que...", "no me olvides..." → creá el recordatorio con \`\`\`reminder:add automáticamente.

## LÓGICA DE HERRAMIENTAS (IMPORTANTE!)

**Para ANÁLISIS DE CONTENIDO (SOLO si el usuario lo pide):**
⚠️ Cuando usuario pregunta: "Analiza", "Extrae", "¿Qué tiene", "¿Qué contiene", etc.
ℹ️ MC Browser hace análisis automático en background (SIN IA) y lo guarda
ℹ️ Tú SOLO accedes si el usuario lo pide explícitamente

Si pide análisis:
1. \`\`\`scraping:structure → Entiende página
2. \`\`\`scraping:dynamic → ¿React/Vue? ¿Necesito JS?
3. \`\`\`scraping:apis → ¿API endpoint disponible?
4. \`\`\`scraping:pattern [type] → Extrae por patrón
5. \`\`\`eval o \`\`\`script → Si necesitas datos dinámicos

**Para SEGURIDAD (SOLO si el usuario lo pide explícitamente):**
⚠️ NO HAGAS análisis de seguridad automáticamente
⚠️ SOLO cuando el usuario pregunta sobre:
   - "¿Es segura/legítima esta página?"
   - "¿Hay algo sospechoso?"
   - "¿Podría ser phishing?"
   - "¿Es fraude?"
   - "Analiza seguridad"
   
Cuando pida seguridad:
1. \`\`\`security:analyze-url → Verifica dominio
2. \`\`\`security:analyze-html → Busca anomalías
3. Reporta findings con severidad

**Para DESCARGA:**
\`\`\`scraping:pattern videos → \`\`\`fetch → Descarga

## ACCESO A PESTAÑAS DEL NAVEGADOR
Al inicio del mensaje recibes automáticamente:
- **Lista de todas las pestañas** abiertas con ID, título, URL (la activa marcada)
- **URL activa** + HTML (~30000 chars) de la pestaña activa
- USA esto directamente sin herramientas adicionales

Para acceder a otras pestañas o más contexto usa las herramientas \`\`\`tabs, \`\`\`tab:switch, \`\`\`tab:context

## HERRAMIENTAS DISPONIBLES

### Scraping Avanzado
\`\`\`scraping:isolate
selector: "#main-content"
\`\`\`
→ Aisla contenedor específico de una página (análisis quirúrgico)

\`\`\`scraping:structure
\`\`\`
→ Analiza estructura de página (headings, tablas, formas, scripts)

\`\`\`scraping:pattern
pattern: articles|products|videos|tables|links
\`\`\`
→ Extrae por patrones comunes (articulos, productos, videos)

\`\`\`scraping:dynamic
\`\`\`
→ Detecta si es React/Vue/Next/Nuxt o tiene contenido dinámico

\`\`\`scraping:apis
\`\`\`
→ Encuentra APIs ocultas, endpoints GraphQL, llamadas fetch

\`\`\`scraping:metrics
\`\`\`
→ Métricas: tamaño, scripts, estilos, imágenes, lazy-load, 3rd party

### Análisis de Seguridad (detecta fraudulent)
\`\`\`security:analyze-url
url: https://...
\`\`\`
→ Detecta: typosquatting, subdominio sospechoso, marca roja

\`\`\`security:analyze-html
\`\`\`
→ Detecta: inyección iframe, form spoofing, mixed content, tracking

\`\`\`security:rules
\`\`\`
→ Lista todas las reglas activas

### Herramientas Clásicas (siguen funcionando)
\`\`\`cmd
powershell -Command "Get-Date"
\`\`\`
→ PowerShell directo

\`\`\`script
const fs = require('fs');
// Tu código Node.js
\`\`\`
→ Node.js con acceso a fs, path, fetch, Buffer

\`\`\`fetch
url: https://example.com/file.mp4
dest: C:\\Downloads\\MCBrowser\\file.mp4
\`\`\`
→ Descarga archivos

\`\`\`web:fetch
https://example.com/page
\`\`\`
→ Accede a una URL y devuelve su HTML/texto (hasta 8000 chars). Útil para analizar páginas, buscar APIs, scraping de servicios web. No descarga archivos, solo obtiene el contenido.

### Laboratorio Web (⚗ Lab)
\`\`\`lab:code
<!DOCTYPE html>
<html>
<body>
  <h1>Hola, mundo!</h1>
</body>
</html>
\`\`\`
→ Escribe código HTML/CSS/JS en el editor del laboratorio. El usuario presiona ▶ Run para ejecutarlo y ver el resultado. Incluye todo el HTML necesario (completo, no fragmentos).

**IMPORTANTE:** Cuando el usuario pida "escribí código", "creá una página", "hacé un componente", "generá HTML/CSS/JS" o cualquier request de código web, **SIEMPRE** usá \`\`\`lab:code para escribirlo en el laboratorio. NO pongas el código en bloques regulares dentro del chat — el laboratorio tiene editor con preview en vivo.

**PARA CAMBIOS/MODIFICACIONES:** Cuando el usuario pida cambiar algo del diseño (color, tamaño, posición, layout, fuente, borde, animación, etc.), leé el código actual del laboratorio que te paso en el contexto, aplicá el cambio, y respondé con un bloque \`\`\`lab:code que contenga el **CÓDIGO COMPLETO MODIFICADO**. NO describas el cambio — WRITÉ el código completo actualizado en el bloque \`\`\`lab:code.

\`\`\`tab
url: https://example.com
\`\`\`
→ Abre URL en nueva pestaña del navegador

\`\`\`tabs
\`\`\`
→ Lista todas las pestañas abiertas con ID, título y URL. Incluye marcador de la activa.

\`\`\`tab:switch
3
\`\`\`
→ Cambia a la pestaña con ID especificado. Usa el ID numérico de \`\`\`tabs.

\`\`\`tab:context
3
\`\`\`
→ Obtiene el HTML/DOM completo de una pestaña específica. Si omites ID, usa la pestaña activa. Recibirás URL, título y HTML.

\`\`\`decode
aHR0cHM6Ly9leGFtcGxl
\`\`\`
→ Decodifica base64

### Inspección de Página
\`\`\`console
\`\`\`
→ Errores JS, recursos fallidos

\`\`\`resources
\`\`\`
→ Scripts cargados, iframes, imágenes

## EJEMPLOS DE USO

**Ejemplo 1 - Conversación normal:**
Usuario: "¿Cómo funciona async/await en JavaScript?"
Tú: (Explicación clara, sin bloques de código a menos que sea necesario)

**Ejemplo 2 - Análisis de página:**
Usuario: "Analiza esta página y extrae los artículos"
1. Usa \`\`\`scraping:structure para ver qué hay
2. Usa \`\`\`scraping:pattern articles para encontrar artículos
3. Devuelve datos limpios

**Ejemplo 3 - Seguridad:**
Usuario: "¿Es segura esta página?"
1. Usa \`\`\`security:analyze-url para URL
2. Usa \`\`\`security:analyze-html para HTML
3. Reporta findings con severidad

**Ejemplo 4 - Scraping complejo:**
Usuario: "Descarga todos los videos de esta página"
1. Usa \`\`\`scraping:dynamic para ver si es SPA
2. Usa \`\`\`scraping:apis para encontrar endpoints
3. Usa \`\`\`eval para extraer URLs si es necesario
4. Usa \`\`\`fetch para descargar

## REGLAS IMPORTANTES
- **Sé conversacional primero** - No asumas que todo requiere análisis técnico
- **Análisis es A DEMANDA EXPLÍCITA** - Solo cuando usuario lo pide: "Analiza", "Extrae", etc.
- **Background scraping** - MC Browser ya corre análisis automático (sin IA) cuando carga páginas
- **Acceso a análisis** - Si el usuario lo pide, accedes a resultados pre-calculados o ejecutas nuevo análisis
- **Seguridad es SOLO POR DEMANDA** - Nunca automático, espera explícita solicitud
- **Detecta intención** - ¿Pregunta de curiosidad o demanda técnica?
- **Combina herramientas** - A veces necesitas varias para una tarea
- **Explica qué haces** - "Voy a analizar estructura...", "Encontré..."
- **Sé honesto** - Si algo falla o no está disponible, dilo
- **Entorno disponible:**
  - Node.js 22 + Electron 30
  - PowerShell en Windows
  - npm, fetch, fs, path, Buffer, crypto
  - Webview aislado con acceso a DOM${ctx}`;

    let result;
    try {
      const eff = this.getEffectiveCfg();
      result = await mc.aiChat({ messages: this.msgs, system, ...eff });
    } catch (err) {
      if (thinkEl) thinkEl.remove();
      this.setBtnMode('send');
      this.appendMsg('system', `Error de conexión: ${err.message}\nVerificá que la configuración del proveedor AI esté correcta.`);
      return;
    }
    if (thinkEl) thinkEl.remove();

    // Si el usuario mandó un nuevo mensaje mientras esperábamos, descartar esta respuesta
    if (this._generation !== myGen) return;
    if (result.aborted) { this.setBtnMode('send'); this.appendMsg('system', '⏹ Cancelado'); return; }
    if (result.error) { this.setBtnMode('send'); this.appendMsg('system', `Error: ${result.error}`); return; }

    // Mostrar contenido multimedia inline (imágenes, audio, video generados por IA)
    if (result.media && result.media.length > 0) {
      this.renderMedia(result.media);
    }

    const toolResults = await this.execTools(result.text);

    // Strip lab/code blocks from chat display and context
    let displayText = result.text;
    if (this._labMode === false) {
      // Lab inactivo: mostrar lab:code como bloque de código normal en el chat
      displayText = displayText.replace(/```lab:code/g, '```html').trim();
    } else {
      displayText = displayText.replace(/```lab:code[\s\S]*?```/g, '').trim();
      displayText = displayText.replace(/```(html|javascript|js|css|xml|svg)[\s\S]*?```/g, '').trim();
    }
    this.msgs.push({ role: 'assistant', content: displayText || '(código enviado al laboratorio)' });
    this.scheduleAutoSave();
    if (displayText) {
      this.appendMsg('assistant', displayText);
    } else if (toolResults.length) {
      this.appendMsg('system', '⚗ Código escrito en el laboratorio');
    }
    if (toolResults.length) {
      const summary = toolResults.map(t => {
        if (t.type === 'load') return `[CARGA] ${t.url}\nTítulo: ${t.title}\nHTML: ${(t.html || '').slice(0, 3000)}\nCookies: ${t.cookies || 0}`;
        if (t.type === 'eval') return `[EVAL]\n${t.result || '(sin resultado)'}`;
        if (t.type === 'cmd') return `[CMD] $ ${t.command}\n${t.result?.substring(0, 2000)}`;
        if (t.type === 'fetch') return `[FETCH] ${t.url}\n${t.result}`;
        if (t.type === 'script') return `[SCRIPT]\n${t.result?.substring(0, 3000)}`;
        if (t.type === 'decode') return `[DECODE]\n${t.result?.substring(0, 2000)}`;
        if (t.type === 'resources') return `[RECURSOS]\n${t.result?.substring(0, 3000)}`;
        if (t.type === 'adblock') return `[ADBLOCK]\n${t.result?.substring(0, 2000)}`;
        if (t.type === 'console') return `[CONSOLE]\n${t.result?.substring(0, 3000)}`;
        if (t.type === 'tab') return `[TAB]\n${t.result}`;
        if (t.type === 'lab') return `[LAB]\n${t.result}`;
        if (t.type?.startsWith('scraping:')) return `[SCRAPING:${t.type.split(':')[1]}]\n${t.result?.substring(0, 3000)}`;
        if (t.type?.startsWith('security:')) return `[SEGURIDAD:${t.type.split(':')[1]}]\n${t.result?.substring(0, 2000)}`;
        if (t.result) return `[${t.type}]\n${t.result?.substring(0, 3000)}`;
        return '';
      }).filter(Boolean).join('\n\n');

      const hasLabResult = toolResults.some(t => t.type === 'lab');
      // Mostrar resultados de herramientas — NUNCA auto-continue, siempre esperar input del usuario
      if (hasLabResult) {
        if (summary) this.appendMsg('system', `Resultados:\n${summary}`);
      } else if (summary) {
        this.appendMsg('system', `Resultados:\n${summary}`);
      }
      if (this._stopFlag) {
        this._stopFlag = false;
        this.appendMsg('system', '⏹ Cadena detenida');
      }
    }
    this.setBtnMode('send');
  },

  async execTools(text) {
    let match;
    const results = [];

    // cmd blocks
    const cmdRegex = /```cmd\s+([\s\S]*?)```/g;
    while ((match = cmdRegex.exec(text)) !== null) {
      const command = match[1].trim().replace(/[\r\n]+/g, ' ');
      if (!command) continue;
      // Modo supervisado: pedir permiso antes de ejecutar
      if (this.activeMode === 'supervised') {
        const ok = await this.showConsent(`🖥 El AI quiere ejecutar un comando:\n$ ${command}\n\n¿Autorizás?`);
        if (!ok) { results.push({ type: 'cmd', command, result: '⛔ Cancelado por el usuario' }); continue; }
      }
      this.appendMsg('thinking', `$ ${command}`);
      const res = await mc.aiExec({ command });
      results.push({ type: 'cmd', command, result: res.error || `exit ${res.code}\n${res.stdout || ''}${res.stderr ? '\n' + res.stderr : ''}` });
    }

    // fetch blocks
    const fetchRegex = /```fetch\s+([\s\S]*?)```/g;
    while ((match = fetchRegex.exec(text)) !== null) {
      const block = match[1].trim();
      const urlMatch = block.match(/url:\s*(.+)/);
      const destMatch = block.match(/dest:\s*(.+)/);
      if (!urlMatch) continue;
      const url = urlMatch[1].trim().replace(/[\r\n]+/g, '');
      const dest = destMatch ? destMatch[1].trim().replace(/[\r\n]+/g, '') : '';
      // Modo supervisado: pedir permiso antes de descargar
      if (this.activeMode === 'supervised') {
        const ok = await this.showConsent(`⬇ El AI quiere descargar:\n${url}${dest ? '\n→ ' + dest : ''}\n\n¿Autorizás?`);
        if (!ok) { results.push({ type: 'fetch', url, result: '⛔ Cancelado por el usuario' }); continue; }
      }
      this.appendMsg('thinking', `Descargando ${url.split('/').pop()}…`);
      const res = await mc.aiFetchUrl({ url, dest: dest || undefined });
      results.push({ type: 'fetch', url, result: res.error ? `Error: ${res.error}` : `✓ ${res.file} (${res.size} MB)` });
    }

    // script blocks → Node.js script runner
    const scriptRegex = /```script\s+([\s\S]*?)```/g;
    while ((match = scriptRegex.exec(text)) !== null) {
      const code = match[1].trim();
      if (!code) continue;
      // Modo supervisado: pedir permiso antes de ejecutar script
      if (this.activeMode === 'supervised') {
        const snippet = code.length > 200 ? code.slice(0, 200) + '…' : code;
        const ok = await this.showConsent(`⚡ El AI quiere ejecutar un script Node.js:\n\n${snippet}\n\n¿Autorizás?`);
        if (!ok) { results.push({ type: 'script', result: '⛔ Cancelado por el usuario' }); continue; }
      }
      this.appendMsg('thinking', `Ejecutando script Node.js (${code.length} chars)…`);
      const res = await mc.aiScriptRun({ code });
      if (res.error) {
        results.push({ type: 'script', result: `Error: ${res.error}` });
      } else {
        let out = '';
        if (res.stdout) out += res.stdout;
        if (res.stderr) out += (out ? '\n' : '') + 'STDERR: ' + res.stderr;
        out += (out ? '\n' : '') + 'exit: ' + res.exitCode;
        results.push({ type: 'script', result: out });
      }
    }

    // tab blocks → abrir URL en nueva pestaña del navegador
    const tabRegex = /```tab\b([^]*?)```/g;
    while ((match = tabRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (!block) continue;
      const urlMatch = block.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        const url = urlMatch[0];
        this.appendMsg('thinking', `Abriendo en nueva pestaña: ${url.slice(0,60)}…`);
        try {
          if (typeof addTab === 'function') {
            addTab(url);
            results.push({ type: 'tab', result: `✓ Abierto: ${url}` });
          } else {
            results.push({ type: 'tab', result: 'Error: addTab no disponible' });
          }
        } catch (err) {
          results.push({ type: 'tab', result: `Error: ${err.message}` });
        }
      }
    }

    // tabs block → listar todas las pestañas abiertas
    if (/```tabs/i.test(text) && !/```tab:/.test(text)) {
      const allTabs = typeof window.__mcGetTabs === 'function' ? window.__mcGetTabs() : [];
      if (allTabs.length) {
        const activeId = typeof window.__mcGetActiveTabId === 'function' ? window.__mcGetActiveTabId() : null;
        let out = `Total: ${allTabs.length} pestañas abiertas:\n\n`;
        for (const t of allTabs) {
          const marker = t.id === activeId ? ' ⬅ ACTIVA' : '';
          out += `[ID ${t.id}] ${t.title}\n   ${t.url}${marker}\n\n`;
        }
        results.push({ type: 'tab', result: out });
      } else {
        results.push({ type: 'tab', result: 'No hay pestañas abiertas' });
      }
    }

    // tab:switch block → cambiar a una pestaña por ID
    const tabSwitchRegex = /```tab:switch\b([^]*?)```/g;
    while ((match = tabSwitchRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (!block) continue;
      const idNum = parseInt(block, 10);
      if (!isNaN(idNum) && typeof window.__mcSwitchTab === 'function') {
        window.__mcSwitchTab(idNum);
        results.push({ type: 'tab', result: `✓ Cambiado a pestaña ID ${idNum}` });
      } else {
        results.push({ type: 'tab', result: 'Especifica un ID numérico de pestaña' });
      }
    }

    // tab:context block → obtener DOM de una pestaña específica (o activa)
    const tabCtxRegex = /```tab:context\b([^]*?)```/g;
    while ((match = tabCtxRegex.exec(text)) !== null) {
      const block = match[1].trim();
      let targetId = null;
      const idNum = parseInt(block, 10);
      if (!isNaN(idNum)) targetId = idNum;
      if (targetId == null && typeof window.__mcGetActiveTabId === 'function') {
        targetId = window.__mcGetActiveTabId();
      }
      if (targetId == null) {
        results.push({ type: 'tab', result: 'Error: no se pudo determinar pestaña' });
        continue;
      }
      const wvId = typeof window.__mcGetTabWebContentsId === 'function' ? window.__mcGetTabWebContentsId(targetId) : null;
      if (wvId) {
        this.appendMsg('thinking', `Extrayendo DOM de pestaña ID ${targetId}…`);
        const res = await mc.aiPageDom({ webContentsId: wvId });
        if (res?.html) {
          let out = `URL: ${res.url || '?'}\nTítulo: ${res.title || '?'}\n`;
          out += `HTML (${res.html.length} chars):\n${res.html.slice(0, 75000)}`;
          results.push({ type: 'tab', result: out });
        } else {
          results.push({ type: 'tab', result: 'No se pudo obtener DOM' });
        }
      } else {
        results.push({ type: 'tab', result: `Pestaña ID ${targetId} no encontrada o sin webview` });
      }
    }

    // web:fetch block → fetch URLs from web (like a browser)
    const webFetchRegex = /```web:fetch\s+([\s\S]*?)```/g;
    while ((match = webFetchRegex.exec(text)) !== null) {
      const block = match[1].trim();
      const urlMatch = block.match(/https?:\/\/[^\s]+/);
      if (!urlMatch) continue;
      const url = urlMatch[0];
      const isText = /asText|as_text|text/i.test(block);
      this.appendMsg('thinking', `🌐 Accediendo a ${url.slice(0, 60)}…`);
      const res = await mc.aiWebFetch({ url, asText: isText });
      results.push({ type: 'fetch', url, result: res.ok
        ? `HTTP ${res.size}B | ${Object.entries(res.headers || {}).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(', ')}\n\n${(res.text || '').slice(0, 8000)}`
        : `Error: ${res.error}` });
    }

    // decode blocks → base64/hex decode
    const decodeRegex = /```decode\b([^]*?)```/g;
    while ((match = decodeRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (!block) continue;
      const typeMatch = block.match(/^(base64|hex|base64url)\s+(.+)/s);
      let data = block;
      let type = 'base64';
      if (typeMatch) { type = typeMatch[1]; data = typeMatch[2].trim(); }
      // Si tiene lineas, unir todo
      data = data.replace(/\s+/g, '');
      this.appendMsg('thinking', `Decodificando ${type}…`);
      const res = await mc.aiDecode({ data, type });
      results.push({ type: 'decode', result: res.ok ? res.result : `Error: ${res.error}` });
    }

    // console block → inspeccionar como DevTools
    if (/```console/i.test(text)) {
      const wv = document.querySelector('.tab-webview.active');
      if (wv?.getWebContentsId) {
        this.appendMsg('thinking', 'Inspeccionando página (DevTools)…');
        const res = await mc.aiPageConsole({ webContentsId: wv.getWebContentsId() });
        if (res.ok) {
          let out = `URL: ${res.structure?.url || '?'}\nEstado: ${res.structure?.readyState || '?'}\n`;
          out += `Scripts: ${res.structure?.scripts || 0} | Iframes: ${res.structure?.iframes || 0} | Imgs: ${res.structure?.images || 0}\n`;
          if (res.jsErrors?.length) out += '\n⚠ Errores JS:\n' + res.jsErrors.map(e => `  [${e.type}] ${e.text}`).join('\n');
          if (res.failedResources?.length) out += '\n✕ Recursos fallidos:\n' + res.failedResources.map(r => `  ${r.status} ${r.url} (${r.size}B, ${r.duration}ms)`).join('\n');
          if (!res.jsErrors?.length && !res.failedResources?.length) out += '\nSin errores detectados.';
          results.push({ type: 'console', result: out });
        } else {
          results.push({ type: 'console', result: `Error: ${res.error}` });
        }
      } else {
        results.push({ type: 'console', result: 'No hay webview activo' });
      }
    }

    // resources block → analizar recursos de la pagina activa
    if (/```resources/i.test(text)) {
      const wv = document.querySelector('.tab-webview.active');
      if (wv?.getWebContentsId) {
        this.appendMsg('thinking', 'Analizando recursos de la página…');
        const res = await mc.aiPageResources({ webContentsId: wv.getWebContentsId() });
        if (res.ok) {
          let out = `URL: ${res.url}\nTítulo: ${res.title}\nTotal recursos: ${res.totalResources}\n`;
          if (res.scripts?.length) out += '\nScripts:\n' + res.scripts.map(s => '  ' + s).join('\n');
          if (res.iframes?.length) out += '\nIframes:\n' + res.iframes.map(f => '  ' + f).join('\n');
          if (res.resources?.length) out += '\nRecursos:\n' + res.resources.slice(0, 30).map(r => `  ${r.type} ${r.url} (${r.size}B, ${r.duration}ms)`).join('\n');
          results.push({ type: 'resources', result: out });
        } else {
          results.push({ type: 'resources', result: `Error: ${res.error}` });
        }
      } else {
        results.push({ type: 'resources', result: 'No hay webview activo' });
      }
    }

    // adblock block → gestionar adblock
    const adblockRegex = /```adblock\s+([\s\S]*?)```/g;
    while ((match = adblockRegex.exec(text)) !== null) {
      const block = match[1].trim().toLowerCase();
      if (block.startsWith('info')) {
        const res = await mc.aiAdblockInfo();
        results.push({ type: 'adblock', result: res.ok ? JSON.stringify(res, null, 2) : `Error: ${res.error}` });
      } else if (block.startsWith('import') || block.startsWith('url')) {
        const urlMatch = block.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          this.appendMsg('thinking', `Importando lista: ${urlMatch[0].slice(0,60)}…`);
          const res = await mc.aiAdblockImport({ url: urlMatch[0] });
          results.push({ type: 'adblock', result: res.ok ? `Importadas ${res.added} reglas de ${res.total} lineas` : `Error: ${res.error}` });
        } else {
          results.push({ type: 'adblock', result: 'Especifica una URL de lista' });
        }
      } else if (block.startsWith('test')) {
        const wv = document.querySelector('.tab-webview.active');
        if (wv?.getWebContentsId) {
          this.appendMsg('thinking', 'Analizando posibles anuncios…');
          const res = await mc.aiAdblockTest({ webContentsId: wv.getWebContentsId() });
          if (res.ok) {
            let out = `URL: ${res.url}\nTotal recursos: ${res.total}\nSospechosos: ${res.suspicious?.length || 0}\n`;
            if (res.suspicious?.length) out += '\n' + res.suspicious.map(a => `  ${a.type} ${a.url} (${a.size}B)`).join('\n');
            results.push({ type: 'adblock', result: out });
          } else {
            results.push({ type: 'adblock', result: `Error: ${res.error}` });
          }
        }
      }
    }

    // scraping blocks → herramientas avanzadas de scraping
    const scrapingRegex = /```scraping:(\w+)\s+([\s\S]*?)```/g;
    while ((match = scrapingRegex.exec(text)) !== null) {
      const tool = match[1].toLowerCase();
      const block = match[2].trim();
      const params = {};

      // Parse params: key: value
      const paramLines = block.split('\n').filter(l => l.includes(':'));
      paramLines.forEach(line => {
        const [k, v] = line.split(':').map(s => s.trim());
        params[k] = v;
      });

      this.appendMsg('thinking', `Ejecutando scraping:${tool}…`);

      if (tool === 'isolate') {
        const res = await mc.aiScrapingIsolate({ 
          selector: params.selector, 
          html: params.html || this.lastPageHtml 
        });
        results.push({ 
          type: 'scraping:isolate', 
          result: res.ok 
            ? `Contenedor aislado (${res.size} bytes):\n${res.result?.slice(0, 2000) || ''}`
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'structure') {
        const res = await mc.aiScrapingAnalyzeStructure({ 
          html: params.html || this.lastPageHtml 
        });
        results.push({ 
          type: 'scraping:structure', 
          result: res.ok 
            ? JSON.stringify(res.structure, null, 2)
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'pattern') {
        const res = await mc.aiScrapingExtractPattern({ 
          html: params.html || this.lastPageHtml,
          pattern: params.pattern 
        });
        results.push({ 
          type: 'scraping:pattern', 
          result: res.ok 
            ? (Array.isArray(res.result) ? res.result.slice(0, 20).join('\n') : JSON.stringify(res.result, null, 2))
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'dynamic') {
        const res = await mc.aiScrapingDetectDynamic({ 
          html: params.html || this.lastPageHtml 
        });
        results.push({ 
          type: 'scraping:dynamic', 
          result: res.ok 
            ? (res.hints?.length ? res.hints.join('\n') : 'Página estática (no requiere JS)')
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'apis') {
        const res = await mc.aiScrapingDiscoverAPIs({ 
          html: params.html || this.lastPageHtml 
        });
        results.push({ 
          type: 'scraping:apis', 
          result: res.ok 
            ? (res.apis?.length ? res.apis.map(a => `${a.type}: ${a.url || a.hint}`).join('\n') : 'Sin APIs detectadas')
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'metrics') {
        const res = await mc.aiScrapingMetrics({ 
          html: params.html || this.lastPageHtml 
        });
        results.push({ 
          type: 'scraping:metrics', 
          result: res.ok 
            ? JSON.stringify(res.metrics, null, 2)
            : `Error: ${res.error}` 
        });
      }
    }

    // security blocks → análisis de seguridad
    const securityRegex = /```security:(\w+-?\w+)\s+([\s\S]*?)```/g;
    while ((match = securityRegex.exec(text)) !== null) {
      const tool = match[1].toLowerCase();
      const block = match[2].trim();
      const params = {};

      // Parse params
      const paramLines = block.split('\n').filter(l => l.includes(':'));
      paramLines.forEach(line => {
        const [k, v] = line.split(':').map(s => s.trim());
        params[k] = v;
      });

      this.appendMsg('thinking', `Analizando seguridad: ${tool}…`);

      if (tool === 'analyze-url') {
        const res = await mc.aiSecurityAnalyzeUrl({ url: params.url });
        results.push({ 
          type: 'security:analyze-url', 
          result: res.ok 
            ? (res.findings?.length 
              ? res.findings.map(f => `[${f.severity.toUpperCase()}] ${f.name}: ${f.message}`).join('\n')
              : 'URL segura - Sin anomalías detectadas')
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'analyze-html') {
        const html = params.html || this.lastPageHtml;
        const url = params.url;
        if (!url) {
          results.push({ type: 'security:analyze-html', result: 'Error: Especifica URL' });
          continue;
        }
        const res = await mc.aiSecurityAnalyzeHtml({ html, url });
        results.push({ 
          type: 'security:analyze-html', 
          result: res.ok 
            ? (res.findings?.length 
              ? res.findings.map(f => `[${f.severity.toUpperCase()}] ${f.name}: ${f.message}`).join('\n')
              : 'HTML seguro - Sin problemas detectados')
            : `Error: ${res.error}` 
        });
      }

      if (tool === 'rules') {
        const res = await mc.aiSecurityRules();
        results.push({ 
          type: 'security:rules', 
          result: res.ok 
            ? res.rules.map(r => `${r.enabled ? '✓' : '✗'} [${r.severity}] ${r.name}`).join('\n')
            : `Error: ${res.error}` 
        });
      }
    }

    // memory:save blocks → guardar en diario/memoria
    const memSaveRegex = /```memory:save\s+([\s\S]*?)```/g;
    while ((match = memSaveRegex.exec(text)) !== null) {
      const block = match[1].trim();
      const params = {};
      block.split('\n').filter(l => l.includes(':')).forEach(line => {
        const idx = line.indexOf(':');
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) params[k] = v;
      });
      const title = params.title || 'Sin título';
      const type = params.type || 'note';
      const url = params.url || '';
      const summary = params.summary || '';
      const tags = params.tags ? params.tags.split(',').map(t => t.trim()) : [];
      this.appendMsg('thinking', `📝 Guardando en memoria: ${title}…`);
      try {
        const entry = await mc.memoryAdd({ type, title, url, summary, tags });
        results.push({ type: 'memory', result: `✓ Guardado: "${entry.title}" (${entry.id})` });
        this.refreshMemory();
      } catch (e) {
        results.push({ type: 'memory', result: `Error al guardar memoria: ${e.message}` });
      }
    }

    // reminder:add blocks → crear recordatorio
    const reminderAddRegex = /```reminder:add\s+([\s\S]*?)```/g;
    while ((match = reminderAddRegex.exec(text)) !== null) {
      const block = match[1].trim();
      const params = {};
      block.split('\n').filter(l => l.includes(':')).forEach(line => {
        const idx = line.indexOf(':');
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) params[k] = v;
      });
      const text2 = params.text || params.reminder || 'Recordatorio';
      const due = params.due || params.date || null;
      this.appendMsg('thinking', `⏰ Creando recordatorio: ${text2}…`);
      try {
        const reminder = await mc.remindersAdd({ text: text2, dueDate: due });
        results.push({ type: 'reminder', result: `✓ Recordatorio creado: "${reminder.text}"` });
        this.refreshReminders();
      } catch (e) {
        results.push({ type: 'reminder', result: `Error al crear recordatorio: ${e.message}` });
      }
    }

    // memory:search blocks → buscar en memoria
    const memSearchRegex = /```memory:search\s+([\s\S]*?)```/g;
    while ((match = memSearchRegex.exec(text)) !== null) {
      const query = match[1].trim();
      if (!query) continue;
      this.appendMsg('thinking', `🔍 Buscando en memoria: "${query}"…`);
      try {
        const entries = await mc.memorySearch(query);
        if (entries.length) {
          const list = entries.slice(0, 5).map(e => `• [${e.type}] ${e.title}: ${(e.summary || '').slice(0, 80)}`).join('\n');
          results.push({ type: 'memory:search', result: `${entries.length} resultados:\n${list}` });
        } else {
          results.push({ type: 'memory:search', result: 'Sin resultados para esa búsqueda.' });
        }
      } catch (e) {
        results.push({ type: 'memory:search', result: `Error al buscar: ${e.message}` });
      }
    }

    // lab:code block → escribir en el laboratorio web (solo escribe, NO ejecuta auto)
    const labCodeRegex = /```lab:code\s+([\s\S]*?)```/g;
    while ((match = labCodeRegex.exec(text)) !== null) {
      const code = match[1].trim();
      if (!code) continue;
      // Si el modo lab NO está activo, no escribir en el laboratorio (el código se muestra en el chat)
      if (this._labMode === false) {
        results.push({ type: 'lab', result: '⚠ Modo Lab inactivo — el código se muestra en el chat (activá ✍ Lab para escribirlo en el laboratorio)' });
        continue;
      }
      // Modo supervisado: pedir permiso antes de escribir
      if (this.activeMode === 'supervised') {
        const ok = await this.showConsent(`✍ El AI quiere escribir código en el laboratorio (${code.length} chars). ¿Autorizás?`);
        if (!ok) { results.push({ type: 'lab', result: '⛔ Cancelado por el usuario' }); continue; }
      }
      this.appendMsg('thinking', '⚗ Escribiendo en el laboratorio web…');
      try {
        const ta = document.getElementById('lab-code');
        if (!ta) {
          results.push({ type: 'lab', result: 'Error: el panel de laboratorio no está disponible en la página' });
          continue;
        }
        ta.value = code;
        // NO ejecutar automáticamente — el usuario usa el botón ▶ Run para ejecutar
        if (typeof labAddHistory === 'function') labAddHistory(code);
        if (typeof _labPushHistory === 'function') _labPushHistory(code);
        results.push({ type: 'lab', result: `✓ Código escrito en el laboratorio (${code.length} chars) — presioná ▶ Run para ejecutar` });
      } catch (err) {
        results.push({ type: 'lab', result: `Error: ${err.message}` });
      }
    }

    // Auto-detect HTML/JS/CSS blocks → lab (only if lab mode is on)
    if (this._labMode !== false) {
      const autoLabLang = /```(html|javascript|js|css|xml|svg)\s+([\s\S]*?)```/gi;
      while ((match = autoLabLang.exec(text)) !== null) {
        const lang = match[1].toLowerCase();
        const code = match[2].trim();
        if (!code) continue;
        const ta = document.getElementById('lab-code');
        if (!ta) continue;
        let full = code;
        if (lang === 'css') full = '<!DOCTYPE html>\n<html>\n<head>\n  <style>\n' + code + '\n  </style>\n</head>\n<body>\n\n</body>\n</html>';
        else if (lang === 'javascript' || lang === 'js') full = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Script</title>\n</head>\n<body>\n  <script>\n' + code + '\n  </script>\n</body>\n</html>';
        else if (lang === 'xml' || lang === 'svg') full = '<!DOCTYPE html>\n<html>\n<body>\n' + code + '\n</body>\n</html>';
        // Modo supervisado: pedir permiso
        if (this.activeMode === 'supervised') {
          const ok = await this.showConsent(`✍ El AI quiere escribir código ${lang} en el laboratorio (${full.length} chars). ¿Autorizás?`);
          if (!ok) continue;
        }
        this.appendMsg('thinking', '⚗ Código ' + lang + ' auto-detectado → laboratorio');
        ta.value = full;
        // NO ejecutar automáticamente — el usuario usa el botón ▶ Run
        if (typeof labAddHistory === 'function') labAddHistory(full);
        if (typeof _labPushHistory === 'function') _labPushHistory(full);
        results.push({ type: 'lab', result: '✓ Código ' + lang + ' escrito en el laboratorio (' + full.length + ' chars) — presioná ▶ Run' });
      }
    }

    return results;
  },

  // Renderizar contenido multimedia inline (imágenes, audio, video generados por IA)
  renderMedia(media) {
    if (!media || !media.length) return;
    const msgs = document.getElementById('ai-msgs');
    if (!msgs) return;

    const container = document.createElement('div');
    container.className = 'message ai-message';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '✦';
    container.appendChild(avatar);

    const wrapper = document.createElement('div');
    wrapper.className = 'message-content ai-media-container';

    for (const item of media) {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'ai-media-item';

      if (item.type === 'image') {
        // Imagen: clickable para ver en tamaño completo
        const img = document.createElement('img');
        img.src = `data:${item.mimeType};base64,${item.data}`;
        img.className = 'ai-media-img';
        img.alt = 'Imagen generada por IA';
        img.onclick = () => {
          // Overlay de pantalla completa
          const overlay = document.createElement('div');
          overlay.className = 'ai-media-overlay';
          overlay.onclick = () => overlay.remove();
          const fullImg = document.createElement('img');
          fullImg.src = img.src;
          fullImg.className = 'ai-media-full';
          overlay.appendChild(fullImg);
          document.body.appendChild(overlay);
        };
        itemDiv.appendChild(img);
      } else if (item.type === 'audio') {
        // Audio: reproductor inline
        const label = document.createElement('div');
        label.className = 'ai-media-label';
        label.textContent = '🔊 Audio generado por IA';
        itemDiv.appendChild(label);
        const audio = document.createElement('audio');
        audio.src = `data:${item.mimeType};base64,${item.data}`;
        audio.controls = true;
        audio.className = 'ai-media-audio';
        itemDiv.appendChild(audio);
      } else if (item.type === 'video') {
        // Video: reproductor inline
        const label = document.createElement('div');
        label.className = 'ai-media-label';
        label.textContent = '🎬 Video generado por IA';
        itemDiv.appendChild(label);
        const video = document.createElement('video');
        video.src = `data:${item.mimeType};base64,${item.data}`;
        video.controls = true;
        video.className = 'ai-media-video';
        video.style.maxWidth = '100%';
        video.style.borderRadius = '8px';
        itemDiv.appendChild(video);
      }

      // Botón de descarga
      const dlBtn = document.createElement('button');
      dlBtn.className = 'ai-media-download';
      dlBtn.textContent = '⬇ Descargar';
      dlBtn.onclick = async () => {
        try {
          dlBtn.textContent = '⏳ Guardando...';
          dlBtn.disabled = true;
          const ext = item.mimeType?.includes('png') ? '.png'
            : item.mimeType?.includes('jpeg') || item.mimeType?.includes('jpg') ? '.jpg'
            : item.mimeType?.includes('gif') ? '.gif'
            : item.mimeType?.includes('webp') ? '.webp'
            : item.mimeType?.includes('mp3') ? '.mp3'
            : item.mimeType?.includes('wav') ? '.wav'
            : item.mimeType?.includes('mp4') ? '.mp4'
            : item.mimeType?.includes('webm') ? '.webm'
            : item.mimeType?.includes('ogg') ? '.ogg'
            : '.bin';
          const filename = `mc-ai-media-${Date.now()}${ext}`;
          const res = await mc.aiMediaSave({ data: item.data, mimeType: item.mimeType, filename });
          if (res.ok) {
            dlBtn.textContent = `✓ Guardado: ${res.filename}`;
            dlBtn.style.background = '#28a745';
          } else {
            dlBtn.textContent = `✗ Error: ${res.error}`;
            dlBtn.style.background = '#dc3545';
          }
        } catch (e) {
          dlBtn.textContent = `✗ Error: ${e.message}`;
          dlBtn.style.background = '#dc3545';
        }
      };
      itemDiv.appendChild(dlBtn);

      wrapper.appendChild(itemDiv);
    }

    container.appendChild(wrapper);
    msgs.appendChild(container);
    msgs.scrollTop = msgs.scrollHeight;
  },

  appendMsg(role, text) {
    const msgs = document.getElementById('ai-msgs');
    if (!msgs) return;
    const el = document.createElement('div');
    el.className = 'message ' + role;

    const content = document.createElement('div');
    content.className = 'message-content';
    if (Array.isArray(text)) {
      // Contenido multimodal: texto + imágenes adjuntas
      for (const part of text) {
        if (!part) continue;
        if (part.type === 'text') {
          const t = document.createElement('div');
          t.textContent = part.text;
          content.appendChild(t);
        } else if (part.type === 'image_url') {
          const img = document.createElement('img');
          img.src = part.image_url?.url || '';
          img.className = 'ai-media-img';
          img.alt = 'Imagen adjunta';
          img.title = 'Clic para ampliar';
          img.onclick = () => this.openMediaFull(img.src);
          content.appendChild(img);
        }
      }
    } else {
      content.textContent = text;
    }

    if (role === 'user') {
      el.classList.add('user-message');
      el.appendChild(content);
    } else if (role === 'assistant') {
      el.classList.add('ai-message');
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = '✦';
      el.appendChild(avatar);
      el.appendChild(content);

      const urls = text.match(/https?:\/\/[^\s\n]+\.(?:m3u8|mpd)[^\s\n]*/g);
      if (urls) {
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;';
        [...new Set(urls)].forEach(url => {
          const btn = document.createElement('button');
          btn.className = 'action-chip';
          btn.textContent = '⬇ ' + (url.split('/').pop()?.slice(0, 30) || 'stream');
          btn.title = url;
          btn.onclick = () => {
            mc.aiDlUrl({ url, name: url.split('/').pop()?.split('?')[0] || 'stream' });
            btn.textContent = '⏳…'; btn.disabled = true;
          };
          btns.appendChild(btn);
        });
        content.appendChild(btns);
      }
    } else {
      // system, thinking
      if (role === 'thinking') el.classList.add('ai-message');
      else el.classList.add('system-message');
      el.appendChild(content);
    }

    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  },

  quick(action) {
    const map = {
      stream: 'Encuentra el stream/video en la página activa. Si ves una URL m3u8/mpd, usala directo.',
      resume: 'Resume en 3 puntos el contenido.',
      debug: 'Analiza tecnologías de la página activa.',
      dark: 'CSS dark mode elegante. Solo CSS.',
      links: 'Extrae los 15 enlaces más relevantes.',
      lab: 'Crea una página HTML interactiva en el laboratorio web. Usa lab:code para escribir el código.'
    };
    this.send(map[action] || action);
  },

  // Quick actions contextuales — detecta tipo de página y muestra acciones relevantes
  updateQuickActions() {
    const url = document.getElementById('urlinput')?.value || '';
    const quickArea = document.getElementById('ai-quick');
    if (!quickArea) return;

    const isVideo = /youtube|youtu\.be|vimeo|dailymotion|twitch|tiktok|instagram.*reel|twitter.*video|x\.com.*video/i.test(url);
    const isArticle = /medium\.com|dev\.to|substack|linkedin\.com.*post|reddit\.com|news|blog|article|notion\.site/i.test(url);
    const isShop = /amazon|mercadolibre|ebay|aliexpress|shopify|ml\.com|tienda|store|buy/i.test(url);
    const isCode = /github|gitlab|stackoverflow|codepen|jsfiddle|replit|npmjs/i.test(url);
    const isSocial = /twitter|x\.com|facebook|instagram|linkedin|tiktok|reddit/i.test(url);
    const isNewTab = !url || url === 'mc://newtab';

    let chips = [];

    if (isNewTab) {
      chips = [
        { action: 'resume', icon: '📝', label: 'Resumir' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'lab', icon: '⚗', label: 'Lab' },
      ];
    } else if (isVideo) {
      chips = [
        { action: 'stream', icon: '🎬', label: 'Video/Stream' },
        { action: 'resume', icon: '📝', label: 'Resumir' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'debug', icon: '🔧', label: 'Tech' },
      ];
    } else if (isArticle) {
      chips = [
        { action: 'resume', icon: '📝', label: 'Resumir' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'debug', icon: '🔧', label: 'Tech' },
        { action: 'dark', icon: '🌙', label: 'Dark' },
      ];
    } else if (isShop) {
      chips = [
        { action: 'resume', icon: '📝', label: 'Comparar' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'debug', icon: '🔧', label: 'Tech' },
      ];
    } else if (isCode) {
      chips = [
        { action: 'resume', icon: '📝', label: 'Explicar' },
        { action: 'debug', icon: '🔧', label: 'Analizar' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'lab', icon: '⚗', label: 'Lab' },
      ];
    } else if (isSocial) {
      chips = [
        { action: 'resume', icon: '📝', label: 'Resumir' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'debug', icon: '🔧', label: 'Tech' },
      ];
    } else {
      chips = [
        { action: 'stream', icon: '🎬', label: 'Stream' },
        { action: 'resume', icon: '📝', label: 'Resumir' },
        { action: 'debug', icon: '🔧', label: 'Tech' },
        { action: 'dark', icon: '🌙', label: 'Dark' },
        { action: 'links', icon: '🔗', label: 'Links' },
        { action: 'lab', icon: '⚗', label: 'Lab' },
      ];
    }

    // Mantener el botón Lab toggle al final
    let labToggle = document.getElementById('ai-lab-toggle');
    if (!labToggle) {
      labToggle = document.createElement('button');
      labToggle.id = 'ai-lab-toggle';
      labToggle.className = 'action-chip';
      labToggle.textContent = '✍ Lab';
      labToggle.style.cssText = 'border:1px solid var(--border);font-size:10px;';
      labToggle.onclick = () => this.toggleLabMode();
    }
    labToggle.style.borderColor = this._labMode ? 'var(--accent)' : 'var(--border)';
    labToggle.style.background = this._labMode ? 'var(--accent)' : 'transparent';
    labToggle.style.color = this._labMode ? '#000' : 'var(--text)';
    quickArea.innerHTML = chips.map(c =>
      `<button class="action-chip" onclick="AI.quick('${c.action}')">${c.icon} ${c.label}</button>`
    ).join('');
    quickArea.appendChild(labToggle);
  },

  // Texto seleccionado → botón flotante para preguntar a la IA
  _selectionBtn: null,
  initTextSelection() {
    document.addEventListener('mouseup', (e) => {
      const sel = window.getSelection();
      const text = sel?.toString()?.trim();

      if (this._selectionBtn) {
        this._selectionBtn.remove();
        this._selectionBtn = null;
      }

      if (!text || text.length < 5 || text.length > 500) return;
      // No mostrar en el sidebar de la IA
      if (e.target.closest('#ai-sidebar') || e.target.closest('#webchat-sidebar')) return;

      const btn = document.createElement('div');
      btn.className = 'ai-selection-btn';
      btn.innerHTML = '✦ Preguntar a la IA';
      btn.style.cssText = `position:fixed;z-index:99999;left:${e.clientX + 10}px;top:${e.clientY - 10}px;`;
      btn.onclick = () => {
        btn.remove();
        this._selectionBtn = null;
        // Abrir sidebar si está cerrado
        const sb = document.getElementById('ai-sidebar');
        if (sb && !sb.classList.contains('open')) this.toggle();
        // Enviar con contexto del texto seleccionado
        setTimeout(() => {
          const inp = document.getElementById('ai-inp');
          if (inp) inp.value = '';
          this.send(`Sobre este texto seleccionado: "${text.slice(0, 200)}"\n\nExplicame, analizame, o lo que consideres relevante.`);
        }, 300);
      };
      document.body.appendChild(btn);
      this._selectionBtn = btn;
    });

    // Ocultar botón al hacer click en otro lado
    document.addEventListener('mousedown', (e) => {
      if (this._selectionBtn && !this._selectionBtn.contains(e.target)) {
        this._selectionBtn.remove();
        this._selectionBtn = null;
      }
    });
  },

  toggleLabMode() {
    this._labMode = !this._labMode;
    const btn = document.getElementById('ai-lab-toggle');
    if (btn) {
      btn.style.borderColor = this._labMode ? 'var(--accent)' : 'var(--border)';
      btn.style.background = this._labMode ? 'var(--accent)' : 'transparent';
      btn.style.color = this._labMode ? '#000' : 'var(--text)';
      btn.title = this._labMode ? 'Modo Lab: activo (código → laboratorio)' : 'Modo Lab: inactivo (código → chat)';
    }
    this.appendMsg('system', this._labMode ? '✍ Modo Lab activado — el código se escribe en el laboratorio' : '✍ Modo Lab desactivado — el código se muestra en el chat');
  },

  askMedia(url, type) {
    this.toggle();
    setTimeout(() => {
      this.send(`Analiza este ${type}: ${url}. No descargues nada automáticamente. Determina si es un enlace directo, identifica el tipo de recurso, revisa si parece HLS/DASH/MP4, comprueba los parámetros de expiración (exp), tokens, firmas, referer u otras restricciones, indica si es temporal y explica cómo podría reproducirse o abrirse. Solo descarga si te lo pido explícitamente.`);
    }, 400);
  },

  // ── Background ──────────────────────────────────
  loadBg() {
    try {
      const raw = localStorage.getItem('mc-ai-bg');
      if (raw) this._bg = JSON.parse(raw);
    } catch {}
    try {
      const d = localStorage.getItem('mc-ai-bg-default');
      if (d) this._bgDefault = JSON.parse(d);
    } catch {}
    if (!this._bg) this._bg = { data: null };
    if (this._bg.data) this.applyBg(this._bg.data);
  },

  saveBg() {
    try { localStorage.setItem('mc-ai-bg', JSON.stringify(this._bg)); } catch {}
  },

  saveBgDefault() {
    this._bgDefault = this._bg ? { data: this._bg.data } : null;
    try { localStorage.setItem('mc-ai-bg-default', JSON.stringify(this._bgDefault)); } catch {}
  },

  applyBg(data) {
    const bg = document.getElementById('ai-bg');
    if (!bg) return;
    const sb = document.getElementById('ai-sidebar');
    if (!data) {
      bg.style.backgroundImage = '';
      if (sb) { sb.style.background = ''; sb.classList.remove('has-bg'); }
      return;
    }
    bg.style.backgroundImage = 'url("' + data + '")';
    if (sb) { sb.style.background = 'transparent'; sb.classList.add('has-bg'); }
  },

  handleBgFile(e) {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      this._bg.data = ev.target.result;
      this.saveBg();
      this.applyBg(this._bg.data);
    };
    reader.readAsDataURL(file);
  },

  applyBgUrl() {
    const url = document.getElementById('ai-bg-url')?.value?.trim();
    if (!url) return;
    this._bg.data = url;
    this.saveBg();
    this.applyBg(url);
  },

  clearBg() {
    if (this._bgDefault && this._bgDefault.data) {
      this._bg.data = this._bgDefault.data;
      this.saveBg();
      this.applyBg(this._bgDefault.data);
    } else {
      this._bg.data = null;
      this.saveBg();
      this.applyBg(null);
    }
    const inp = document.getElementById('ai-bg-url');
    if (inp) inp.value = '';
    const file = document.getElementById('ai-bg-file');
    if (file) file.value = '';
  },

  // === AI MODE ===
  activeMode: 'casual',
  _lastUserMsg: '',
  _generation: 0,  // Incrementa con cada send() para cancelar cadenas anteriores

  initModePills() {
    document.querySelectorAll('.ai-mode-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.ai-mode-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeMode = btn.dataset.mode;
        const labels = { casual: '💬 Casual', coder: '💻 Programador Web', gamedev: '🎮 Game Dev', private: '🔒 Privado', supervised: '🛡 Supervisado' };
        const tips = {
          casual: 'Conversación natural, respuestas claras y directas.',
          coder: 'Modo programador: código limpio, arquitectura, mejores prácticas. Usá lab:code para todo código web.',
          gamedev: 'Game developer: Three.js, Canvas, GameMaker patterns. Generá juegos completos.',
          private: 'Máxima privacidad — no guardés nada en memoria.',
          supervised: 'Todas las acciones requieren tu confirmación antes de ejecutarse.'
        };
        this.appendMsg('system', `${labels[this.activeMode]}\n${tips[this.activeMode]}`);
        // El aviso de arriba es solo visual (appendMsg no toca this.msgs, que es
        // lo que realmente se manda a la API). El system prompt siempre va
        // primero en el array y con modelos chicos/rápidos pierde peso frente
        // al historial ya acumulado — por eso "se olvidaba" el modo. Guardamos
        // un recordatorio para inyectarlo pegado al PRÓXIMO mensaje real del
        // usuario (máximo efecto de recencia, funciona con cualquier proveedor).
        this._pendingModeNote = `[Cambio de modo activado: ${labels[this.activeMode]} — ${tips[this.activeMode]}]`;
      });
    });
  },

  /** Detecta si el usuario cambió de tema completamente */
  _isContextSwitch(newText) {
    if (!this._lastUserMsg) return false;
    const prev = this._lastUserMsg.toLowerCase();
    const curr = newText.toLowerCase();
    // SOLO palabras que indican cambio EXPLÍCITO y claro
    const switchWords = /\botro tema\b|\botro asunto\b|\botra cosa\b|\ben vez de eso\b|\babandonar\b|\bdejar esto\b|\bolvidalo\b|\bcancelalo\b|\bpará\b|\bdejá\b/;
    if (switchWords.test(curr)) return true;
    // Si los topics son muy diferentes (similitud muy baja = cambio real)
    const stopwords = new Set(['para','como','pero','este','esta','ese','esa','hay','que','con','por','una','uno','los','las','del','más','puede','tiene','hacer','todo','bien','cuando','donde','todo','cada']);
    const prevWords = new Set(prev.replace(/[^a-záéíóúñü\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w)));
    const currWords = curr.replace(/[^a-záéíóúñü\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
    if (prevWords.size > 4 && currWords.size > 3) {
      let common = 0;
      for (const w of currWords) if (prevWords.has(w)) common++;
      const similarity = common / Math.min(prevWords.size, currWords.size);
      if (similarity < 0.05) return true;  // Muy estricto: casi 0 palabras en común
    }
    return false;
  },

  // === TABS ===
  switchTab(name) {
    document.querySelectorAll('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.aitab === name));
    document.querySelectorAll('.ai-tab-content').forEach(tc => tc.classList.remove('active'));
    const target = document.getElementById('ai-tab-' + name);
    if (target) target.classList.add('active');
    if (name === 'memory') this.refreshMemory();
    if (name === 'reminders') this.refreshReminders();
  },

  // === MEMORY ===
  async refreshMemory() {
    try {
      const entries = await mc.memoryRecent(8);
      const container = document.getElementById('ai-recent-memory');
      if (!container) return;
      if (!entries.length) {
        container.innerHTML = '<div class="ai-empty-state">Sin entradas aún</div>';
        return;
      }
      container.innerHTML = entries.map(en => `
        <div class="ai-mem-item">
          <div class="ai-mem-item-head">
            <span class="ai-mem-item-title">${this.escHtml(en.title)}</span>
            <span class="ai-mem-item-type">${en.type}</span>
          </div>
          <div class="ai-mem-item-summary">${this.escHtml((en.summary || '').slice(0, 90))}</div>
          ${en.url ? `<div class="ai-mem-item-url">${this.escHtml(en.url)}</div>` : ''}
        </div>
      `).join('');
    } catch (e) { console.error('[AI-MEM]', e); }
  },

  _searchTimer: null,
  async onMemorySearch(query) {
    clearTimeout(this._searchTimer);
    const resultsDiv = document.getElementById('ai-memory-results');
    const titleDiv = document.getElementById('ai-mem-search-title');
    if (!resultsDiv) return;
    if (!query.trim()) { resultsDiv.innerHTML = ''; if (titleDiv) titleDiv.style.display = 'none'; return; }
    this._searchTimer = setTimeout(async () => {
      try {
        const results = await mc.memorySearch(query);
        if (titleDiv) titleDiv.style.display = results.length ? '' : 'none';
        if (!results.length) { resultsDiv.innerHTML = '<div class="ai-empty-state">Sin resultados</div>'; return; }
        resultsDiv.innerHTML = results.slice(0, 8).map(en => `
          <div class="ai-mem-item">
            <div class="ai-mem-item-head">
              <span class="ai-mem-item-title">${this.escHtml(en.title)}</span>
              <span class="ai-mem-item-type">${en.type}</span>
            </div>
            <div class="ai-mem-item-summary">${this.escHtml((en.summary || '').slice(0, 90))}</div>
            ${en.url ? `<div class="ai-mem-item-url">${this.escHtml(en.url)}</div>` : ''}
          </div>
        `).join('');
      } catch (e) { console.error('[AI-MEM-SEARCH]', e); }
    }, 300);
  },

  // === REMINDERS ===
  async refreshReminders() {
    try {
      const reminders = await mc.remindersList({ pending: true });
      const container = document.getElementById('ai-reminders-list');
      if (!container) return;
      if (!reminders.length) {
        container.innerHTML = '<div class="ai-empty-state">Sin recordatorios pendientes</div>';
        return;
      }
      container.innerHTML = reminders.map(r => `
        <div class="ai-rm-item ${r.completed ? 'done' : ''}" data-id="${r.id}">
          <div class="ai-rm-check">${r.completed ? '✓' : ''}</div>
          <span class="ai-rm-text">${this.escHtml(r.text)}</span>
          <span class="ai-rm-del" onclick="event.stopPropagation();AI.deleteReminder('${r.id}')" title="Eliminar">✕</span>
        </div>
      `).join('');
      container.querySelectorAll('.ai-rm-item').forEach(item => {
        item.addEventListener('click', () => this.completeReminder(item.dataset.id));
      });
    } catch (e) { console.error('[AI-RM]', e); }
  },

  async addReminder() {
    const text = prompt('¿Qué querés que recuerde?');
    if (!text) return;
    try {
      await mc.remindersAdd({ text });
      this.appendMsg('system', `⏰ Recordatorio creado: ${text}`);
      this.refreshReminders();
    } catch (e) { console.error('[AI-RM-ADD]', e); }
  },

  async completeReminder(id) {
    try {
      await mc.remindersComplete(id);
      this.appendMsg('system', '✓ Recordatorio completado');
      this.refreshReminders();
    } catch (e) { console.error('[AI-RM-COMP]', e); }
  },

  async deleteReminder(id) {
    try {
      await mc.remindersDelete(id);
      this.refreshReminders();
    } catch (e) { console.error('[AI-RM-DEL]', e); }
  },

  // === CONSENT DIALOG ===
  _consentCb: null,
  showConsent(msg) {
    return new Promise(resolve => {
      this._consentCb = resolve;
      const dialog = document.getElementById('ai-consent-dialog');
      const msgEl = document.getElementById('ai-consent-msg');
      if (msgEl) msgEl.textContent = typeof msg === 'string' ? msg : '¿Querés autorizar esta acción?';
      if (dialog) dialog.style.display = 'block';
    });
  },
  consentResponse(approved) {
    const dialog = document.getElementById('ai-consent-dialog');
    if (dialog) dialog.style.display = 'none';
    if (this._consentCb) { this._consentCb(approved); this._consentCb = null; }
  },

  // === CHAT SESSION PERSISTENCE ===
  /** Obtiene la URL del proyecto/pestaña activa */
  _getProjectUrl() {
    const url = document.getElementById('urlinput')?.value || '';
    if (!url || url === 'mc://newtab') return '';
    try { return new URL(url).hostname || url; } catch { return url; }
  },

  async initSessions() {
    try {
      this._sessions = await mc.aiChatSessionsList() || [];
    } catch { this._sessions = []; }
    this._currentProjectUrl = this._getProjectUrl();
    // Si hay URL activa, buscar sesión vinculada a ese proyecto
    if (this._currentProjectUrl) {
      const linked = this._sessions.find(s => s.projectUrl === this._currentProjectUrl);
      if (linked) {
        try {
          const res = await mc.aiChatSessionsLoad({ id: linked.id });
          if (res?.ok && res.session) {
            this._sessionId = res.session.id;
            this._sessionName = res.session.name;
            this.msgs = res.session.messages || [];
            this._renderSessionBar();
            this._renderSessionList();
            for (const m of this.msgs) {
              if (m.role === 'user' || m.role === 'assistant') {
                this.appendMsg(m.role, m.content);
              }
            }
            if (this.msgs.length) this._greeted = true;
            addSidebarLog('info', `[CHAT] Sesión del proyecto cargada: "${this._sessionName}" (${this.msgs.length} msgs)`);
            return;
          }
        } catch {}
      }
    }
    // Sin sesión vinculada — crear nueva sin mensajes
    this.newSession(false);
  },

  newSession(showMsg = true) {
    this._sessionId = 'ses_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    this._currentProjectUrl = this._getProjectUrl();
    const projLabel = this._currentProjectUrl ? ` — ${this._currentProjectUrl}` : '';
    this._sessionName = 'Sesión ' + new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + projLabel;
    this.msgs = [];
    const msgsEl = document.getElementById('ai-msgs');
    if (msgsEl) msgsEl.innerHTML = '';
    localStorage.setItem('mc_ai_last_session', this._sessionId);
    this._renderSessionBar();
    this._renderSessionList();
    if (showMsg) this.appendMsg('assistant', '¡Nueva sesión! ¿En qué puedo ayudarte?');
    // Guardar en disco con projectUrl
    mc.aiChatSessionsSave({ id: this._sessionId, name: this._sessionName, messages: [], projectUrl: this._currentProjectUrl }).catch(() => {});
    if (showMsg) addSidebarLog('info', `[CHAT] Nueva sesión creada` + (this._currentProjectUrl ? ` para ${this._currentProjectUrl}` : ''));
  },

  async loadSession(id) {
    if (id === this._sessionId) return;
    // Guardar la actual antes de cambiar
    await this._persistSession();
    try {
      const res = await mc.aiChatSessionsLoad({ id });
      if (!res?.ok) return;
      this._sessionId = res.session.id;
      this._sessionName = res.session.name;
      this._currentProjectUrl = res.session.projectUrl || this._getProjectUrl();
      this.msgs = res.session.messages || [];
      localStorage.setItem('mc_ai_last_session', id);
      // Limpiar UI y restaurar mensajes
      const msgsEl = document.getElementById('ai-msgs');
      if (msgsEl) msgsEl.innerHTML = '';
      for (const m of this.msgs) {
        if (m.role === 'user' || m.role === 'assistant') {
          this.appendMsg(m.role, m.content);
        }
      }
      this._renderSessionBar();
      addSidebarLog('info', `[CHAT] Sesión cargada: "${this._sessionName}" (${this.msgs.length} msgs)`);
    } catch (e) {
      addSidebarLog('error', `[CHAT] Error cargando sesión: ${e.message}`);
    }
  },

  async _persistSession() {
    if (!this._sessionId || !this.msgs.length) return;
    try {
      await mc.aiChatSessionsSave({ id: this._sessionId, name: this._sessionName, messages: this.msgs, projectUrl: this._currentProjectUrl || this._getProjectUrl() });
    } catch {}
  },

  scheduleAutoSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._persistSession(), 2000);
  },

  async deleteSessionPrompt() {
    if (!this._sessionId) return;
    const name = this._sessionName;
    if (!confirm(`¿Eliminar "${name}"?`)) return;
    try {
      await mc.aiChatSessionsDelete({ id: this._sessionId });
      addSidebarLog('info', `[CHAT] Sesión eliminada: "${name}"`);
    } catch {}
    this._sessions = this._sessions.filter(s => s.id !== this._sessionId);
    this._renderSessionList();
    // Si quedan sesiones, cargar la última; si no, nueva
    if (this._sessions.length > 0) {
      await this.loadSession(this._sessions[0].id);
    } else {
      this.newSession(false);
    }
  },

  renameSessionPrompt() {
    const name = prompt('Nombre de la sesión:', this._sessionName);
    if (!name || name === this._sessionName) return;
    this._sessionName = name;
    this._renderSessionBar();
    mc.aiChatSessionsRename({ id: this._sessionId, name }).catch(() => {});
    addSidebarLog('info', `[CHAT] Sesión renombrada: "${name}"`);
  },

  toggleSessionList() {
    const el = document.getElementById('ai-session-list');
    if (!el) return;
    if (el.style.display === 'none') {
      this._renderSessionList();
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  },

  async _renderSessionList() {
    const el = document.getElementById('ai-session-list');
    if (!el) return;
    try { this._sessions = await mc.aiChatSessionsList() || []; } catch {}
    if (!this._sessions.length) {
      el.innerHTML = '<div style="padding:8px;text-align:center;color:var(--muted);font-size:11px;">No hay sesiones anteriores</div>';
      return;
    }
    el.innerHTML = this._sessions.map(s => {
      const active = s.id === this._sessionId ? 'background:rgba(255,255,255,0.08);' : '';
      const date = s.updatedAt ? new Date(s.updatedAt).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      const proj = s.projectUrl ? `<span style="color:var(--accent);font-size:9px;">🌐 ${this.escHtml(s.projectUrl)}</span>` : '';
      return `<div style="padding:6px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);${active}font-size:11px;display:flex;flex-direction:column;gap:2px;" onclick="AI.loadSession('${s.id}');document.getElementById('ai-session-list').style.display='none';">\n        <div style="display:flex;gap:6px;align-items:center;"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escHtml(s.name)}</span>\n        <span style="color:var(--muted);font-size:9px;white-space:nowrap;">${s.msgCount || 0} msgs · ${date}</span></div>\n        ${proj}\n      </div>`;
    }).join('');
  },

  _renderSessionBar() {
    const nameEl = document.getElementById('ai-session-name');
    if (nameEl) {
      nameEl.textContent = this._sessionName || 'Nueva sesión';
      nameEl.title = this._currentProjectUrl ? `${this._sessionName}\nProyecto: ${this._currentProjectUrl}` : (this._sessionName || 'Nueva sesión');
    }
  },

  escHtml(text) {
    return String(text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
};

// ════════════════════════════════════════════════════════
//  WebChat — Sidebar dedicado a chats web (Copilot, ChatGPT, etc.)
//  Funciona como el Copilot de Edge: panel derecho con webview
//  y capacidad de inyectar contexto de la página activa.
// ════════════════════════════════════════════════════════

const WCH_PROVIDERS = [
  { id: 'copilot',  label: 'Copilot',  url: 'https://copilot.microsoft.com' },
  { id: 'chatgpt',  label: 'ChatGPT',  url: 'https://chatgpt.com' },
  { id: 'claude',   label: 'Claude',   url: 'https://claude.ai' },
  { id: 'gemini',   label: 'Gemini',   url: 'https://gemini.google.com' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://perplexity.ai' },
];

const WebChat = {
  _wv: null,
  _active: null,
  _ready: false,
  _contextTimer: null,
  _lastAuthRefreshAt: 0,
  _lastAuthRefreshUrl: '',

  _bg: { data: null },
  _bgDefault: null,

  init() {
    this.injectSidebar();
    this.loadBg();
    if (typeof mc !== 'undefined' && mc?.on) {
      mc.on('auth-session-updated', () => this.refreshSession());
    }
  },

  injectSidebar() {
    try {
    if (document.getElementById('webchat-sidebar')) return;

    const sb = document.createElement('div');
    sb.id = 'webchat-sidebar';
    sb.innerHTML = `
      <div id="wch-bg"></div>
      <div class="wch-header">
        <span class="wch-title">🌐 Asistente Web</span>
        <button class="wch-close" onclick="WebChat.close()" title="Cerrar">&times;</button>
      </div>
      <div class="wch-provider-row" id="wch-providers"></div>
      <div class="wch-actions">
        <button class="wch-action-btn" onclick="WebChat.attachPage()" title="Enviar contexto de la página activa al chat">📋 Adjuntar página</button>
        <button class="wch-action-btn" onclick="WebChat.attachSelection()" title="Enviar selección de texto al chat">✂️ Selección</button>
        <button class="wch-action-btn" onclick="WebChat.reload()" title="Recargar chat">🔄</button>
        <button class="wch-action-btn" onclick="WebChat.clearData()" title="Borrar cookies/caché/datos de este panel (sesión propia, no afecta al resto del navegador)">🧹</button>
      </div>
      <details id="wch-bg-cfg" style="flex-shrink:0;">
        <summary style="font-size:11px;color:var(--muted2);cursor:pointer;user-select:none;padding:8px 12px;border-top:1px solid var(--border);">🎨 Fondo del panel</summary>
        <div style="padding:8px 12px;font-size:11px;">
          <div style="margin-bottom:6px;">
            <input type="file" id="wch-bg-file" accept="image/*" style="width:100%;color:var(--muted);font-size:10px;" onchange="WebChat.handleBgFile(event)">
          </div>
          <div class="input-row" style="gap:4px;flex-wrap:wrap;">
            <input class="text-input" id="wch-bg-url" placeholder="URL de imagen" style="flex:1;font-size:10px;" onkeydown="if(event.key==='Enter')WebChat.applyBgUrl()">
            <button class="btn btn-sm ghost" onclick="WebChat.applyBgUrl()" style="font-size:9px;">OK</button>
            <button class="btn btn-sm ghost" onclick="WebChat.clearBg()" style="font-size:9px;">✕</button>
          </div>
        </div>
      </details>
    `;
    const main = document.getElementById('main');
    if (main) main.appendChild(sb);
    else document.body.appendChild(sb);
    PanelResize.attach(sb, 'mc-panel-w-webchat', 400);

    this._wv = null;
    this.renderProviders();
    this._active = 'copilot';
    } catch(e) { console.error('[WebChat] injectSidebar:', e); }
  },

  ensureWebview() {
    if (this._wv) return this._wv;
    const wv = document.createElement('webview');
    wv.id = 'wch-wv';
    wv.setAttribute('partition', 'persist:mc-webchat');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('allow', 'autoplay; media; encrypted-media; clipboard-read; clipboard-write');
    wv.setAttribute('webpreferences', 'contextIsolation=no,nodeIntegration=no');
    document.getElementById('webchat-sidebar')?.appendChild(wv);
    this._wv = wv;
    this.bindEvents();
    return wv;
  },

  renderProviders() {
    const container = document.getElementById('wch-providers');
    if (!container) return;
    container.innerHTML = WCH_PROVIDERS.map(p =>
      `<button class="wch-prov-btn" data-prov="${p.id}" onclick="WebChat.setActive('${p.id}')">${p.label}</button>`
    ).join('');
  },

  setActive(id) {
    const prov = WCH_PROVIDERS.find(p => p.id === id);
    if (!prov) return;
    this._active = id;
    document.querySelectorAll('.wch-prov-btn').forEach(b => b.classList.toggle('active', b.dataset.prov === id));
    const wv = this.ensureWebview();
    if (!wv) return;
    // Cargar vía loadURL para reutilizar el mismo webview y evitar la sensación
    // de pantalla negra o esperar a que el DOM del webview se vuelva a crear.
    let current = '';
    try { current = wv.getURL() || ''; } catch {}
    const targetHost = (() => { try { return new URL(prov.url).hostname; } catch { return ''; } })();
    const currentHost = (() => { try { return new URL(current).hostname; } catch { return ''; } })();
    if (current !== prov.url && currentHost !== targetHost) {
      try { wv.loadURL(prov.url); } catch { wv.setAttribute('src', prov.url); }
    }
    this._pendingUrl = prov.url;
  },

  bindEvents() {
    const wv = this._wv;
    if (!wv) return;

    wv.addEventListener('dom-ready', () => {
      this._ready = true;
      let url = '';
      try { url = wv.getURL() || ''; } catch {}
      if ((url === 'about:blank' || !url) && this._pendingUrl) {
        wv.loadURL(this._pendingUrl);
      }
    });

    wv.addEventListener('did-navigate', () => {
      this.injectContextElement();
    });

    wv.addEventListener('did-finish-load', () => {
      this.injectContextElement();
    });

    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      const wv = this._wv;
      if (wv && e.url) wv.loadURL(e.url);
    });

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) {
        console.error('[WebChat] fail load:', e.errorDescription, e.url);
      }
    });

    wv.addEventListener('permissionrequest', (e) => {
      e.request.allow();
    });
  },

  // Inyecta un div oculto con contexto actualizado de pestañas
  injectContextElement() {
    const wv = this._wv;
    if (!wv) return;
    try {
      const ctx = this.getContextJSON();
      wv.executeJavaScript(`
        (function(){
          var el = document.getElementById('__mc-ctx-data');
          if (!el) {
            el = document.createElement('div');
            el.id = '__mc-ctx-data';
            el.style.display = 'none';
            document.body.appendChild(el);
          }
          el.textContent = ${ctx};
          el.dataset.context = ${ctx};
        })()
      `).catch(() => {});
    } catch (e) {}
  },

  getContextJSON() {
    try {
      const tabs = typeof window.__mcGetTabs === 'function' ? window.__mcGetTabs() : [];
      const activeId = typeof window.__mcGetActiveTabId === 'function' ? window.__mcGetActiveTabId() : null;
      const url = document.getElementById('urlinput')?.value || '';
      return JSON.stringify({
        timestamp: new Date().toISOString(),
        totalTabs: tabs.length,
        activeTabId: activeId,
        activeTabUrl: url,
        tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.id === activeId }))
      });
    } catch { return '{}'; }
  },

  toggle() {
    const sb = document.getElementById('webchat-sidebar');
    if (!sb) return;
    const opening = !sb.classList.contains('open');
    sb.classList.toggle('open');
    if (opening) {
      // cerrar otros paneles
      const aiSb = document.getElementById('ai-sidebar');
      if (aiSb) aiSb.classList.remove('open');
      const aiBtn = document.getElementById('chat-toggle-ai');
      if (aiBtn) { aiBtn.className = 'chat-toggle closed'; aiBtn.innerHTML = '&#9664;'; aiBtn.title = 'Abrir IA'; }
      const waSb = document.getElementById('wa-sidebar');
      if (waSb) waSb.classList.remove('open');
      const waBtn = document.getElementById('chat-toggle-wa');
      if (waBtn) { waBtn.className = 'chat-toggle closed'; waBtn.innerHTML = '&#9664;'; waBtn.title = 'Abrir WhatsApp (Ctrl+Shift+Q)'; }
      document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
      const btn = document.getElementById('webchat-btn');
      if (btn) btn.classList.add('active');
      this.ensureWebview();
      if (!this._contextTimer) this._contextTimer = setInterval(() => this.injectContextElement(), 3000);
      // cargar provider activo (setActive carga vía src directamente)
      if (this._wv && this._active) {
        this.setActive(this._active);
      }
    } else {
      this.close();
      return;
    }
    // sync edge toggle
    const btn = document.getElementById('chat-toggle-web');
    if (btn) {
      btn.className = 'chat-toggle ' + (opening ? 'open' : 'closed');
      btn.innerHTML = opening ? '&#9654;' : '&#9664;';
      btn.title = opening ? 'Cerrar' : 'Abrir WebChat (Ctrl+Shift+W)';
    }
  },

  close() {
    const sb = document.getElementById('webchat-sidebar');
    if (sb) {
      sb.classList.remove('open');
      PanelResize.reset(sb, 'mc-panel-w-webchat', 400);
    }
    destroyEmbeddedWebview(this._wv);
    this._wv = null;
    this._ready = false;
    this._pendingUrl = '';
    if (this._contextTimer) {
      clearInterval(this._contextTimer);
      this._contextTimer = null;
    }
    document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('chat-toggle-web');
    if (btn) { btn.className = 'chat-toggle closed'; btn.innerHTML = '&#9664;'; btn.title = 'Abrir WebChat (Ctrl+Shift+W)'; }
  },

  reload() {
    const wv = this._wv;
    if (wv && this._ready) wv.reload();
  },

  async clearData() {
    if (!confirm('¿Borrar cookies, caché y datos guardados del panel WebChat?\n\nEsto va a cerrar la sesión en Copilot/ChatGPT/Claude/Gemini/Perplexity dentro de este panel (no afecta al resto del navegador).')) return;
    try {
      const res = await mc.clearWebchatData();
      if (res?.ok) {
        const wv = this._wv;
        if (wv) { try { wv.loadURL('about:blank'); } catch {} }
        this._active = null;
      } else {
        alert('No se pudo borrar: ' + (res?.error || 'error desconocido'));
      }
    } catch (e) { alert('No se pudo borrar: ' + e.message); }
  },

  refreshSession() {
    const wv = this._wv;
    if (!wv || !this._ready || !wv.getURL || typeof wv.reload !== 'function') return;
    let currentUrl = '';
    try { currentUrl = wv.getURL() || ''; } catch {}
    if (!/^https?:\/\//i.test(currentUrl) || currentUrl === 'about:blank') return;
    const isLoginPage = /\/signin|\/login|\/auth|\/oauth|\/account|\/challenge/i.test(currentUrl);
    const now = Date.now();
    if (isLoginPage && (now - this._lastAuthRefreshAt > 5000 || this._lastAuthRefreshUrl !== currentUrl)) {
      this._lastAuthRefreshAt = now;
      this._lastAuthRefreshUrl = currentUrl;
      setTimeout(() => {
        try { wv.reload(); } catch {}
      }, 500);
    }
  },

  // ── Background ──
  loadBg() {
    try {
      const raw = localStorage.getItem('mc-wch-bg');
      if (raw) this._bg = JSON.parse(raw);
    } catch {}
    if (this._bg.data) this.applyBg(this._bg.data);
  },
  saveBg() {
    try { localStorage.setItem('mc-wch-bg', JSON.stringify(this._bg)); } catch {}
  },
  applyBg(data) {
    const bg = document.getElementById('wch-bg');
    if (!bg) return;
    const sb = document.getElementById('webchat-sidebar');
    if (!data) {
      bg.style.backgroundImage = '';
      if (sb) { sb.style.background = ''; sb.classList.remove('has-bg'); }
      return;
    }
    bg.style.backgroundImage = 'url("' + data + '")';
    if (sb) { sb.style.background = 'transparent'; sb.classList.add('has-bg'); }
  },
  handleBgFile(e) {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      this._bg.data = ev.target.result;
      this.saveBg();
      this.applyBg(this._bg.data);
    };
    reader.readAsDataURL(file);
  },
  applyBgUrl() {
    const url = document.getElementById('wch-bg-url')?.value?.trim();
    if (!url) return;
    this._bg.data = url;
    this.saveBg();
    this.applyBg(url);
  },
  clearBg() {
    this._bg.data = null;
    this.saveBg();
    this.applyBg(null);
    const inp = document.getElementById('wch-bg-url');
    if (inp) inp.value = '';
    const file = document.getElementById('wch-bg-file');
    if (file) file.value = '';
  },
  // ── Inyección de contexto de página activa ──────────
  async attachPage() {
    const wv = this._wv;
    if (!wv) return;
    try {
      const activeWv = document.querySelector('.tab-webview.active');
      if (!activeWv || !activeWv.getWebContentsId) {
        this.injectFallbackText('(no hay página activa para adjuntar)');
        return;
      }
      const res = await mc.aiPageDom({ webContentsId: activeWv.getWebContentsId() });
      if (!res?.html) {
        this.injectFallbackText('(no se pudo obtener el contenido de la página)');
        return;
      }

      const title = res.title || 'Sin título';
      const url = res.url || 'about:blank';

      // Extraer texto del HTML (versión simplificada)
      const text = this.htmlToText(res.html).slice(0, 8000);

      // Inyectar en el input del chat
      const contextText = `Estoy viendo esta página:\nTítulo: ${title}\nURL: ${url}\n\n${text}\n\n`;
      this.injectIntoChat(contextText);
    } catch (e) {
      console.error('[WebChat] attachPage error:', e);
      this.injectFallbackText('(error al obtener contexto: ' + e.message + ')');
    }
  },

  async attachSelection() {
    const wv = this._wv;
    if (!wv) return;
    try {
      const activeWv = document.querySelector('.tab-webview.active');
      if (!activeWv || !activeWv.getWebContentsId) return;
      const text = await activeWv.executeJavaScript('window.getSelection()?.toString() || ""');
      if (text) {
        this.injectIntoChat(`Seleccioné el siguiente texto de la página:\n\n${text.slice(0, 5000)}\n\n`);
      } else {
        this.injectFallbackText('(no hay texto seleccionado en la página)');
      }
    } catch (e) {
      console.error('[WebChat] attachSelection error:', e);
    }
  },

  // Inyecta texto en el input/textarea del chat web
  injectIntoChat(text) {
    const wv = this._wv;
    if (!wv) return;
    const escaped = JSON.stringify(text);
    wv.executeJavaScript(`
      (function(){
        var inp = document.querySelector('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]');
        if (!inp) return false;
        if (inp.tagName === 'TEXTAREA' || inp.tagName === 'INPUT') {
          inp.value = ${escaped} + inp.value;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.focus();
        } else if (inp.isContentEditable) {
          inp.textContent = ${escaped} + inp.textContent;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()
    `).then(ok => {
      if (!ok) this.injectFallbackText(text);
    }).catch(() => this.injectFallbackText(text));
  },

  injectFallbackText(text) {
    // usar prompt como fallback
    const wv = this._wv;
    if (!wv) return;
    const escaped = JSON.stringify(text);
    wv.executeJavaScript(`
      (function(){
        var inp = document.querySelector('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]');
        if (!inp) return;
        inp.focus();
        // Try execCommand insertText
        document.execCommand('insertText', false, ${escaped});
      })()
    `).catch(() => {
      // último fallback: notificar al usuario
      alert('Pega este contexto en el chat:\n\n' + text.slice(0, 2000));
    });
  },

  htmlToText(html) {
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Remove script/style
      tmp.querySelectorAll('script, style, noscript, svg, canvas').forEach(e => e.remove());
      return tmp.textContent.replace(/\s+/g, ' ').trim().slice(0, 8000);
    } catch {
      return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 8000);
    }
  }
};

//  WhatsAppChat — Sidebar dedicado a WhatsApp Web
// ════════════════════════════════════════════════════════

const WHATSAPP_URL = 'https://web.whatsapp.com';

const WhatsAppChat = {
  _wv: null,
  _ready: false,
  _zoomFactor: 0.8,

  init() {
    this.injectSidebar();
  },

  injectSidebar() {
    try {
      if (document.getElementById('wa-sidebar')) return;

      const sb = document.createElement('div');
      sb.id = 'wa-sidebar';
      sb.innerHTML = `
        <div class="wch-header">
          <span class="wch-title">💬 WhatsApp Web</span>
          <button class="wch-close" onclick="WhatsAppChat.close()" title="Cerrar">&times;</button>
        </div>
        <div class="wch-actions">
          <button class="wch-action-btn" onclick="WhatsAppChat.reload()" title="Recargar WhatsApp">🔄</button>
          <button class="wch-action-btn" onclick="WhatsAppChat.openInTab()" title="Abrir WhatsApp en una pestaña">↗ Pestaña</button>
        </div>
      `;
      const main = document.getElementById('main');
      if (main) main.appendChild(sb);
      else document.body.appendChild(sb);
      PanelResize.attach(sb, 'mc-panel-w-wa', 480);

      this._wv = null;
    } catch (e) {
      console.error('[WhatsAppChat] injectSidebar:', e);
    }
  },

  load() {
    if (!this._wv) {
      const wv = document.createElement('webview');
      wv.id = 'wa-wv';
      wv.setAttribute('src', WHATSAPP_URL);
      wv.setAttribute('partition', 'persist:mc-whatsapp');
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('allow', 'media; encrypted-media');
      wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes,backgroundThrottling=yes,spellcheck=no');
      document.getElementById('wa-sidebar')?.appendChild(wv);
      this._wv = wv;
      this.bindEvents();
      return;
    }
    try {
      const currentUrl = this._wv.getURL();
      if (currentUrl === 'about:blank' || !currentUrl) this._wv.loadURL(WHATSAPP_URL);
    } catch {
      try { this._wv.setAttribute('src', WHATSAPP_URL); } catch {}
    }
  },

  bindEvents() {
    const wv = this._wv;
    if (!wv) return;

    const applyLayout = () => {
      try { wv.setZoomFactor(this._zoomFactor); } catch {}
      wv.executeJavaScript(`(() => {
        const style = document.getElementById('__mc-wa-layout');
        if (style) return;
        const el = document.createElement('style');
        el.id = '__mc-wa-layout';
        el.textContent = 'html,body{overflow-x:auto!important;}';
        document.head.appendChild(el);
      })()`).catch(() => {});
    };

    wv.addEventListener('dom-ready', () => {
      this._ready = true;
      applyLayout();
      if (wv.getURL() === 'about:blank') this.load();
    });

    wv.addEventListener('did-finish-load', applyLayout);

    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      if (e.url && this._wv) this._wv.loadURL(e.url);
    });

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) {
        console.error('[WhatsAppChat] fail load:', e.errorDescription, e.url);
      }
    });

    wv.addEventListener('permissionrequest', (e) => {
      e.request.allow();
    });
  },

  toggle() {
    const sb = document.getElementById('wa-sidebar');
    if (!sb) return;
    const opening = !sb.classList.contains('open');
    sb.classList.toggle('open');
    if (opening) {
      // cerrar otros paneles
      const aiSb = document.getElementById('ai-sidebar');
      if (aiSb) aiSb.classList.remove('open');
      const aiBtn = document.getElementById('chat-toggle-ai');
      if (aiBtn) { aiBtn.className = 'chat-toggle closed'; aiBtn.innerHTML = '&#9664;'; aiBtn.title = 'Abrir IA (Ctrl+Shift+A)'; }
      const wcSb = document.getElementById('webchat-sidebar');
      if (wcSb) wcSb.classList.remove('open');
      const wcBtn = document.getElementById('chat-toggle-web');
      if (wcBtn) { wcBtn.className = 'chat-toggle closed'; wcBtn.innerHTML = '&#9664;'; wcBtn.title = 'Abrir WebChat (Ctrl+Shift+W)'; }
      document.querySelectorAll('.tnbtn').forEach(b => b.classList.remove('active'));
      this.load();
      window.WhatsAppExtractor?.activate?.();
    } else {
      this.close();
      return;
    }
    const btn = document.getElementById('chat-toggle-wa');
    if (btn) {
      btn.className = 'chat-toggle ' + (opening ? 'open' : 'closed');
      btn.innerHTML = opening ? '&#9654;' : '&#9664;';
      btn.title = opening ? 'Cerrar' : 'Abrir WhatsApp (Ctrl+Shift+Q)';
    }
  },

  close() {
    const sb = document.getElementById('wa-sidebar');
    if (sb) {
      sb.classList.remove('open');
      PanelResize.reset(sb, 'mc-panel-w-wa', 480);
    }
    destroyEmbeddedWebview(this._wv);
    window.WhatsAppExtractor?.deactivate?.();
    this._wv = null;
    this._ready = false;
    const btn = document.getElementById('chat-toggle-wa');
    if (btn) { btn.className = 'chat-toggle closed'; btn.innerHTML = '&#9664;'; btn.title = 'Abrir WhatsApp (Ctrl+Shift+Q)'; }
  },

  reload() {
    const wv = this._wv;
    if (wv && this._ready) wv.reload();
  },

  openInTab() {
    const url = this._wv?.getURL?.() || WHATSAPP_URL;
    if (typeof window.addTab === 'function') {
      window.addTab(url);
    } else if (typeof loadUrl === 'function') {
      loadUrl(url);
    }
  }
};

AI.init();
WebChat.init();
WhatsAppChat.init();
window.AI = AI;
window.WebChat = WebChat;
window.PanelResize = PanelResize;
window.WhatsAppChat = WhatsAppChat;
