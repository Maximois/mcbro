'use strict';
/**
 * MC Browser -- modulo document-editor / core/docx-read.js
 *
 * .docx -> modelo. Lectura de WordprocessingML con el parser propio (xml.js)
 * porque este archivo corre en el proceso main, en un worker, y en el
 * renderer, y `DOMParser` solo existe en el ultimo.
 *
 * Que se conserva: texto, titulos, listas (con su numeracion real), citas,
 * tablas, alineacion, negrita/cursiva/subrayado, color y tamano de caracter,
 * imagenes embebidas y saltos de pagina, mas los metadatos de docProps.
 *
 * Que NO se conserva, y es importante decirlo: estilos por nombre
 * (WordHeading2Custom), secciones multiples, columnas, notas al pie,
 * referencias, campos, control de cambios, formulas y objetos incrustados.
 * El round-trip es "contenido y formato basico", no "identico". Un .docx
 * guardado por este modulo es un documento nuevo, no una edicion del
 * original: por eso el exportador nunca sobrescribe el archivo del usuario
 * sin guardar una copia antes (ver modules/document-editor/main.js).
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model),
    xml: (typeof require === 'function' && typeof module === 'object') ? require('./xml.js') : (root.MCDoc && root.MCDoc.xml),
    zip: (typeof require === 'function' && typeof module === 'object') ? require('./zip.js') : (root.MCDoc && root.MCDoc.zip)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.docxRead = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const xml = deps.xml;
  const zip = deps.zip;

  // Elementos cuyo texto nunca es parte del contenido visible.
  const SKIP_TEXT = new Set([
    'instrText', 'delText', 'proofErr', 'bookmarkStart', 'bookmarkEnd',
    'commentReference', 'commentRangeStart', 'commentRangeEnd', 'footnoteReference',
    'endnoteReference', 'del', 'moveFrom', 'lastRenderedPageBreak', 'fldChar',
    'rPrChange', 'pPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'sectPrChange'
  ]);

  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf',
    webp: 'image/webp', svg: 'image/svg+xml'
  };

  // ------------------------------------------------------- relaciones/media

  function parseRels(entries) {
    const out = Object.create(null);
    const raw = entries['word/_rels/document.xml.rels'];
    if (!raw) return out;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return out; }
    for (const rel of xml.findAll(tree, 'Relationship')) {
      const id = xml.attr(rel, 'Id');
      const target = xml.attr(rel, 'Target');
      if (id) out[id] = target;
    }
    return out;
  }

  function dataUrl(target, entries) {
    if (!target) return null;
    const clean = target.replace(/^\.\.\//, '').replace(/^\//, '');
    const name = clean.startsWith('word/') ? clean : `word/${clean}`;
    const data = entries[name];
    if (!data || !data.length) return null;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, data.subarray(i, i + CHUNK));
    }
    const b64 = (typeof btoa === 'function')
      ? btoa(bin)
      : Buffer.from(data).toString('base64');
    return `data:${mime};base64,${b64}`;
  }

  // -------------------------------------------------------------- runs

  function runPropsOf(run) {
    const rPr = xml.find(run, 'rPr');
    const props = {};
    if (!rPr) return props;
    const b = xml.find(rPr, 'b');
    if (b) props.bold = xml.attr(b, 'val') !== '0' && xml.attr(b, 'val') !== 'false';
    const i = xml.find(rPr, 'i');
    if (i) props.italic = xml.attr(i, 'val') !== '0' && xml.attr(i, 'val') !== 'false';
    const u = xml.find(rPr, 'u');
    if (u) {
      const val = xml.attr(u, 'val');
      if (val && val !== 'none') props.underline = true;
    }
    const color = xml.find(rPr, 'color');
    if (color) {
      const v = xml.attr(color, 'val');
      if (v && /^[0-9a-fA-F]{6}$/.test(v) && v.toUpperCase() !== 'AUTO') props.color = `#${v}`;
    }
    const sz = xml.find(rPr, 'sz');
    if (sz) {
      const v = parseInt(xml.attr(sz, 'val'), 10);
      if (isFinite(v) && v > 0) props.size = Math.round((v / 2) * 10) / 10;
    }
    return props;
  }

  function propsKey(p) {
    return [p.bold ? 'b' : '', p.italic ? 'i' : '', p.underline ? 'u' : '', p.color || '', p.size || ''].join('|');
  }

  /**
   * Recorre el contenido de un parrafo y devuelve una lista de runs
   * { text, bold, italic, ... } con los saltos de linea ya incorporados.
   */
  function runsOfParagraph(p, ctx) {
    const runs = [];
    let current = null;

    const push = (text, props) => {
      if (!text) return;
      const key = propsKey(props);
      if (current && current.key === key) { current.text += text; return; }
      current = { key, text, props };
      runs.push(current);
    };

    const walk = (node) => {
      for (const child of node.children) {
        if (!xml.isElement(child)) continue;
        const name = child.local;
        if (SKIP_TEXT.has(name)) continue;
        if (name === 'AlternateContent') {
          // mc:AlternateContent: se toma la primera rama y se ignora el
          // respaldo, para no duplicar el texto.
          const choice = xml.childNodes(child, 'Choice')[0] || xml.childNodes(child, 'Fallback')[0];
          if (choice) walk(choice);
          continue;
        }
        if (name === 'pPr' || name === 'sdtPr' || name === 'rPr' || name === 'tblPr' || name === 'trPr' || name === 'tcPr') continue;
        if (name === 'r') {
          const props = runPropsOf(child);
          for (const piece of runTokens(child, ctx)) {
            if (piece.image) { runs.push({ image: piece.image }); current = null; continue; }
            push(piece.text, Object.assign({}, props, piece.props || {}));
          }
          continue;
        }
        if (name === 'br') {
          const type = xml.attr(child, 'type');
          if (type === 'page') { ctx.pageBreak = true; continue; }
          push('\n', {});
          continue;
        }
        if (name === 'drawing' || name === 'pict' || name === 'object') {
          const src = imageFromDrawing(child, ctx);
          if (src) {
            runs.push({ image: src });
            current = null;
          }
          continue;
        }
        if (name === 'sdt') {
          const content = xml.find(child, 'sdtContent');
          if (content) walk(content);
          continue;
        }
        if (name === 'AlternateContent') continue;
        walk(child);
      }
    };

    walk(p);
    return runs.filter(r => r.image || (r.text && r.text.length));
  }

  function runTokens(run, ctx) {
    const out = [];
    let text = '';
    const flush = () => { if (text) { out.push({ text }); text = ''; } };
    for (const child of run.children) {
      if (!xml.isElement(child)) continue;
      const name = child.local;
      if (name === 't') { text += xml.textOf(child); continue; }
      if (name === 'tab') { text += '\t'; continue; }
      if (name === 'noBreakHyphen') { text += '-'; continue; }
      if (name === 'softHyphen') continue;
      if (name === 'br') {
        const type = xml.attr(child, 'type');
        if (type === 'page') { flush(); ctx.pageBreak = true; continue; }
        text += '\n';
        continue;
      }
      if (name === 'cr') { text += '\n'; continue; }
      if (SKIP_TEXT.has(name)) continue;
      // Un run puede contener otro run (raro) o un dibujo.
      if (name === 'drawing' || name === 'pict') {
        const src = imageFromDrawing(child, ctx);
        if (src) { flush(); out.push({ image: src }); }
        continue;
      }
    }
    flush();
    return out;
  }

  function imageFromDrawing(node, ctx) {
    if (!ctx.rels) return null;
    const blips = xml.findAll(node, 'blip');
    for (const blip of blips) {
      const rid = xml.attr(blip, 'embed') || xml.attr(blip, 'link');
      if (!rid) continue;
      const target = ctx.rels[rid];
      const src = dataUrl(target, ctx.entries);
      if (src) return src;
    }
    // VML: <v:imagedata r:id="..."/>
    const imagedata = xml.findAll(node, 'imagedata');
    for (const node2 of imagedata) {
      const rid = xml.attr(node2, 'id');
      const src = dataUrl(ctx.rels[rid], ctx.entries);
      if (src) return src;
    }
    return null;
  }

  // --------------------------------------------------------- párrafos

  function paraInfo(p, ctx) {
    const pPr = xml.find(p, 'pPr');
    const info = { pPr };
    if (!pPr) return info;

    const pStyle = xml.find(pPr, 'pStyle');
    info.style = xml.attr(pStyle, 'val') || '';

    const numPr = xml.find(pPr, 'numPr');
    if (numPr) {
      const ilvl = xml.find(numPr, 'ilvl');
      const numId = xml.find(numPr, 'numId');
      info.list = true;
      info.level = parseInt(xml.attr(ilvl, 'val') || '0', 10) || 0;
      info.numId = xml.attr(numId, 'val') || '';
    }

    const jc = xml.find(pPr, 'jc');
    if (jc) {
      const v = xml.attr(jc, 'val');
      if (v === 'center' || v === 'right' || v === 'both' || v === 'left') {
        info.align = v === 'both' ? 'justify' : v;
      }
    }

    const ind = xml.find(pPr, 'ind');
    if (ind) {
      const left = parseInt(xml.attr(ind, 'left') || xml.attr(ind, 'start') || '0', 10);
      if (left > 0) info.indent = Math.max(1, Math.round(left / 720));
    }

    const outline = xml.find(pPr, 'outlineLvl');
    if (outline) {
      const v = parseInt(xml.attr(outline, 'val'), 10);
      if (isFinite(v) && v >= 0 && v <= 2) info.outline = v + 1;
    }

    // Un borde inferior sin texto es un separador horizontal.
    const pBdr = xml.find(pPr, 'pBdr');
    if (pBdr && xml.find(pBdr, 'bottom')) info.horizontalRule = true;

    return info;
  }

  function blockFromRuns(runs, info) {
    const blocks = [];

    for (const run of runs) {
      if (run.image) blocks.push({ type: 'image', src: run.image, alt: info.caption || '' });
    }
    const texts = runs.filter(r => r.text);
    if (!texts.length) return blocks;

    // Los espacios entre runs son datos, no basura: se recortan solo en los
    // bordes del parrafo. Recortar cada run pegaria "Un fragmentoen negrita".
    const merged = texts.map(t => {
      const clean = String(t.text).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      return Object.assign({}, t.props || {}, { text: clean });
    }).filter(m => m.text.length);

    if (!merged.length) return blocks;
    // Recorte de los bordes.
    merged[0].text = merged[0].text.replace(/^[ \t]+/, '');
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/[ \t\n]+$/, '');
    const usable = merged.filter(m => m.text.length);
    if (!usable.length) return blocks;

    const base = { align: info.align, indent: info.indent };
    const distinct = new Set(usable.map(propsKey));
    if (distinct.size > 1) {
      blocks.push(Object.assign({}, base, {
        type: 'paragraph',
        runs: usable.map(m => {
          const run = { text: m.text };
          if (m.bold) run.bold = true;
          if (m.italic) run.italic = true;
          if (m.underline) run.underline = true;
          if (m.color) run.color = m.color;
          if (m.size) run.size = m.size;
          return run;
        })
      }));
      return blocks;
    }
    const m = usable[0];
    blocks.push(Object.assign({}, base, {
      type: 'paragraph',
      text: usable.map(x => x.text).join(''),
      bold: m.bold || undefined,
      italic: m.italic || undefined,
      underline: m.underline || undefined,
      color: m.color || undefined,
      size: m.size || undefined
    }));
    return blocks;
  }

  function tableBlocks(tbl) {
    const rows = [];
    for (const tr of xml.childNodes(tbl, 'tr')) {
      const cells = [];
      for (const tc of xml.childNodes(tr, 'tc')) {
        const texts = [];
        for (const p of xml.childNodes(tc, 'p')) {
          const t = xml.textOf(p).replace(/\s+/g, ' ').trim();
          if (t) texts.push(t);
        }
        cells.push(texts.join(' '));
      }
      if (cells.length) rows.push(cells);
    }
    return rows.length ? [{ type: 'table', rows, header: true }] : [];
  }

  // --------------------------------------------------------- numeracion

  function numberingFormats(entries) {
    const map = Object.create(null);
    const raw = entries['word/numbering.xml'];
    if (!raw) return map;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return map; }
    for (const abs of xml.findAll(tree, 'abstractNum')) {
      const id = xml.attr(abs, 'abstractNumId');
      const lvl0 = xml.childNodes(abs, 'lvl')[0];
      const fmt = lvl0 ? xml.attr(xml.find(lvl0, 'numFmt') || { attrs: {} }, 'val') : '';
      map[id] = fmt;
    }
    const numMap = Object.create(null);
    for (const num of xml.findAll(tree, 'num')) {
      const numId = xml.attr(num, 'numId');
      const abs = xml.find(num, 'abstractNumId');
      numMap[numId] = map[xml.attr(abs, 'val')] || '';
    }
    return numMap;
  }

  // ------------------------------------------------------------- entrada

  /**
   * docxBytesToDoc(bytes, opts) -> { doc, warnings }
   * `bytes` puede ser el .docx entero o el mapa de entradas del ZIP.
   */
  async function docxBytesToDoc(input, opts) {
    const o = opts || {};
    const warnings = [];
    // Ojo: `Uint8Array.prototype.entries` es un metodo, asi que un duck-typing
    // con truthiness confundiria un ArrayBuffer con el mapa de entradas.
    let entries = input;
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      entries = (await zip.readZip(input)).entries;
    } else if (!input || typeof input !== 'object') {
      throw new Error('docx: entrada invalida (se esperaba un .docx o un mapa de entradas)');
    }

    const raw = entries['word/document.xml'];
    if (!raw) {
      throw new Error('docx: falta word/document.xml (no parece un documento de Word)');
    }
    const tree = xml.parse(zip.toStr(raw));
    const body = xml.findDeep(tree, 'body');
    if (!body) throw new Error('docx: no se encontro w:body');

    const rels = parseRels(entries);
    const numFormats = numberingFormats(entries);
    const ctx = { entries, rels, pageBreak: false };

    const blocks = [];
    let listBuffer = null;

    const flushList = () => {
      if (listBuffer && listBuffer.items.length) {
        blocks.push({ type: 'list', items: listBuffer.items, ordered: listBuffer.ordered, level: listBuffer.level });
      }
      listBuffer = null;
    };

    const emit = (list) => {
      for (const b of list) {
        if (b.type === 'pagebreak') { flushList(); blocks.push(b); continue; }
        blocks.push(b);
      }
    };

    const walkBody = (node) => {
      for (const child of node.children) {
        if (!xml.isElement(child)) continue;
        const name = child.local;
        if (name === 'p') {
          const info = paraInfo(child, ctx);
          const pageBreakBefore = ctx.pageBreak;
          ctx.pageBreak = false;
          const runs = runsOfParagraph(child, ctx);
          const pageBreakAfter = ctx.pageBreak;
          ctx.pageBreak = false;

          let out = [];
          if (pageBreakBefore) out.push({ type: 'pagebreak' });

          if (info.list) {
            const text = runs.map(r => (r.text || '')).join('').trim();
            const ordered = numFormats[info.numId] ? !/bullet/i.test(numFormats[info.numId]) : true;
            if (!listBuffer || listBuffer.ordered !== ordered) {
              flushList();
              listBuffer = { items: [], ordered, level: info.level || 0 };
            }
            if (text) listBuffer.items.push(text);
            if (pageBreakAfter) flushList();
            continue;
          }
          flushList();

          const kind = headingLevelOf(info);
          const text = runs.map(r => (r.text || '')).join('').trim();
          if (kind) {
            if (kind.kind === 'hr') out.push({ type: 'hr' });
            else if (kind.kind === 'quote' && text) out.push({ type: 'quote', text });
            else if (kind.kind === 'code' && text) out.push({ type: 'code', text });
            else if (text) out.push({ type: 'heading', level: kind.level, text });
            else out = out.concat(blockFromRuns(runs, info));
          } else {
            out = out.concat(blockFromRuns(runs, info));
          }
          if (pageBreakAfter) out.push({ type: 'pagebreak' });
          emit(out);
          continue;
        }
        if (name === 'tbl') {
          flushList();
          emit(tableBlocks(child));
          continue;
        }
        if (name === 'sdt') {
          const content = xml.find(child, 'sdtContent');
          if (content) walkBody(content);
          continue;
        }
        if (name === 'sectPr') {
          const pgSz = xml.find(child, 'pgSz');
          if (pgSz) {
            const w = parseInt(xml.attr(pgSz, 'w') || '0', 10);
            const h = parseInt(xml.attr(pgSz, 'h') || '0', 10);
            if (w > 0 && h > 0) { o.pageWidth = w / 20; o.pageHeight = h / 20; }
          }
          const pgMar = xml.find(child, 'pgMar');
          if (pgMar) {
            const m = parseInt(xml.attr(pgMar, 'top') || '0', 10);
            if (m > 0) o.margin = m / 20;
          }
          continue;
        }
        if (name === 'bookmarkStart' || name === 'bookmarkEnd' || name === 'proofErr' || name === 'AlternateContent') continue;
      }
    };

    walkBody(body);
    flushList();

    const meta = readCoreProps(entries);
    const doc = model.createDoc({
      title: meta.title || o.title || 'Documento',
      meta: {
        author: meta.author, subject: meta.subject, keywords: meta.keywords,
        created: meta.created, modified: meta.modified,
        source: 'docx', sourcePath: o.sourcePath || ''
      },
      page: o.pageWidth ? { width: o.pageWidth, height: o.pageHeight, margin: o.margin } : undefined,
      blocks,
      warnings
    });

    if (!blocks.length) warnings.push('el documento no tiene texto reconocible');
    if (!doc.title || doc.title === 'Documento') {
      doc.title = model.deriveTitle(doc);
      doc.hash = model.hashDoc(doc);
    }
    return { doc, warnings };
  }

  function headingLevelOf(info) {
    const style = (info.style || '').replace(/\s+/g, '');
    if (/^Quote$/i.test(style) || /^IntenseQuote$/i.test(style)) return { kind: 'quote' };
    if (/^(Subtitle)$/i.test(style)) return { kind: 'heading', level: 2 };
    if (/^(HTMLPreformatted|Code|SourceCode|Preformatted)$/i.test(style)) return { kind: 'code' };
    if (/^Heading[1-3]$/i.test(style)) return { kind: 'heading', level: parseInt(style.slice(7), 10) };
    if (/^Ttulo[1-3]$/i.test(style) || /^Title$/i.test(style)) return { kind: 'heading', level: 1 };
    if (info.horizontalRule) return { kind: 'hr' };
    if (info.outline) return { kind: 'heading', level: info.outline };
    return null;
  }

  function readCoreProps(entries) {
    const out = {};
    const raw = entries['docProps/core.xml'];
    if (!raw) return out;
    let tree;
    try { tree = xml.parse(zip.toStr(raw)); } catch { return out; }
    // findDeep: los hijos de cp:coreProperties cuelgan de un unico elemento
    // raiz, asi que no son hijos directos del nodo de documento.
    const pick = (name) => {
      const node = xml.findDeep(tree, name);
      return node ? xml.textOf(node).trim() : '';
    };
    out.title = pick('title');
    out.author = pick('creator');
    out.subject = pick('subject');
    out.keywords = pick('keywords');
    out.created = pick('created');
    out.modified = pick('modified');
    return out;
  }

  return { docxBytesToDoc, parseRels, runsOfParagraph, tableBlocks, numberingFormats };
});
