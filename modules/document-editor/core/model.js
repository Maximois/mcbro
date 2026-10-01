'use strict';
/**
 * MC Browser -- modulo document-editor / core/model.js
 *
 * Modelo canonico de documento. Es la pieza central del modulo: PDF y DOCX
 * son solo importadores y exportadores de este formato.
 *
 * Decisiones que conviene no romper:
 *  - Un bloque tiene `text` O `runs`. Nunca ambos. `runs` existe para el
 *    formato mixto dentro de un parrafo (media palabra en negrita); si se
 *    escribe `text` se limpian los `runs`. Asi los tres formatos convergen.
 *  - `hash` es contenido, no identidad: cambia con cada mutacion. Es lo que
 *    permite que un parche de la IA falle en vez de pisar una edicion que no
 *    vio. No es criptografico, es deteccion de concurrencia optimista.
 *  - Toda funcion de este archivo es pura y no depende de Electron, del DOM
 *    ni de Node: se usa igual en el main, en el renderer y en los tests.
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.model = mod;
  }
})(this, function () {
  const SCHEMA = 'mc-doc/1';

  // Carta / A4 en puntos, con margenes de 2 cm.
  const PAGE = {
    A4:      { width: 595.28, height: 841.89, margin: 56.7 },
    LETTER:  { width: 612,    height: 792,    margin: 72 }
  };

  const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'quote', 'code', 'image', 'table', 'pagebreak', 'hr'];
  const ALIGNS = ['left', 'center', 'right', 'justify'];

  let idSeq = 0;
  function genId(prefix) {
    idSeq = (idSeq + 1) % 0xFFFFFF;
    const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36);
    return `${prefix || 'b'}${Date.now().toString(36)}${idSeq.toString(36)}${rand}`;
  }

  // --------------------------------------------------------------- texto

  /** Texto plano de un bloque, incluyendo runs. */
  function blockText(block) {
    if (!block) return '';
    if (Array.isArray(block.runs) && block.runs.length) {
      return block.runs.map(r => (r && r.text) || '').join('');
    }
    return block.text == null ? '' : String(block.text);
  }

  /** Devuelve una copia del bloque con `text` y sin `runs`. */
  function withText(block, text) {
    const next = Object.assign({}, block);
    next.text = text == null ? '' : String(text);
    delete next.runs;
    return next;
  }

  function hasFormatting(block) {
    if (!block) return false;
    return Boolean(block.bold || block.italic || block.underline);
  }

  // ------------------------------------------------------------ normalizar

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeRun(run) {
    if (!run) return null;
    const text = run.text == null ? '' : String(run.text);
    if (!text) return null;
    const out = { text };
    if (run.bold) out.bold = true;
    if (run.italic) out.italic = true;
    if (run.underline) out.underline = true;
    if (run.color && /^#[0-9a-fA-F]{3,8}$/.test(String(run.color))) out.color = String(run.color);
    if (run.size != null) out.size = clampInt(run.size, 4, 96, null);
    return out;
  }

  function normalizeBlock(raw) {
    if (!raw) return null;
    const type = BLOCK_TYPES.includes(raw.type) ? raw.type : 'paragraph';
    const block = { id: raw.id ? String(raw.id) : genId(), type };

    if (type === 'heading') {
      block.level = clampInt(raw.level, 1, 3, 1);
      const t = blockText(raw);
      if (Array.isArray(raw.runs)) block.runs = raw.runs.map(normalizeRun).filter(Boolean);
      else block.text = t;
      if (!block.text && !block.runs) return null;
    } else if (type === 'list') {
      const items = (Array.isArray(raw.items) ? raw.items : String(raw.text || '').split('\n'))
        .map(item => (item && typeof item === 'object' ? blockText(item) : String(item == null ? '' : item)))
        .map(s => s.trim())
        .filter(s => s.length);
      if (!items.length) return null;
      block.items = items;
      block.ordered = raw.ordered === true;
      if (raw.level != null) block.level = clampInt(raw.level, 0, 3, 0);
    } else if (type === 'table') {
      const rows = (Array.isArray(raw.rows) ? raw.rows : [])
        .map(row => (Array.isArray(row) ? row : [row]).map(cell => String(cell == null ? '' : cell)));
      if (!rows.length) return null;
      block.rows = rows;
      if (raw.header !== false) block.header = true;
    } else if (type === 'image') {
      const src = String(raw.src || '');
      if (!isSafeImageSrc(src)) return null;
      block.src = src;
      if (raw.alt) block.alt = String(raw.alt).slice(0, 300);
      if (raw.width != null) block.width = clampInt(raw.width, 16, 2000, null);
      if (raw.height != null) block.height = clampInt(raw.height, 16, 2000, null);
    } else if (type === 'pagebreak' || type === 'hr') {
      // sin contenido
    } else {
      // paragraph | quote | code
      if (Array.isArray(raw.runs)) {
        const runs = raw.runs.map(normalizeRun).filter(Boolean);
        if (!runs.length) return null;
        block.runs = runs;
      } else {
        const t = blockText(raw);
        if (!t.trim()) return null;
        block.text = t;
      }
      if (type === 'code' && raw.lang) block.lang = String(raw.lang).slice(0, 30);
    }

    if (raw.bold) block.bold = true;
    if (raw.italic) block.italic = true;
    if (raw.underline) block.underline = true;
    if (raw.align && ALIGNS.includes(raw.align)) block.align = raw.align;
    if (raw.color && /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color))) block.color = String(raw.color);
    if (raw.size != null) block.size = clampInt(raw.size, 4, 96, null);
    if (raw.page != null) block.page = clampInt(raw.page, 0, 100000, 0);
    if (raw.indent != null) block.indent = clampInt(raw.indent, 0, 8, 0);

    return block;
  }

  /**
   * Solo se aceptan imagenes embebidas. El HTML de exportacion se imprime
   * en una ventana sin red: una URL remota no se resolveria y, si se
   * resolviera, seria una peticion que el usuario no pidio.
   */
  function isSafeImageSrc(src) {
    if (!src) return false;
    const s = String(src).trim();
    return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|bmp);base64,[A-Za-z0-9+/=\s]+$/i.test(s);
  }

  function normalizeDoc(raw) {
    const input = raw || {};
    const blocks = (Array.isArray(input.blocks) ? input.blocks : [])
      .map(normalizeBlock)
      .filter(Boolean);

    const page = Object.assign({}, PAGE.A4, input.page && typeof input.page === 'object' ? input.page : {});
    page.width = clampInt(page.width, 100, 5000, PAGE.A4.width);
    page.height = clampInt(page.height, 100, 5000, PAGE.A4.height);
    page.margin = clampInt(page.margin, 0, 300, PAGE.A4.margin);

    const doc = {
      schema: SCHEMA,
      id: input.id ? String(input.id) : genId('d'),
      title: String(input.title == null ? 'Documento sin titulo' : input.title).slice(0, 300),
      version: clampInt(input.version, 1, 1e9, 1),
      meta: {
        author: String((input.meta && input.meta.author) || '').slice(0, 200),
        subject: String((input.meta && input.meta.subject) || '').slice(0, 400),
        keywords: String((input.meta && input.meta.keywords) || '').slice(0, 400),
        created: String((input.meta && input.meta.created) || new Date().toISOString()),
        modified: String((input.meta && input.meta.modified) || new Date().toISOString()),
        source: String((input.meta && input.meta.source) || '').slice(0, 400),
        sourcePath: String((input.meta && input.meta.sourcePath) || '').slice(0, 1000)
      },
      page,
      blocks,
      warnings: Array.isArray(input.warnings) ? input.warnings.slice(0, 50) : []
    };
    doc.hash = hashDoc(doc);
    return doc;
  }

  function createDoc(opts) {
    return normalizeDoc(opts || {});
  }

  // ---------------------------------------------------------------- hash

  function canonical(doc) {
    const parts = [doc.title, doc.meta.author, doc.meta.subject];
    for (const b of doc.blocks) {
      const runs = Array.isArray(b.runs)
        ? b.runs.map(r => `${r.text}${r.bold ? 'B' : ''}${r.italic ? 'I' : ''}`).join('\\u0001')
        : '';
      parts.push([
        b.type,
        b.level == null ? '' : b.level,
        blockText(b),
        runs,
        b.items ? b.items.join('\\u0002') : '',
        b.rows ? b.rows.map(r => r.join('\\u0003')).join('\\u0004') : '',
        b.src ? String(b.src).length : '',
        b.bold ? 'B' : '', b.italic ? 'I' : '', b.align || ''
      ].join('\\u0005'));
    }
    return parts.join('\\u0006');
  }

  function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * Hash de contenido, formato `h-<16 hex>-<largo>`. Doble semilla FNV para
   * reducir colisiones sin criptografia: el objetivo es que un parche viejo
   * falle, no proteger un secreto.
   */
  function hashDoc(doc) {
    const str = canonical(doc);
    const a = fnv1a(str, 0x811c9dc5);
    const b = fnv1a(str, 0x1000193);
    return `h-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${str.length}`;
  }

  function clone(doc) {
    return normalizeDoc(JSON.parse(JSON.stringify(doc)));
  }

  /** Copia con los bloques reemplazados, version incrementada y hash nuevo. */
  function withBlocks(doc, blocks, extra) {
    const next = Object.assign({}, doc, { blocks, version: (doc.version || 1) + 1 });
    if (extra) Object.assign(next, extra);
    return normalizeDoc(next);
  }

  // --------------------------------------------------------------- lectura

  function plainText(doc, opts) {
    const o = opts || {};
    const max = o.maxChars > 0 ? o.maxChars : Infinity;
    const lines = [];
    let chars = 0;
    for (const b of (doc && doc.blocks) || []) {
      let line = null;
      if (b.type === 'heading') line = '#'.repeat(b.level || 1) + ' ' + blockText(b);
      else if (b.type === 'paragraph') line = blockText(b);
      else if (b.type === 'quote') line = '> ' + blockText(b);
      else if (b.type === 'code') line = blockText(b);
      else if (b.type === 'list') line = (b.items || []).map((it, i) => (b.ordered ? `${i + 1}. ` : '- ') + it).join('\n');
      else if (b.type === 'table') line = (b.rows || []).map(r => '| ' + r.join(' | ') + ' |').join('\n');
      else if (b.type === 'image') line = '[imagen' + (b.alt ? ': ' + b.alt : '') + ']';
      else if (b.type === 'pagebreak') line = '--- [salto de pagina] ---';
      if (line == null) continue;
      chars += line.length + 1;
      if (chars > max) { lines.push(line.slice(0, Math.max(0, max - chars + line.length))); break; }
      lines.push(line);
      if (b.type === 'list' || b.type === 'table') lines.push('');
    }
    if (o.trim !== false) {
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    }
    return lines.join('\n');
  }

  function toMarkdown(doc, opts) {
    return plainText(doc, opts);
  }

  function outline(doc) {
    const out = [];
    (doc.blocks || []).forEach((b, i) => {
      if (b.type !== 'heading') return;
      out.push({ id: b.id, index: i, level: b.level || 1, text: blockText(b) });
    });
    return out;
  }

  function stats(doc) {
    const blocks = (doc && doc.blocks) || [];
    const text = plainText(doc);
    const words = text ? (text.match(/[^\s]+/g) || []).length : 0;
    return {
      blocks: blocks.length,
      words,
      chars: text.length,
      headings: blocks.filter(b => b.type === 'heading').length,
      images: blocks.filter(b => b.type === 'image').length,
      tables: blocks.filter(b => b.type === 'table').length,
      pages: blocks.filter(b => b.type === 'pagebreak').length + 1
    };
  }

  function findBlocks(doc, needle, opts) {
    const o = opts || {};
    const q = String(needle || '').toLowerCase();
    if (!q) return [];
    const limit = o.limit || 200;
    const out = [];
    for (let i = 0; i < (doc.blocks || []).length; i++) {
      const b = doc.blocks[i];
      const hay = b.type === 'table'
        ? (b.rows || []).flat().join(' ').toLowerCase()
        : blockText(b).toLowerCase();
      if (!hay.includes(q)) continue;
      const at = blockText(b).toLowerCase().indexOf(q);
      out.push({
        index: i, id: b.id, type: b.type,
        preview: blockText(b).slice(Math.max(0, at - 40), at + q.length + 80)
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Devuelve un doc con el titulo derivado del primer heading. */
  function deriveTitle(doc) {
    const first = (doc.blocks || []).find(b => b.type === 'heading');
    if (first) {
      const t = blockText(first).trim();
      if (t) return t.slice(0, 200);
    }
    const firstText = plainText(doc, { maxChars: 120 }).split('\n')[0];
    return (firstText || 'Documento sin titulo').trim().slice(0, 200);
  }

  return {
    SCHEMA, PAGE, BLOCK_TYPES, ALIGNS,
    createDoc, normalizeDoc, normalizeBlock, clone, withBlocks,
    hashDoc, blockText, withText, hasFormatting, isSafeImageSrc,
    plainText, toMarkdown, outline, stats, findBlocks, deriveTitle, genId
  };
});
