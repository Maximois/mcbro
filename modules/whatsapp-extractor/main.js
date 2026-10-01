// modules/whatsapp-extractor/main.js
// Módulo independiente: guardado de multimedia extraída de WhatsApp Web.
// No interfiere con los extractores genéricos ni con el módulo de IA.
'use strict';

const { app, ipcMain, session, shell } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');

const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// WhatsApp Web sirve media embebida desde estos hosts. Todo lo demás se
// rechaza: sin esto, wa:media:download sería un fetch autenticado arbitrario
// con las cookies de la sesión.
const WA_MEDIA_HOSTS = /(^|\.)(whatsapp\.(com|net)|fbcdn\.net|whatsapp\.org)$/i;
function isWaMediaHost(host) {
  return WA_MEDIA_HOSTS.test(String(host || '').toLowerCase().replace(/^\.+/, ''));
}

function downloadUrl(url, cookieHeader, redirectsLeft, outputPath) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL inválida')); }
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': WA_UA,
        'Accept': '*/*',
        'Referer': 'https://web.whatsapp.com/'
      }
    };
    if (cookieHeader) opts.headers['Cookie'] = cookieHeader;
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Demasiados redireccionamientos'));
        const next = new URL(res.headers.location, url).toString();
        // Solo redireccionamos dentro de hosts de media de WhatsApp: si no,
        // las cookies de sesión travelingían a un tercero.
        let nextHost = '';
        try { nextHost = new URL(next).hostname; } catch { return reject(new Error('Redirección inválida')); }
        if (!isWaMediaHost(nextHost)) return reject(new Error('Redirección a host no permitido'));
        return downloadUrl(next, cookieHeader, redirectsLeft - 1, outputPath).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const output = fs.createWriteStream(outputPath);
      let size = 0;
      res.on('data', (chunk) => { size += chunk.length; });
      res.on('error', (error) => {
        output.destroy();
        try { fs.unlinkSync(outputPath); } catch {}
        reject(error);
      });
      output.on('error', (error) => {
        res.destroy();
        try { fs.unlinkSync(outputPath); } catch {}
        reject(error);
      });
      output.on('finish', () => resolve(size));
      res.pipe(output);
    });
    req.on('error', reject);
    req.end();
  });
}

let _cfg = null;
let _resolveSafePath = null;

