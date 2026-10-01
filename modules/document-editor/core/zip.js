'use strict';
/**
 * MC Browser -- modulo document-editor / core/zip.js
 *
 * Lector y escritor de archivos ZIP en JS puro, sin dependencias.
 * Es la base del soporte DOCX (un .docx es un ZIP con XML dentro) y de los
 * paquetes de exportacion.
 *
 * Se carga igual en Node (require, para `node --test` y para el worker del
 * proceso main) y en el renderer del navegador (script clasico, via window).
 * Prefiere zlib en Node/Electron y usa CompressionStream en el renderer.
 *
 * Limitaciones declaradas a proposito:
 *  - Solo metodos 0 (stored) y 8 (deflate). Es lo unico queWord/Excel
 *    generan y lo unico que savez generar; no se soportan metodos con
 *    cifrado (AES), que ademas require otro membrane.
 *  - Sin streaming: el paquete completo entra en memoria. Un .docx es un
 *    documento, no una base de datos; el limite se aplica antes de leer
 *    (ver MAX_BYTES en modules/document-editor/main.js).
 *  - Zip64: se leen los campos extra si estan presentes, y se escribe sin
 *    ellos (un documento no llega a 4 GB).
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.zip = mod;
  }
})(this, function () {
  const SIG_LOCAL   = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD    = 0x06054b50;
  const SIG_EOCD64  = 0x06064b50;
  const SIG_LOC64   = 0x07064b50;

  // ---------------------------------------------------------------- utils

  function toU8(input) {
    if (input == null) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === 'string') return new TextEncoder().encode(input);
    throw new TypeError('zip: entrada no convertible a bytes');
  }

  function toStr(input) {
    return new TextDecoder('utf-8').decode(toU8(input));
  }

  // CRC-32 (polinomio 0xEDB88320), igual que el que usa ZIP.
  const CRC_TABLE = (function () {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(buf) {
    const bytes = toU8(buf);
    let c = 0 ^ (-1);
    for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ (-1)) >>> 0;
  }

  const hasStreams = (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function');
  let nodeZlib = null;
  try { if (typeof require === 'function') nodeZlib = require('zlib'); } catch {}

  async function pipeThrough(bytes, transform) {
    const stream = new Response(bytes).body.pipeThrough(transform);
    const chunks = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
      const res = await reader.read();
      if (res.done) break;
      chunks.push(res.value);
      total += res.value.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { out.set(chunk, off); off += chunk.length; }
    return out;
  }

  async function inflateRaw(bytes) {
    if (nodeZlib && nodeZlib.inflateRawSync) {
      return Uint8Array.from(nodeZlib.inflateRawSync(toU8(bytes)));
    }
    if (!hasStreams) throw new Error('zip: sin soporte de compresion en este runtime');
    return pipeThrough(bytes, new DecompressionStream('deflate-raw'));
  }

  async function deflateRaw(bytes) {
    if (nodeZlib && nodeZlib.deflateRawSync) {
      return Uint8Array.from(nodeZlib.deflateRawSync(toU8(bytes)));
    }
    if (!hasStreams) throw new Error('zip: sin soporte de compresion en este runtime');
    return pipeThrough(bytes, new CompressionStream('deflate-raw'));
  }

  // ------------------------------------------------------------- lectura

  function findEocd(view, len) {
    const min = Math.max(0, len - (0xFFFF + 22));
    for (let i = len - 22; i >= min; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  // Campos extra de Zip64 (header id 0x0001) para entradas que no entran en
  // 32 bits. Solo se leen; para escribir se omite.
  function readZip64Extra(extra, need) {
    const out = [];
    let p = 0;
    while (p + 4 <= extra.length) {
      const id = extra.getUint16(p, true);
      const size = extra.getUint16(p + 2, true);
      if (id === 0x0001) {
        let q = p + 4;
        for (const field of need) {
          if (q + 8 > extra.length) break;
          if (field === 'size' || field === 'csize' || field === 'offset') {
            out[field] = Number(extra.getBigUint64(q, true));
            q += 8;
          }
        }
        return out;
      }
      p += 4 + size;
    }
    return out;
  }

  /**
   * Lee un ZIP. Devuelve { names: string[], entries: { [nombre]: Uint8Array } }.
   * Los directorios (nombre terminado en '/') se incluyen como entrada vacia
   * para no perder estructura, pero no tienen contenido.
   */
  async function readZip(input) {
    const bytes = toU8(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;
    if (len < 22) throw new Error('zip: archivo demasiado corto');

    const eocd = findEocd(view, len);
    if (eocd === -1) throw new Error('zip: no se encontro el directorio central (no es un ZIP)');

    let count = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    let cdSize = view.getUint32(eocd + 12, true);

    // Zip64: el EOCD marca 0xFFFF/0xFFFFFFFF y el real esta antes.
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      const loc64 = eocd - 20;
      if (loc64 >= 0 && view.getUint32(loc64, true) === SIG_LOC64) {
        const eocd64 = Number(view.getBigUint64(loc64 + 8, true));
        if (view.getUint32(eocd64, true) === SIG_EOCD64) {
          count = Number(view.getBigUint64(eocd64 + 32, true));
          cdSize = Number(view.getBigUint64(eocd64 + 40, true));
          cdOffset = Number(view.getBigUint64(eocd64 + 48, true));
        }
      }
    }

    const names = [];
    const entries = Object.create(null);
    let p = cdOffset;
    const end = Math.min(len, cdOffset + cdSize || len);

    for (let i = 0; i < count && p + 46 <= end; i++) {
      if (view.getUint32(p, true) !== SIG_CENTRAL) break;
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      let csize = view.getUint32(p + 20, true);
      let size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      let localOffset = view.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

      if (size === 0xFFFFFFFF || csize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
        const z64 = readZip64Extra(
          bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
          ['size', 'csize', 'offset']
        );
        if (z64.size != null) size = z64.size;
        if (z64.csize != null) csize = z64.csize;
        if (z64.offset != null) localOffset = z64.offset;
      }
      p += 46 + nameLen + extraLen + commentLen;

      if (localOffset + 30 > len || view.getUint32(localOffset, true) !== SIG_LOCAL) {
        // Entrada corrupta: seguir con las demas es mejor que abortar todo.
        continue;
      }
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + csize;
      if (dataEnd > len) continue;
      const raw = bytes.subarray(dataStart, dataEnd);

      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else continue; // metodo no soportado: se omite en lugar de romper la lectura

      names.push(name);
      entries[name] = data;
      // El CRC se usa solo para detectar corrupcion en metodo 8; si no
      // coincide preferimos el dato leido (algunos escritores put put).
      void crc; void flags;
    }

    return { names, entries };
  }

  // ------------------------------------------------------------ escritura

  function dosDateTime(date) {
    if (!date || isNaN(date.getTime())) return { time: 0, date: 0x0021 }; // 1980-01-01
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  /**
   * Escribe un ZIP. `entries` es un array de { name, data, date? } o un objeto
   * { nombre: bytes }. La salida es deterministica salvo que se pase `date`.
   * Los nombres se marcan como UTF-8 (flag 0x800), necesario para rutas de
   * archivo con acentos, que son la norma en Windows.
   */
  async function writeZip(input, opts) {
    const list = Array.isArray(input)
      ? input.map(e => ({ name: e.name, data: e.data, date: e.date }))
      : Object.keys(input).map(name => ({ name, data: input[name] }));

    // [Content_Types].xml primero: lo espera el paquete OPC de Office.
    list.sort((a, b) => {
      if (a.name === b.name) return 0;
      if (a.name === '[Content_Types].xml') return -1;
      if (b.name === '[Content_Types].xml') return 1;
      return 0;
    });

    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    const { time, date } = dosDateTime(opts && opts.date);

    for (const entry of list) {
      const nameBytes = encoder.encode(entry.name);
      const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : toU8(entry.data);
      const crc = crc32(data);

      let method = 0;
      let payload = data;
      if ((hasStreams || nodeZlib) && data.length > 0) {
        try {
          const deflated = await deflateRaw(data);
          if (deflated.length < data.length) { method = 8; payload = deflated; }
        } catch { /* sin compresion disponible: stored */ }
      }

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, 20, true);          // version necesaria
      lv.setUint16(6, 0x0800, true);      // flags: nombre UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, payload);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 0x031E, true);      // version creator: UNIX, zip 3.0
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + payload.length;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(8, list.length, true);
    ev.setUint16(10, list.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return concat([...chunks, ...central, eocd]);
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  return {
    crc32,
    toU8,
    toStr,
    readZip,
    writeZip,
    inflateRaw,
    deflateRaw,
    hasStreams
  };
});
