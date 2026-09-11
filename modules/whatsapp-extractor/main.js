// modules/whatsapp-extractor/main.js
// Módulo independiente: guardado de multimedia extraída de WhatsApp Web.
// No interfiere con los extractores genéricos ni con el módulo de IA.
'use strict';

const { app, ipcMain, session, shell } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');

const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function downloadUrl(url, cookieHeader, redirectsLeft) {
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
        return downloadUrl(next, cookieHeader, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

let _cfg = null;

function setup({ cfg }) {
  _cfg = cfg;

  // Guarda media (base64) extraída de WhatsApp en el directorio de descargas
  ipcMain.handle('wa:media:save', async (_e, { data, mimeType, filename }) => {
    try {
      const ext = mimeType?.includes('png') ? '.png'
        : mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? '.jpg'
        : mimeType?.includes('gif') ? '.gif'
        : mimeType?.includes('webp') ? '.webp'
        : mimeType?.includes('mp3') ? '.mp3'
        : mimeType?.includes('wav') ? '.wav'
        : mimeType?.includes('mp4') ? '.mp4'
        : mimeType?.includes('webm') ? '.webm'
        : mimeType?.includes('ogg') ? '.ogg'
        : mimeType?.includes('opus') ? '.opus'
        : '.bin';
      const dlDir = (_cfg && _cfg.downloadDir) || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const base = filename || `wa-media-${Date.now()}`;
      const fname = base.toLowerCase().endsWith(ext) ? base : base + ext;
      const fpath = path.join(dlDir, fname);
      fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
      console.log('[WA-EXTRACT] Saved:', fpath);
      return { ok: true, path: fpath, filename: fname, size: Buffer.byteLength(data, 'base64') };
    } catch (err) {
      console.error('[WA-EXTRACT] Error:', err.message);
      return { error: err.message };
    }
  });

  // Descarga media (http/https) de WhatsApp usando las cookies de la sesión persist:mc
  // (evita el HTTP 400 de yt-dlp, que no tiene las cookies de WhatsApp)
  ipcMain.handle('wa:media:download', async (_e, { url, filename }) => {
    try {
      const dlDir = (_cfg && _cfg.downloadDir) || app.getPath('downloads');
      if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
      const sess = session.fromPartition('persist:mc');
      const cookies = await sess.cookies.get({ url });
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const buf = await downloadUrl(url, cookieHeader, 5);
      if (!buf || !buf.length) return { error: 'Respuesta vacía' };
      const fname = filename || `wa-media-${Date.now()}`;
      const fpath = path.join(dlDir, fname);
      fs.writeFileSync(fpath, buf);
      console.log('[WA-EXTRACT] Downloaded:', fpath, buf.length, 'bytes');
      return { ok: true, path: fpath, filename: fname, size: buf.length };
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
      const ext = mimeType?.includes('png') ? '.png'
        : mimeType?.includes('jpeg') || mimeType?.includes('jpg') ? '.jpg'
        : mimeType?.includes('gif') ? '.gif'
        : mimeType?.includes('webp') ? '.webp'
        : mimeType?.includes('mp3') ? '.mp3'
        : mimeType?.includes('wav') ? '.wav'
        : mimeType?.includes('mp4') ? '.mp4'
        : mimeType?.includes('webm') ? '.webm'
        : mimeType?.includes('ogg') ? '.ogg'
        : mimeType?.includes('opus') ? '.opus'
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

  // Abre un archivo descargado con la app predeterminada del sistema
  ipcMain.handle('wa:media:open-file', async (_e, { path: filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { error: 'Archivo no encontrado' };
      const err = await shell.openPath(filePath);
      return err ? { error: err } : { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  return { ok: true };
}

module.exports = { setup };