// Fallback local por si el módulo se monta sin el helper (tests, uso aislado).
// Misma regla: sin separadores, sin '..', sin ruta absoluta, y dentro de base.
function localSafePath(baseDir, name) {
  const path = require('path');
  const base = path.resolve(baseDir);
  const raw = String(name == null ? '' : name);
  const safe = raw.replace(/[\\/]+/g, '_').replace(/^\.+/, '').trim();
  if (!safe) return null;
  const resolved = path.resolve(base, safe);
  if (resolved === base || !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}
function safePath(baseDir, name) {
  return (_resolveSafePath || localSafePath)(baseDir, name);
}

// Los hosts de media se validan con isWaMediaHost (definido arriba).

function downloadDir() {
  return (_cfg && _cfg.downloadDir) || app.getPath('downloads');
}

function setup({ cfg, resolveSafePath }) {
  _cfg = cfg;
  if (typeof resolveSafePath === 'function') _resolveSafePath = resolveSafePath;

  // Guarda media (base64) extraída de WhatsApp en el directorio de descargas
  ipcMain.handle('wa:media:save', async (_e, { data, mimeType, filename }) => {
    try {
      // WhatsApp Web entrega media embebida como imagen o video. El audio
      // llega como archivo descargable, no como media embebida, así que no
      // contemplamos mp3/wav/ogg/opus acá.
      const ext = mimeType?.includes('png') ? '.png'
        : mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? '.jpg'
        : mimeType?.includes('gif') ? '.gif'
        : mimeType?.includes('webp') ? '.webp'
        : mimeType?.includes('mp4') ? '.mp4'
        : mimeType?.includes('webm') ? '.webm'
        : '.bin';
      const dlDir = downloadDir();
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const base = filename || `wa-media-${Date.now()}`;
      const fname = base.toLowerCase().endsWith(ext) ? base : base + ext;
      const fpath = safePath(dlDir, fname);
      if (!fpath) return { error: 'Nombre de archivo no válido' };
      fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
      console.log('[WA-EXTRACT] Saved:', fpath);
      return { ok: true, path: fpath, filename: fname, size: Buffer.byteLength(data, 'base64') };
    } catch (err) {
      console.error('[WA-EXTRACT] Error:', err.message);
      return { error: err.message };
    }
  });

  // Descarga media (http/https) de WhatsApp. Usa las cookies de la sesión
  // aislada de WhatsApp (persist:mc-whatsapp) — leer persist:mc sería leer la
  // sesión principal, que no tiene las cookies de WhatsApp y viola el
  // aislamiento entre paneles.
  ipcMain.handle('wa:media:download', async (_e, { url, filename }) => {
    try {
      let u;
      try { u = new URL(url); } catch { return { error: 'URL inválida' }; }
      if (u.protocol !== 'https:') return { error: 'Solo se permiten URLs https' };
      if (!isWaMediaHost(u.hostname)) return { error: 'Host no permitido para media de WhatsApp' };

      const dlDir = downloadDir();
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const sess = session.fromPartition('persist:mc-whatsapp');
      const cookies = await sess.cookies.get({ url: u.toString() });
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const fname = filename || `wa-media-${Date.now()}`;
      const fpath = safePath(dlDir, fname);
      if (!fpath) return { error: 'Nombre de archivo no válido' };
      const size = await downloadUrl(u.toString(), cookieHeader, 5, fpath);
      if (!size) return { error: 'Respuesta vacía' };
      console.log('[WA-EXTRACT] Downloaded:', fpath, size, 'bytes');
      return { ok: true, path: fpath, filename: fname, size };
    } catch (err) {
      console.error('[WA-EXTRACT] Download error:', err.message);
      return { error: err.message };
    }
  });

  // Abre media (data URL) en una pestaña: guarda a archivo temporal y devuelve la ruta
  ipcMain.handle('wa:media:open', async (_e, { data }) => {
    try {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(data || '');
      if (!m) return { error: 'Data URL inválida' };
      const mimeType = m[1];
      // Misma regla que wa:media:save — solo imagen y video.
      const ext = mimeType?.includes('png') ? '.png'
        : mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? '.jpg'
        : mimeType?.includes('gif') ? '.gif'
        : mimeType?.includes('webp') ? '.webp'
        : mimeType?.includes('mp4') ? '.mp4'
        : mimeType?.includes('webm') ? '.webm'
        : '.bin';
      const tmpDir = path.join(app.getPath('temp'), 'mc-wa-open');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const fname = 'wa-open-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + ext;
      const fpath = path.join(tmpDir, fname);
      fs.writeFileSync(fpath, Buffer.from(m[2], 'base64'));
      return { ok: true, path: fpath };
    } catch (err) {
      console.error('[WA-EXTRACT] Open error:', err.message);
      return { error: err.message };
    }
  });

  // Abre un archivo descargado con la app predeterminada del sistema.
  // Solo dentro de la carpeta de descargas y solo extensiones de media:
  // shell.openPath sobre una ruta arbitraria ejecutaría lo que hubiera ahí.
  const OPENABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.m4v', '.mov', '.bin']);
  ipcMain.handle('wa:media:open-file', async (_e, { path: filePath }) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { error: 'Ruta no válida' };
      const dlDir = downloadDir();
      const resolved = path.resolve(filePath);
      if (resolved !== path.resolve(dlDir) && !resolved.startsWith(path.resolve(dlDir) + path.sep)) {
        return { error: 'Ruta fuera de la carpeta de descargas' };
      }
      if (!OPENABLE_EXT.has(path.extname(resolved).toLowerCase())) {
        return { error: 'Tipo de archivo no permitido' };
      }
      if (!fs.existsSync(resolved)) return { error: 'Archivo no encontrado' };
      const err = await shell.openPath(resolved);
      return err ? { error: err } : { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  return { ok: true };
}

module.exports = { setup };