'use strict';
const { ipcMain, BrowserWindow, session, safeStorage, app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Safe logging — evita EPIPE cuando stdout/stderr están redirigidos a pipe roto
function safeLog(...args) { try { console.log(...args); } catch {} }
function safeErr(...args) { try { console.error(...args); } catch {} }

// ── Encrypt/decrypt API keys usando safeStorage (DPAPI en Windows) ──
const SENSITIVE_KEYS = ['opencodeKey', 'groqKey', 'openaiKey', 'geminiKey'];

function encryptCfg(cfg) {
  if (!cfg || !safeStorage.isEncryptionAvailable()) return cfg;
  const out = { ...cfg };
  for (const k of SENSITIVE_KEYS) {
    if (out[k]) {
      try { out[k] = safeStorage.encryptString(out[k]).toString('base64') + '.enc'; }
      catch {}
    }
  }
  return out;
}

function decryptCfg(cfg) {
  if (!cfg) return cfg;
  const out = { ...cfg };
  for (const k of SENSITIVE_KEYS) {
    const v = out[k];
    if (v && typeof v === 'string' && v.endsWith('.enc')) {
      try {
        const buf = Buffer.from(v.slice(0, -4), 'base64');
        out[k] = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '';
      } catch { out[k] = ''; }
    }
  }
  return out;
}

// ── PAGE CACHE para Scraping Automático ──────────────────────────────────────
// Almacena análisis automáticos de páginas para que IA los use sin ejecutar dos veces
let PAGE_CACHE = {};
function clearPageCache() { PAGE_CACHE = {}; }
function cachePageAnalysis(url, analysis) {
  PAGE_CACHE[url] = { ...analysis, timestamp: Date.now() };
  // Limpia cache si crece mucho
  const keys = Object.keys(PAGE_CACHE);
  if (keys.length > 50) {
    const oldest = keys.sort((a, b) => (PAGE_CACHE[a].timestamp || 0) - (PAGE_CACHE[b].timestamp || 0))[0];
    delete PAGE_CACHE[oldest];
  }
}
function getPageCache(url) { return PAGE_CACHE[url]; }

// ── AI Providers ──────────────────────────────────────────────────────────────
let _abortController = null;
function abortAI() { if (_abortController) { try { _abortController.abort(); } catch {} _abortController = null; } }

const PROVIDERS = {
  ollama: {
    name: 'Ollama (local)',
    chat: async ({ signal, url, model, messages }) => {
      const res = await fetch(`${url || 'http://localhost:11434'}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'phi3:mini', messages, stream: false }),
        signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.message?.content || JSON.stringify(data);
    }
  },
  gemini: {
    name: 'Gemini API',
    // Modelos que soportan generación de imagen/audio/video
    IMAGE_MODELS: ['gemini-2.0-flash-exp-image-generation', 'gemini-2.5-flash-preview-image-generation', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'],
    chat: async ({ signal, key, model, messages }) => {
      const sysMsg = messages.find(m => m.role === 'system');
      const parts = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      if (sysMsg) parts.unshift({ role: 'user', parts: [{ text: sysMsg.content }] });

      // Detectar si es modelo de generación multimedia
      const isImageModel = /image|nano.?banana/i.test(model || '') || PROVIDERS.gemini.IMAGE_MODELS.includes(model);
      const isAudioModel = /audio|speech|tts/i.test(model || '');

      const body = { contents: parts };
      if (isImageModel) {
        body.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      } else if (isAudioModel) {
        body.generationConfig = { responseModalities: ['TEXT', 'AUDIO'] };
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash'}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);

      // Parsear respuesta multimodal (texto + inlineData)
      const candidate = data.candidates?.[0];
      if (!candidate) return JSON.stringify(data);
      const contentParts = candidate.content?.parts || [];
      const textParts = contentParts.filter(p => p.text).map(p => p.text);
      const mediaParts = contentParts.filter(p => p.inlineData).map(p => {
        const mime = p.inlineData.mimeType || '';
        return {
          mimeType: mime,
          data: p.inlineData.data,
          type: mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio'
              : mime.startsWith('video/') ? 'video' : 'file'
        };
      });
      // Si hay media, devolver respuesta estructurada
      if (mediaParts.length > 0) {
        return JSON.stringify({ type: 'multimodal', text: textParts.join('\n'), media: mediaParts });
      }
      return textParts.join('\n') || JSON.stringify(data);
    }
  },
  groq: {
    name: 'Groq (gratis)',
    chat: async ({ signal, key, model, messages }) => {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'llama-3.1-8b-instant', messages, stream: false }),
        signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.choices?.[0]?.message?.content || JSON.stringify(data);
    }
  },
  openai: {
    name: 'OpenAI',
    chat: async ({ signal, key, model, messages }) => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, stream: false }),
        signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.choices?.[0]?.message?.content || JSON.stringify(data);
    }
  },
  opencode: {
    name: 'OpenCode Zen',
    chat: async ({ signal, key, model, messages }) => {
      const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'big-pickle', messages, stream: false }),
        signal
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data));
      return data.choices?.[0]?.message?.content || JSON.stringify(data);
    }
  }
};

// ── Config (stored in CFG from main) ──────────────────────────────────────────
let _aiCfg = { provider: 'opencode', ollamaUrl: 'http://localhost:11434', ollamaModel: 'phi3:mini', opencodeKey: '', opencodeModel: 'big-pickle' };
let _getMainWin = null;

function getAICfg() { return _aiCfg; }
function setAICfg(cfg) { _aiCfg = { ..._aiCfg, ...cfg }; }

// ── IPC Handlers ──────────────────────────────────────────────────────────────
function setup(ctx) {
  if (!ctx) return;
  _getMainWin = ctx.getMainWin || null;
  _aiCfg = decryptCfg((ctx.aiConfig || ctx.cfg?.aiConfig) || _aiCfg);
  const persist = ctx.saveCfg || (() => {});
  safeLog('[AI-MOD] Config loaded (decrypted):', JSON.stringify({ ..._aiCfg, opencodeKey: _aiCfg.opencodeKey ? '***' : '', groqKey: _aiCfg.groqKey ? '***' : '', openaiKey: _aiCfg.openaiKey ? '***' : '', geminiKey: _aiCfg.geminiKey ? '***' : '' }));
  // Emit initial config to renderer for debugging
  if (ctx.emit) ctx.emit('ai:debug', { type: 'load', cfg: { ..._aiCfg, opencodeKey: _aiCfg.opencodeKey ? '***' : '', groqKey: _aiCfg.groqKey ? '***' : '', openaiKey: _aiCfg.openaiKey ? '***' : '', geminiKey: _aiCfg.geminiKey ? '***' : '' } });

  ipcMain.handle('ai:config:get', () => _aiCfg);
  ipcMain.handle('ai:config:save', (_e, cfg) => {
    _aiCfg = { ..._aiCfg, ...cfg };
    // Encrypt antes de persistir
    if (ctx.cfg) ctx.cfg.aiConfig = encryptCfg(_aiCfg);
    safeLog('[AI-MOD] Config saved (encrypted on disk):', JSON.stringify({ ..._aiCfg, opencodeKey: _aiCfg.opencodeKey ? '***' : '', groqKey: _aiCfg.groqKey ? '***' : '', openaiKey: _aiCfg.openaiKey ? '***' : '', geminiKey: _aiCfg.geminiKey ? '***' : '' }));
    persist();
    if (ctx.emit) ctx.emit('ai:debug', { type: 'save', cfg: { ..._aiCfg, opencodeKey: _aiCfg.opencodeKey ? '***' : '', groqKey: _aiCfg.groqKey ? '***' : '', openaiKey: _aiCfg.openaiKey ? '***' : '', geminiKey: _aiCfg.geminiKey ? '***' : '' } });
    return _aiCfg;
  });

  ipcMain.handle('ai:chat', async (_e, opts) => {
    _abortController = new AbortController();
    try {
      const { messages, system } = opts || {};
      if (!messages || !messages.length) return { error: 'Sin mensajes' };

      const prov = PROVIDERS[_aiCfg.provider];
      if (!prov) return { error: `Proveedor "${_aiCfg.provider}" no soportado` };

      const full = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const result = await prov.chat({
        signal: _abortController.signal,
        url: _aiCfg.ollamaUrl,
        model: _aiCfg.provider === 'ollama' ? _aiCfg.ollamaModel
             : _aiCfg.provider === 'gemini' ? _aiCfg.geminiModel
             : _aiCfg.provider === 'groq' ? _aiCfg.groqModel
             : _aiCfg.provider === 'opencode' ? _aiCfg.opencodeModel
             : _aiCfg.openaiModel,
        key: _aiCfg.provider === 'gemini' ? _aiCfg.geminiKey
            : _aiCfg.provider === 'groq' ? _aiCfg.groqKey
            : _aiCfg.provider === 'opencode' ? _aiCfg.opencodeKey
            : _aiCfg.openaiKey,
        messages: full
      });
      // Detectar respuesta multimodal (JSON con type: 'multimodal')
      try {
        const parsed = JSON.parse(result);
        if (parsed.type === 'multimodal') {
          return { text: parsed.text, media: parsed.media };
        }
      } catch {}
      return { text: result };
    } catch (err) {
      if (err.name === 'AbortError') return { aborted: true, error: 'Cancelado' };
      return { error: err.message };
    } finally {
      _abortController = null;
    }
  });

  ipcMain.handle('ai:chat:abort', () => { abortAI(); return { ok: true }; });

  // Guardar media generada por IA (imagen, audio, video)
  ipcMain.handle('ai:media:save', async (_e, { data, mimeType, filename }) => {
    try {
      const ext = mimeType?.includes('png') ? '.png' : mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? '.jpg'
        : mimeType?.includes('gif') ? '.gif' : mimeType?.includes('webp') ? '.webp'
        : mimeType?.includes('mp3') ? '.mp3' : mimeType?.includes('wav') ? '.wav'
        : mimeType?.includes('mp4') ? '.mp4' : mimeType?.includes('webm') ? '.webm'
        : mimeType?.includes('ogg') ? '.ogg' : '.bin';
      const dlDir = (CFG && CFG.downloadDir) || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const fname = filename || `mc-ai-media-${Date.now()}${ext}`;
      const fpath = path.join(dlDir, fname);
      fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
      safeLog('[AI-MEDIA] Saved:', fpath);
      return { ok: true, path: fpath, filename: fname };
    } catch (err) {
      safeErr('[AI-MEDIA] Error:', err.message);
      return { error: err.message };
    }
  });

  // ── Estado persistente del laboratorio (disco, no localStorage) ──
  const LAB_STATE_PATH = path.join(app.getPath('userData'), 'lab-state.json');

  ipcMain.handle('lab:state:save', async (_e, labState) => {
    try {
      const dir = path.dirname(LAB_STATE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LAB_STATE_PATH, JSON.stringify(labState, null, 2), 'utf8');
      safeLog('[LAB-STATE] Saved:', LAB_STATE_PATH);
      return { ok: true };
    } catch (err) {
      safeErr('[LAB-STATE] Save error:', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('lab:state:load', async () => {
    try {
      if (fs.existsSync(LAB_STATE_PATH)) {
        const data = JSON.parse(fs.readFileSync(LAB_STATE_PATH, 'utf8'));
        safeLog('[LAB-STATE] Loaded:', LAB_STATE_PATH);
        return { ok: true, state: data };
      }
      return { ok: false };
    } catch (err) {
      safeErr('[LAB-STATE] Load error:', err.message);
      return { error: err.message };
    }
  });

  // Capturar laboratorio web como imagen (PNG/JPEG)
  ipcMain.handle('lab:capture', async (_e, { html, width, height, format, delay }) => {
    const { BrowserWindow } = require('electron');
    let win = null;
    try {
      const w = Math.min(Math.max(width || 1280, 320), 3840);
      const h = Math.min(Math.max(height || 800, 200), 2160);
      const fmt = format === 'jpeg' ? 'jpeg' : 'png';

      win = new BrowserWindow({
        width: w, height: h,
        show: false,
        offscreen: true,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          javascript: true
        }
      });

      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html || '<html><body></body></html>'));
      // Esperar a que renderice (animaciones, fonts, etc.)
      const waitMs = Math.min(Math.max(delay || 500, 100), 5000);
      await new Promise(r => setTimeout(r, waitMs));

      const image = await win.webContents.capturePage();
      const buf = fmt === 'jpeg'
        ? image.toJPEG(92)
        : image.toPNG();

      const b64 = buf.toString('base64');
      const mimeType = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
      safeLog(`[LAB-CAPTURE] ${w}x${h} ${fmt} → ${buf.length} bytes`);
      return { ok: true, data: b64, mimeType, width: w, height: h, size: buf.length };
    } catch (err) {
      safeErr('[LAB-CAPTURE] Error:', err.message);
      return { error: err.message };
    } finally {
      if (win) { try { win.destroy(); } catch {} }
    }
  });

  // ── Lab Recording via offscreen capturePage ──
  let _labRecTimer = null;
  let _labRecFrameCount = 0;

  // Captura directa del iframe visible del Lab (incluye interacción del usuario)
  ipcMain.handle('lab:rec:start', async (event, { bounds }) => {
    try {
      if (_labRecTimer) { _labRecTimer.running = false; _labRecTimer = null; }
      const _mainWin = _getMainWin ? _getMainWin() : null;
      if (!_mainWin || _mainWin.isDestroyed()) return { ok: false, error: 'Ventana principal no disponible' };
      _labRecFrameCount = 0;
      const sender = event.sender;
      // bounds = { x, y, width, height } del iframe en CSS pixels del renderer
      const b = bounds || { x: 0, y: 0, width: 800, height: 600 };
      _labRecTimer = { running: true };
      (async function captureLoop() {
        while (_labRecTimer && _labRecTimer.running) {
          const t0 = Date.now();
          try {
            // Capturar toda la ventana y enviar bounds para recortar en el renderer
            const image = await _mainWin.webContents.capturePage();
            const buf = image.toJPEG(75);
            const b64 = buf.toString('base64');
            if (!sender.isDestroyed()) {
              sender.send('lab:rec:frame', { index: _labRecFrameCount++, data: b64, bounds: b });
            }
          } catch (e) { safeErr('[LAB-REC] frame error:', e.message); }
          const elapsed = Date.now() - t0;
          const wait = Math.max(10, 33 - elapsed);
          await new Promise(r => setTimeout(r, wait));
        }
      })();
      safeLog(`[LAB-REC] Started capturing visible lab area (${b.width}x${b.height})`);
      return { ok: true };
    } catch (e) { safeErr('[LAB-REC] Start error:', e.message); return { ok: false, error: e.message }; }
  });

  ipcMain.handle('lab:rec:stop', async () => {
    if (_labRecTimer) { _labRecTimer.running = false; _labRecTimer = null; }
    const count = _labRecFrameCount;
    safeLog(`[LAB-REC] Stopped: ${count} frames`);
    return { ok: true, frameCount: count };
  });

  ipcMain.handle('ai:models', async () => {
    try {
      const prov = _aiCfg.provider;
      if (prov === 'opencode') {
        const key = _aiCfg.opencodeKey;
        if (!key) return { error: 'API key de OpenCode Zen no configurada' };
        const res = await fetch('https://opencode.ai/zen/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { models: Array.isArray(data) ? data : data.data || [] };
      }
      if (prov === 'groq') {
        const key = _aiCfg.groqKey;
        if (!key) return { error: 'API key de Groq no configurada' };
        const res = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { models: (data.data || []).map(m => ({ id: m.id, owned_by: m.owned_by })) };
      }
      if (prov === 'ollama') {
        const url = _aiCfg.ollamaUrl || 'http://localhost:11434';
        const res = await fetch(`${url}/api/tags`);
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { models: (data.models || []).map(m => ({ id: m.name })) };
      }
      if (prov === 'openai') {
        const key = _aiCfg.openaiKey;
        if (!key) return { error: 'API key de OpenAI no configurada' };
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { models: (data.data || []).filter(m => m.id.startsWith('gpt-') || m.id.startsWith('o')).map(m => ({ id: m.id })) };
      }
      if (prov === 'gemini') {
        const key = _aiCfg.geminiKey;
        if (!key) return { error: 'API key de Gemini no configurada' };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        return { models: (data.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => ({ id: m.name.replace('models/', '') })) };
      }
      return { models: [] };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AI Downloader (no requiere yt-dlp) ────────────
  const emit = ctx.emit || (() => {});
  const dlDir = ctx.cfg?.downloadDir || '.';

  function resolveUrl(base, segment) {
    if (segment.startsWith('http://') || segment.startsWith('https://')) return segment;
    const u = new URL(base);
    if (segment.startsWith('/')) return u.origin + segment;
    return u.origin + u.pathname.replace(/\/[^/]*$/, '/') + segment;
  }

  async function downloadSegment(url) {
    const res = await fetch(url, { headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function downloadHLS(manifestUrl) {
    emit('ai:dl:log', 'Obteniendo manifiesto…');
    const manifestText = await (await fetch(manifestUrl, {
      headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' }
    })).text();

    if (!manifestText.includes('#EXTM3U')) throw new Error('No es un manifiesto HLS válido');

    // Si es master playlist, tomar la variante de mejor calidad
    const variantMatch = manifestText.match(/#EXT-X-STREAM-INF[^]*?RESOLUTION=(\d+)x(\d+)[^]*?\n([^\n]+)/g);
    let playlistUrl = manifestUrl;
    if (variantMatch) {
      emit('ai:dl:log', 'Manifiesto maestro detectado, seleccionando mejor calidad…');
      let bestRes = 0;
      let bestUrl = '';
      for (const block of manifestText.split('#EXT-X-STREAM-INF')) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;
        const attrs = lines[0];
        const segUrl = lines[1]?.trim();
        if (!segUrl) continue;
        const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resMatch) {
          const res = parseInt(resMatch[1]) * parseInt(resMatch[2]);
          if (res > bestRes) { bestRes = res; bestUrl = segUrl; }
        }
      }
      if (bestUrl) playlistUrl = resolveUrl(manifestUrl, bestUrl);
      emit('ai:dl:log', `Playlist seleccionada: ${path.basename(playlistUrl)}`);
    }

    // Obtener la playlist de media
    const mediaText = playlistUrl === manifestUrl ? manifestText
      : await (await fetch(playlistUrl, {
          headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' }
        })).text();

    if (!mediaText.includes('#EXTM3U')) throw new Error('Playlist de media inválida');

    // Extraer segmentos
    const segs = mediaText.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim());
    if (!segs.length) throw new Error('No se encontraron segmentos en la playlist');

    const resolved = segs.map(s => resolveUrl(playlistUrl, s));
    emit('ai:dl:log', `${resolved.length} segmentos encontrados, descargando…`);

    // Descargar segmentos (4 en paralelo)
    const bufs = [];
    const concurrency = 4;
    for (let i = 0; i < resolved.length; i += concurrency) {
      const batch = resolved.slice(i, i + concurrency);
      const results = await Promise.all(batch.map((url, idx) =>
        downloadSegment(url).catch(e => {
          emit('ai:dl:log', `Segmento ${i + idx + 1} falló: ${e.message}`);
          return null;
        })
      ));
      results.forEach((b, idx) => {
        if (b) bufs.push(b);
      });
      emit('ai:dl:log', `Progreso: ${Math.min(i + concurrency, resolved.length)}/${resolved.length}`);
    }

    return Buffer.concat(bufs);
  }

  ipcMain.handle('ai:dl:url', async (_e, { url, name }) => {
    try {
      emit('ai:dl:log', `Iniciando descarga: ${name || url}`);

      let buffer;
      const isHLS = /\.m3u8/i.test(url);
      const isDirect = /\.(mp4|mp3|wav|ogg|webm|flac|aac|m4a)(\?.*)?$/i.test(url);

      if (isHLS) {
        buffer = await downloadHLS(url);
        name = (name || url.split('/').pop()?.split('?')[0] || 'stream').replace(/\.[^.]+$/, '') + '.ts';
      } else if (isDirect) {
        emit('ai:dl:log', 'URL directa, descargando…');
        buffer = Buffer.from(await (await fetch(url, {
          headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' }
        })).arrayBuffer());
        name = (name || url.split('/').pop()?.split('?')[0] || 'download');
      } else {
        return { error: 'URL no soportada. Solo HLS (.m3u8) y archivos directos (.mp4, .mp3, etc.)' };
      }

      const safeName = name.replace(/[\r\n\t\0-\x1F]/g, '_').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      const outPath = path.join(dlDir, safeName);
      fs.writeFileSync(outPath, buffer);
      const sizeMB = (buffer.length / 1048576).toFixed(1);

      emit('ai:dl:log', `✓ Completado: ${safeName} (${sizeMB} MB)`);
      emit('ai:dl:done', { file: outPath, name: safeName, size: sizeMB });
      return { ok: true, file: outPath, name: safeName, size: sizeMB };
    } catch (err) {
      emit('ai:dl:log', `✕ Error: ${err.message}`);
      return { error: err.message };
    }
  });

  // ── AI Terminal ──────────────────────────────────
  const shell = process.platform === 'win32' ? { cmd: 'powershell', args: ['-NoProfile', '-Command'] }
    : { cmd: 'bash', args: ['-c'] };

  ipcMain.handle('ai:exec', async (_e, { command, cwd, timeout }) => {
    try {
      const cmdStr = command.trim();
      if (!cmdStr) return { error: 'Comando vacío' };

      emit('ai:exec:log', `$ ${cmdStr}`);
      const opts = { windowsHide: true, maxBuffer: 10 * 1024 * 1024 };
      if (cwd) opts.cwd = cwd;

      const result = await new Promise((resolve) => {
        const proc = spawn(shell.cmd, [...shell.args, cmdStr], opts);
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => resolve({ stdout, stderr, code }));
        proc.on('error', err => resolve({ stdout, stderr: err.message, code: -1 }));
        if (timeout) setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
      });

      emit('ai:exec:log', result.code === 0 ? `✓ exit ${result.code}` : `✕ exit ${result.code}`);
      return result;
    } catch (err) {
      emit('ai:exec:log', `✕ Error: ${err.message}`);
      return { error: err.message };
    }
  });

  // ── AI Session Load (real browser session) ──────
  let sessionCounter = 0;

  ipcMain.handle('ai:session:load', async (_e, { url, wait }) => {
    let win = null;
    try {
      const id = ++sessionCounter;
      const sess = session.fromPartition('ai-session-' + id, { cache: false });
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: sess,
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          allowRunningInsecureContent: true,
        }
      });

      const ua = ctx.cfg?.ua?.chrome || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.78 Safari/537.36';
      emit('ai:exec:log', `Cargando sesión: ${url.slice(0, 80)}…`);

      win.loadURL(url, { userAgent: ua, extraHeaders: 'Referer: https://www.dailymotion.com/\n' });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timeout 15s')), 15000);
        win.webContents.once('did-finish-load', () => { clearTimeout(t); setTimeout(resolve, 2000); });
        win.webContents.once('did-stop-loading', () => { clearTimeout(t); setTimeout(resolve, 500); });
      });
      // Extra settle time for async JS
      await new Promise(r => setTimeout(r, (wait || 2000)));

      // Esperar a que JS termine
      await new Promise(r => setTimeout(r, wait || 4000));

      // Extraer HTML
      const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '');

      // Extraer cookies
      const cookies = await sess.cookies.get({});
      const cookieMap = {};
      for (const c of cookies) {
        if (!cookieMap[c.domain]) cookieMap[c.domain] = {};
        cookieMap[c.domain][c.name] = c.value;
      }

      // Extraer localStorage
      let localStorage = {};
      try {
        localStorage = await win.webContents.executeJavaScript(
          'Object.entries(localStorage).reduce((a,[k,v])=>(a[k]=v,a),{})'
        );
      } catch {}

      const title = win.getTitle();

      win.close();
      win = null;

      emit('ai:exec:log', `✓ Sesión: ${title} (${cookies.length} cookies, ${(html?.length || 0)}b HTML)`);
      return { ok: true, title, html: (html || '').slice(0, 50000), cookies, cookieMap, localStorage };
    } catch (err) {
      if (win) try { win.close(); } catch {}
      emit('ai:exec:log', `✕ Sesión falló: ${err.message}`);
      return { error: err.message };
    }
  });

  // ── AI Active Page DOM (from webview webContentsId) ──
  ipcMain.handle('ai:page:dom', async (_e, { webContentsId }) => {
    try {
      const wc = webContentsId ? webContents.fromId(webContentsId) : null;
      if (!wc || wc.isDestroyed()) return { error: 'WebContents no disponible' };
      const html = await Promise.race([
        wc.executeJavaScript('document.documentElement.outerHTML'),
        new Promise((_, rej) => setTimeout(() => rej('Timeout'), 6000))
      ]);
      const title = wc.getTitle();
      const url = wc.getURL();
      const cookies = await session.fromPartition('persist:mc-browser-v2').cookies.get({ url }).catch(() => []);
      return { ok: true, title, url, html: (html || '').slice(0, 80000), cookies };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AI Web fetch ────────────────────────────────
  ipcMain.handle('ai:web:fetch', async (_e, { url, asText }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' }
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const text = await res.text();
      const headers = Object.fromEntries(res.headers.entries());
      return { ok: true, text: asText ? text : text.slice(0, 50000), headers, size: text.length };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AI Download file from URL ───────────────────
  ipcMain.handle('ai:fetch:url', async (_e, { url, dest }) => {
    try {
      const outPath = dest || path.join(dlDir, url.split('/').pop()?.split('?')[0] || 'download');
      emit('ai:dl:log', `Descargando ${url.slice(0, 80)}…`);
      const res = await fetch(url, { headers: { 'User-Agent': ctx.cfg?.ua?.chrome || 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      const size = (buf.length / 1048576).toFixed(1);
      emit('ai:dl:log', `✓ Guardado: ${path.basename(outPath)} (${size} MB)`);
      return { ok: true, file: outPath, size };
    } catch (err) {
      emit('ai:dl:log', `✕ Error fetch: ${err.message}`);
      return { error: err.message };
    }
  });

  // ── AI Script Runner ──────────────────────────────
  ipcMain.handle('ai:script:run', async (_e, { code }) => {
    const tmpFile = path.join(__dirname, '..', '..', '.tmp-script-' + Date.now() + '.js');
    try {
      fs.writeFileSync(tmpFile, code, 'utf8');
      return await new Promise(resolve => {
        const child = spawn('node', [tmpFile], {
          cwd: path.join(__dirname, '..', '..'),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
          timeout: 30000,
          maxBuffer: 5 * 1024 * 1024
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
          try { fs.unlinkSync(tmpFile); } catch {}
          resolve({ ok: true, stdout, stderr, exitCode: code });
        });
        child.on('error', err => {
          try { fs.unlinkSync(tmpFile); } catch {}
          resolve({ error: err.message });
        });
      });
    } catch (err) {
      try { fs.unlinkSync(tmpFile); } catch {}
      return { error: err.message };
    }
  });

  // ── AI Decode ─────────────────────────────────────
  ipcMain.handle('ai:decode', (_e, { data, type }) => {
    try {
      if (type === 'base64' || !type) {
        return { ok: true, result: Buffer.from(data, 'base64').toString('utf8') };
      }
      if (type === 'base64url') {
        return { ok: true, result: Buffer.from(data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8') };
      }
      if (type === 'hex') {
        return { ok: true, result: Buffer.from(data, 'hex').toString('utf8') };
      }
      return { error: 'Tipo no soportado: ' + type };
    } catch (err) {
      return { error: err.message };
    }
  });

    // (adblock handlers moved to modules/adblocker/main.js)
  // ── AI Page Resources ───────────────────────────
  ipcMain.handle('ai:page:resources', async (_e, { webContentsId }) => {
    try {
      const wc = webContentsId ? webContents.fromId(webContentsId) : null;
      if (!wc || wc.isDestroyed()) return { error: 'WebContents no disponible' };

      const code = `
        (function(){
          const res = performance.getEntriesByType('resource') || [];
          const urls = res.map(r => ({
            url: r.name.slice(0,300),
            type: r.initiatorType || 'other',
            size: r.transferSize || 0,
            duration: (r.duration || 0).toFixed(1)
          }));
          const scripts = document.querySelectorAll('script[src]');
          const iframes = document.querySelectorAll('iframe');
          return {
            resources: urls.slice(-80),
            totalResources: urls.length,
            scripts: [...scripts].map(s => s.src.slice(0,300)),
            iframes: [...iframes].map(f => f.src.slice(0,300)),
            url: location.href,
            title: document.title
          };
        })()
      `;
      const result = await Promise.race([
        wc.executeJavaScript(code, true),
        new Promise((_, rej) => setTimeout(() => rej('Timeout resources 10s'), 10000))
      ]);
      return { ok: true, ...result };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AI Adblock Test Patterns ─────────────────────
  // ── AI Security Analysis ────────────────────
  const SecurityRules = require('./security-rules.js');
  
  ipcMain.handle('ai:security:analyze-url', async (_e, { url }) => {
    try {
      const findings = await SecurityRules.analyzeUrl(url);
      return { ok: true, findings };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:security:analyze-html', async (_e, { html, url }) => {
    try {
      const findings = await SecurityRules.analyzeHtml(html, url);
      return { ok: true, findings };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:security:rules', () => {
    return { ok: true, rules: SecurityRules.getRules() };
  });

  ipcMain.handle('ai:security:rule:toggle', (_e, { ruleId, enabled }) => {
    return SecurityRules.toggleRule(ruleId, enabled);
  });

  ipcMain.handle('ai:security:rule:add', (_e, { rule }) => {
    return SecurityRules.addRule(rule);
  });

  // ── AI Scraping Tools ────────────────────────
  const ScrapingTools = require('./scraping-tools.js');

  ipcMain.handle('ai:scraping:isolate', async (_e, { selector, html }) => {
    try {
      const result = ScrapingTools.isolateContainer(selector, html);
      return { ok: !!result, result, size: result ? result.length : 0 };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:scraping:analyze-structure', async (_e, { html }) => {
    try {
      const structure = ScrapingTools.analyzePageStructure(html);
      return { ok: true, structure };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:scraping:extract-pattern', async (_e, { html, pattern }) => {
    try {
      const result = ScrapingTools.extractByPattern(html, pattern);
      return { ok: true, result };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:scraping:detect-dynamic', async (_e, { html }) => {
    try {
      const hints = ScrapingTools.detectDynamicContent(html);
      return { ok: true, hints };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:scraping:discover-apis', async (_e, { html }) => {
    try {
      const apis = ScrapingTools.discoverAPIs(html);
      return { ok: true, apis };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:scraping:metrics', async (_e, { html }) => {
    try {
      const metrics = ScrapingTools.getLoadMetrics(html);
      return { ok: true, metrics };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('ai:adblock:scan-page', async (_e, { webContentsId }) => {
    try {
      const wc = webContentsId ? webContents.fromId(webContentsId) : null;
      if (!wc || wc.isDestroyed()) return { error: 'WebContents no disponible' };

      const code = `
        (function(){
          const res = performance.getEntriesByType('resource') || [];
          const ads = [];
          const adKeywords = ['doubleclick','googlesyndication','adnxs','advertising','media.net','outbrain','taboola','criteo','amazon-adsystem','rubicon','pubmatic','openx','adsrvr','adcolony','propeller','popcash','popads','adsterra','exoclick','trafficjunky','juicyads','clickadu','adcash','monetag','adsbygoogle','pagead','adservice','zergio','adserver','adserve','adtraf','adtech','banner','popunder','pop-under'];
          res.forEach(r => {
            const u = r.name.toLowerCase();
            if (adKeywords.some(k => u.includes(k))) {
              ads.push({ url: r.name.slice(0,200), type: r.initiatorType, size: r.transferSize });
            }
          });
          return {
            suspicious: ads,
            total: res.length,
            url: location.href
          };
        })()
      `;
      const result = await Promise.race([
        wc.executeJavaScript(code, true),
        new Promise((_, rej) => setTimeout(() => rej('Timeout test 10s'), 10000))
      ]);
      return { ok: true, ...result };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── AI Page Console (DevTools-like) ───────────────
  ipcMain.handle('ai:page:console', async (_e, { webContentsId }) => {
    try {
      const wc = webContentsId ? webContents.fromId(webContentsId) : null;
      if (!wc || wc.isDestroyed()) return { error: 'WebContents no disponible' };

      // Inyectar capturador + obtener datos en una sola ejecución
      const code = `
        (function(){
          const out = { errors: [], warnings: [], logs: [], failedResources: [], jsErrors: [], structure: {} };

          // Capturar window errors acumulados
          if (window.__capturedErrors) out.jsErrors = window.__capturedErrors;

          // Instalar hooks si no existen
          if (!window.__consoleHooked) {
            window.__capturedErrors = [];
            window.__consoleHooked = true;

            const origError = console.error;
            console.error = function() {
              const msg = Array.from(arguments).map(a => typeof a === 'object' ? JSON.stringify(a).slice(0,200) : String(a).slice(0,200)).join(' ');
              window.__capturedErrors.push({ type: 'console.error', text: msg, time: Date.now() });
              origError.apply(console, arguments);
            };

            window.onerror = function(msg, source, line, col, err) {
              window.__capturedErrors.push({ type: 'window.onerror', text: String(msg).slice(0,300), source: (source||'').slice(0,200), line: line+':'+col, time: Date.now() });
            };

            window.addEventListener('unhandledrejection', function(e) {
              window.__capturedErrors.push({ type: 'unhandledrejection', text: String(e.reason).slice(0,300), time: Date.now() });
            });
          }

          // Leer errores acumulados
          if (window.__capturedErrors) out.jsErrors = window.__capturedErrors.slice(-30);

          // Leer performance entries con error
          try {
            const res = performance.getEntriesByType('resource') || [];
            out.failedResources = res.filter(r => r.transferSize === 0 || r.responseStatus >= 400).slice(0,20).map(r => ({
              url: r.name.slice(0,200),
              status: r.responseStatus || 0,
              size: r.transferSize,
              duration: (r.duration||0).toFixed(0)
            }));
          } catch {}

          // Info de la pagina
          out.structure = {
            url: location.href,
            readyState: document.readyState,
            scripts: document.querySelectorAll('script[src]').length,
            iframes: document.querySelectorAll('iframe').length,
            images: document.querySelectorAll('img').length,
            links: document.querySelectorAll('a[href]').length
          };

          return out;
        })()
      `;
      const result = await Promise.race([
        wc.executeJavaScript(code, true),
        new Promise((_, rej) => setTimeout(() => rej('Timeout console 10s'), 10000))
      ]);
      return { ok: true, ...result };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── SCRAPING AUTOMÁTICO (Background sin IA) ──────────────────────────────
  // Se ejecuta cuando la página se carga para pre-procesar análisis
  ipcMain.handle('ai:auto-scrape', async (_e, { url, html }) => {
    try {
      if (!html || html.length < 100) return { error: 'HTML muy corto' };
      
      // Análisis rápido que NO requiere IA
      const analysis = {
        url,
        hasJS: /<script[^>]*>/i.test(html),
        hasIframes: /<iframe[^>]*>/i.test(html),
        hasForms: /<form[^>]*>/i.test(html),
        hasImages: /<img[^>]*>/i.test(html),
        hasVideos: /\.(mp4|webm|mkv|m3u8)['"\s>]/i.test(html),
        
        // Detecta frameworks
        isReact: /react|preact|next\.js|nextjs|__REACT/i.test(html),
        isVue: /vue|nuxt/i.test(html),
        isAngular: /angular|ng-/i.test(html),
        isJquery: /jquery/i.test(html),
        
        // Información de estructura
        headings: (html.match(/<h[1-6][^>]*>/gi) || []).length,
        paragraphs: (html.match(/<p[^>]*>/gi) || []).length,
        tables: (html.match(/<table[^>]*>/gi) || []).length,
        lists: (html.match(/<ul[^>]*>|<ol[^>]*>/gi) || []).length,
        
        // Detección de contenido común
        hasArticles: /<article[^>]*>/i.test(html),
        hasNav: /<nav[^>]*>/i.test(html),
        hasHeader: /<header[^>]*>/i.test(html),
        hasFooter: /<footer[^>]*>/i.test(html),
        
        // Tamaño
        size: html.length,
        
        // Posibles contenedores principales
        hasMainTag: /<main[^>]*>/i.test(html),
        hasContainerClass: /class=['"]*[^'"]*container[^'"]*['\"]/i.test(html),
        
        timestamp: Date.now()
      };
      
      // Guarda en cache para que la IA la use
      cachePageAnalysis(url, analysis);
      
      return { ok: true, analysis, cached: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── GET CACHED ANALYSIS ──────────────────────────────
  ipcMain.handle('ai:get-cache', async (_e, { url }) => {
    const cached = getPageCache(url);
    return cached ? { ok: true, cached } : { ok: false };
  });

  // ── CLEAR CACHE ──────────────────────────────────────
  ipcMain.handle('ai:clear-cache', async (_e) => {
    clearPageCache();
    return { ok: true };
  });

  // ── SESIONES DE CHAT PERSISTENTES ──────────────────────
  const CHAT_SESSIONS_PATH = path.join(app.getPath('userData'), 'chat-sessions.json');

  function loadChatSessions() {
    try {
      if (fs.existsSync(CHAT_SESSIONS_PATH)) {
        return JSON.parse(fs.readFileSync(CHAT_SESSIONS_PATH, 'utf8'));
      }
    } catch (err) { safeErr('[CHAT-SESSIONS] Load error:', err.message); }
    return [];
  }

  function saveChatSessionsToDisk(sessions) {
    try {
      const dir = path.dirname(CHAT_SESSIONS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CHAT_SESSIONS_PATH, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (err) { safeErr('[CHAT-SESSIONS] Save error:', err.message); }
  }

  ipcMain.handle('ai:chat:sessions:list', async () => {
    const sessions = loadChatSessions();
    // Devolver solo metadata (sin mensajes completos para ser liviano)
    return sessions.map(s => ({ id: s.id, name: s.name, msgCount: s.messages?.length || 0, projectUrl: s.projectUrl || '', createdAt: s.createdAt, updatedAt: s.updatedAt }));
  });

  ipcMain.handle('ai:chat:sessions:load', async (_e, { id }) => {
    const sessions = loadChatSessions();
    const s = sessions.find(x => x.id === id);
    return s ? { ok: true, session: s } : { ok: false };
  });

  ipcMain.handle('ai:chat:sessions:save', async (_e, { id, name, messages, projectUrl }) => {
    const sessions = loadChatSessions();
    const idx = sessions.findIndex(x => x.id === id);
    const now = new Date().toISOString();
    const entry = { id, name: name || 'Sin nombre', messages: messages || [], projectUrl: projectUrl || '', createdAt: idx >= 0 ? sessions[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) sessions[idx] = entry; else sessions.push(entry);
    saveChatSessionsToDisk(sessions);
    safeLog('[CHAT-SESSIONS] Saved:', id, `(${messages?.length || 0} msgs)`);
    return { ok: true };
  });

  ipcMain.handle('ai:chat:sessions:delete', async (_e, { id }) => {
    let sessions = loadChatSessions();
    sessions = sessions.filter(x => x.id !== id);
    saveChatSessionsToDisk(sessions);
    safeLog('[CHAT-SESSIONS] Deleted:', id);
    return { ok: true };
  });

  ipcMain.handle('ai:chat:sessions:rename', async (_e, { id, name }) => {
    const sessions = loadChatSessions();
    const s = sessions.find(x => x.id === id);
    if (s) { s.name = name; s.updatedAt = new Date().toISOString(); saveChatSessionsToDisk(sessions); }
    return { ok: true };
  });

  // ── LAB FILE SYSTEM (sandboxed) ──────────────────────────────────────
  // Permite al código del laboratorio leer/escribir archivos en una carpeta segura
  const LAB_FILES_DIR = path.join(app.getPath('userData'), 'lab-files');

  function _labFsEnsure() {
    if (!fs.existsSync(LAB_FILES_DIR)) fs.mkdirSync(LAB_FILES_DIR, { recursive: true });
  }

  function _labFsSafePath(filePath) {
    // Sanitizar: no permitir .. ni rutas absolutas fuera del sandbox
    const normalized = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(LAB_FILES_DIR, normalized);
    if (!full.startsWith(LAB_FILES_DIR)) return null;
    return full;
  }

  ipcMain.handle('lab:fs:write', async (_e, { filePath, content }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(filePath);
      if (!safe) return { error: 'Ruta no permitida' };
      const dir = path.dirname(safe);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(safe, content, 'utf8');
      return { ok: true, path: safe };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:read', async (_e, { filePath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(filePath);
      if (!safe) return { error: 'Ruta no permitida' };
      if (!fs.existsSync(safe)) return { ok: false, exists: false };
      const content = fs.readFileSync(safe, 'utf8');
      return { ok: true, content, size: content.length };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:read-binary', async (_e, { filePath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(filePath);
      if (!safe) return { error: 'Ruta no permitida' };
      if (!fs.existsSync(safe)) return { ok: false, exists: false };
      const buf = fs.readFileSync(safe);
      return { ok: true, data: buf.toString('base64'), size: buf.length };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:exists', async (_e, { filePath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(filePath);
      if (!safe) return { error: 'Ruta no permitida' };
      return { ok: true, exists: fs.existsSync(safe) };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:list', async (_e, { dirPath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(dirPath || '.');
      if (!safe) return { error: 'Ruta no permitida' };
      if (!fs.existsSync(safe)) return { ok: true, files: [] };
      const entries = fs.readdirSync(safe, { withFileTypes: true });
      const files = entries.map(e => ({
        name: e.name,
        isDir: e.isDirectory(),
        path: path.relative(LAB_FILES_DIR, path.join(safe, e.name))
      }));
      return { ok: true, files };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:delete', async (_e, { filePath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(filePath);
      if (!safe) return { error: 'Ruta no permitida' };
      if (!fs.existsSync(safe)) return { ok: false };
      fs.unlinkSync(safe);
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:mkdir', async (_e, { dirPath }) => {
    try {
      _labFsEnsure();
      const safe = _labFsSafePath(dirPath);
      if (!safe) return { error: 'Ruta no permitida' };
      if (!fs.existsSync(safe)) fs.mkdirSync(safe, { recursive: true });
      return { ok: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:save-dialog', async (_e, { defaultName, content }) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName || 'game.js',
        filters: [
          { name: 'JavaScript', extensions: ['js'] },
          { name: 'HTML', extensions: ['html'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'Todos', extensions: ['*'] }
        ]
      });
      if (result.canceled) return { ok: false };
      fs.writeFileSync(result.filePath, content, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('lab:fs:open-dialog', async () => {
    try {
      const result = await dialog.showOpenDialog({
        filters: [
          { name: 'Archivos de código', extensions: ['js', 'html', 'json', 'css', 'txt'] },
          { name: 'Todos', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      if (result.canceled || !result.filePaths.length) return { ok: false };
      const filePath = result.filePaths[0];
      const content = fs.readFileSync(filePath, 'utf8');
      return { ok: true, content, path: filePath, name: path.basename(filePath) };
    } catch (err) { return { error: err.message }; }
  });
}

module.exports = { setup, getAICfg, setAICfg };
