/**
 * core/pdf-text.js — extraccion de texto y estructura de un PDF a bloques.
 *
 * UMD puro. NO importa pdf.js: el namespace se recibe por parametro
 * (`opts.pdfjs`) porque el mismo core se usa desde dos lugares con pdf.js
 * cargado de forma distinta:
 *   - main: `require('../../document-editor/vendor/pdf.min.js')` en un worker
 *   - renderer: `<script src=".../pdf.min.js">` (global `pdfjsLib`)
 *
 * Es una lectura *aproximada*: un PDF describe posiciones, no parrafos. Por eso
 * todo lo que es interesante va acompanado de un warning, y nunca se inventa
 * estructura que no se vio.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.McDocPdfText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_PAGES = 2000;

  // ---------------------------------------------------------------- lineas

  /**
   * Convierte los items de `getTextContent()` en lineas con posicion.
   * pdf.js ya entrega `hasEOL`; si falta (o hay itemsraros), se agrupa por `y`.
   */
function toLines(items) {
    var out = [];
    var cur = null;

    function geom(it) {
      // `transform` llega como matriz [a,b,c,d,e,f]: e/f son x/y del origen.
      // Algunos generadores lo dan como texto "translate(x, y)".
      var x = 0;
      var y = 0;
      var t = it.transform;
      if (Array.isArray(t) || ArrayBuffer.isView(t)) {
        x = Number(t[4]) || 0;
        y = Math.abs(Number(t[5]) || 0);
      } else if (typeof t === 'string') {
        var m = /translate\(\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(t);
        if (m) { x = parseFloat(m[1]); y = Math.abs(parseFloat(m[2])); }
      }
      var size = it.height || (Array.isArray(t) ? Number(t[3]) : 0) || 10;
      var width = it.width || (String(it.str).length * size * 0.5);
      return { x: x, y: y, size: size, width: width, end: x + width };
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string') continue;
      var g = geom(it);
      var bold = /bold|black|heavy|semibold|demi/i.test(it.fontName || '');
      var italic = /italic|oblique/i.test(it.fontName || '');

      if (!it.str.replace(/\s/g, '')) {
        // Espacios vacios: sirven de pegamento y de fin de linea.
        if (it.hasEOL && cur) { out.push(finish(cur)); cur = null; }
        else if (cur) cur.__end = Math.max(cur.__end, g.end);
        continue;
      }

      var newLine = !cur || Math.abs(cur.y - g.y) > cur.size * 0.6;
      if (newLine) {
        if (cur) out.push(finish(cur));
        cur = { x: g.x, y: g.y, size: g.size, width: g.width, __end: g.end, bold: bold, italic: italic, text: it.str };
      } else {
        if (g.x - cur.__end > g.size * 0.22) cur.text += ' ';
        cur.text += it.str;
        cur.__end = Math.max(cur.__end, g.end);
        cur.width = Math.max(cur.width, g.end - cur.x);
        cur.size = Math.max(cur.size, g.size);
        cur.bold = cur.bold && bold;
        cur.italic = cur.italic && italic;
      }

      if (it.hasEOL) { out.push(finish(cur)); cur = null; }
    }
    if (cur) out.push(finish(cur));
    return out.filter(function (l) { return l && l.text.replace(/\s/g, '').length; });

    function finish(row) {
      row.text = String(row.text || '').replace(/[\t ]+/g, ' ').replace(/ /g, ' ').trim();
      delete row.__end;
      return row;
    }
  }

  // ------------------------------------------------------------- estructura

  // Marcadores de lista al inicio de una linea, en dos niveles de confianza.
  //
  // - fuerte: glifos de vineta. El espacio es opcional porque hay PDF que lo
  //   pegan al texto ("•Nombre:").
  // - debil: guion, numeros y letras. AHI el espacio es obligatorio: un guion
  //   pegado al texto es la raya de dialogo de medio mundo ("-¿Que?"), no una
  //   vineta. Los guiones largos (– —) no son marcadores en ningun caso: en
  //   castellano abren el dialogo.
  var BULLET_STRONG = /^[\s\u00a0]*([\u2022\u2023\u25AA\u25CF\u00B7\u2043\u2219])[\s\u00a0]*(.+)$/;
  var BULLET_WEAK = /^[\s\u00a0]*([\-]|\(?\d{1,3}[.)]|\(?[A-Za-z][.)])[\s\u00a0]+(.+)$/;
  var SENTENCE_END = /[.!?:;)\]\u201D"']$/;

  /** -> { ordered, marker, item } | null */
  function parseBullet(text) {
    var m = BULLET_STRONG.exec(text);
    if (m) return { ordered: false, marker: m[1], item: m[2].trim() };
    m = BULLET_WEAK.exec(text);
    if (m) return { ordered: !/[\-]/.test(m[1]), marker: m[1], item: m[2].trim() };
    return null;
  }

  /**
   * Lineas -> bloques del modelo. Heuristicas conservativeas: preferimos pocos
   * bloques bien detectados antes que muchos inventados.
   *
   * NO emite `pagebreak`: los limites de pagina los agrega el llamador, que es
   * el unico que sabe donde termina cada pagina.
   */
  function linesToBlocks(lines, ctx) {
    var blocks = [];
    var o = ctx || {};
    // El cuerpo de fuente se puede imponer desde afuera: en una pagina que solo
    // tiene un titulo, la mediana de la pagina seria el titulo mismo y no
    // habria forma de distinguirlo.
    var bodySize = o.bodySize && o.bodySize > 0 ? o.bodySize : medianSize(lines);
    var left = o.left != null && isFinite(o.left) ? o.left : minLeft(lines);
    var right = maxRight(lines);
    var para = [];
    var list = null;

    function flushPara() {
      if (!para.length) return;
      var text = para.join(' ');
      para = [];
      if (!text.replace(/\s/g, '').length) return;
      blocks.push({ type: 'paragraph', text: text });
    }
    function flushList() {
      if (!list || !list.items.length) { list = null; return; }
      blocks.push({ type: 'list', items: list.items, ordered: list.ordered });
      list = null;
    }
function isBullet(line) { return !!parseBullet(line.text); }

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var prev = i > 0 ? lines[i - 1] : null;
      var next = i + 1 < lines.length ? lines[i + 1] : null;

      var bullet = parseBullet(l.text);
      if (bullet) {
        flushPara();
        var item = bullet.item;
        if (!item) continue;
        if (!list || list.ordered !== bullet.ordered) { flushList(); list = { items: [], ordered: bullet.ordered }; }
        list.items.push(item);
        // `anchor` es la linea de la vineta (fija): todas las continuaciones
        // se miden contra ella. `last` es la linea ya consumida y cambia en
        // cada continuacion.
        list.anchor = l;
        list.last = l;
        continue;
      }

      var gapAbove = prev ? Math.abs(prev.y - l.y) : Infinity;
      var gapBelow = next ? Math.abs(l.y - next.y) : Infinity;
      var ratio = l.size / bodySize;
      var isShort = l.text.length <= 120 && !/[.;,]$/.test(l.text);
      var shortEndsLeft = prev ? (right - (prev.x + prev.width)) > bodySize * 2.5 : false;

      // Titulos: el tamano de fuente es la senal mas fiable que da un PDF.
      if (isShort && ratio >= 1.08) {
        flushPara(); flushList();
        blocks.push({ type: 'heading', level: ratio >= 1.45 ? 1 : (ratio >= 1.18 ? 2 : 3), text: l.text });
        continue;
      }
      // Titulo del mismo cuerpo que el texto (muchos PDF "en negrita" sin
      // fuente negrita embebida): linea corta, sin parrafo abierto, alineada
      // al margen izquierdo y seguida de una lista. El margen importa: una
      // linea de continuacion tambien es corta y le precede una lista.
      if (isShort && para.length === 0 && Math.abs(l.x - left) <= bodySize * 0.8
        && next && isBullet(next) && next.x >= l.x && gapBelow > bodySize * 0.9) {
        flushList();
        blocks.push({ type: 'heading', level: 2, text: l.text });
        continue;
      }
      // Nota deliberada: NO se usa "linea corta en negrita/cursiva y aislada"
      // como senal de titulo. En novelas esa combinacion es la forma habitual
      // de escribir un renglon de dialogo, y convertia la mitad del libro en
      // titulos. Si hace falta, el usuario lo ajusta con un parche.
      // Codigo o letra pequena: fuente mas chica que el cuerpo y claramente
      // sangrada. No se exige "sin punto y coma" porque una linea de codigo
      // termina justo en eso.
      if (l.text.length <= 160 && ratio <= 0.85 && l.x > left + bodySize * 0.3) {
        flushPara(); flushList();
        blocks.push({ type: 'code', text: l.text });
        continue;
      }

      // Continuacion de un item de lista que se partio en varias lineas. Exige que
      // la linea este mas sangrada que la vineta: en un PDF real la continuacion
      // arranca donde terminaba el texto, no donde estaba la vineta. Sin esa
      // exigencia, una raya de dialogo pegada a una lista se comia el item.
      if (list && list.items.length && list.anchor && list.last
        && gapAbove < bodySize * 1.7
        && l.x > list.anchor.x + bodySize * 0.25) {
        list.items[list.items.length - 1] += ' ' + l.text;
        list.last = l;
        continue;
      }
      flushList();

      // Continuidad de parrafo: sin hueco vertical, columna izquierda y la
      // linea anterior no cerraba a mitad del ancho del texto.
      var continues = para.length > 0
        && l.x <= left + bodySize * 1.5
        && gapAbove < bodySize * 1.9
        && gapAbove > bodySize * 0.2
        && (!SENTENCE_END.test(para[para.length - 1]) || shortEndsLeft);

      if (!continues) flushPara();
      para.push(l.text);
    }
    flushPara();
    flushList();
    return blocks;
  }

  function medianSize(lines) {
    if (!lines.length) return 10;
    var xs = lines.map(function (l) { return l.size; }).sort(function (a, b) { return a - b; });
    return xs[Math.floor(xs.length / 2)] || 10;
  }
  function maxRight(lines) {
    var m = 0;
    for (var i = 0; i < lines.length; i++) m = Math.max(m, lines[i].x + lines[i].width);
    return m;
  }
  function minLeft(lines) {
    var m = Infinity;
    for (var i = 0; i < lines.length; i++) m = Math.min(m, lines[i].x);
    return isFinite(m) ? m : 0;
  }

  // ------------------------------------------------------------------- API

  /**
   * bytes: Uint8Array | Buffer | ArrayBuffer
   * opts: { pdfjs, maxPages, onProgress, signal }
   * -> { blocks, pages, pageCount, meta, warnings, empty }
   */
  async function pdfBytesToBlocks(bytes, opts) {
    var o = opts || {};
    if (!o.pdfjs || typeof o.pdfjs.getDocument !== 'function') {
      throw new Error('pdf-text: falta la libreria pdf.js (opts.pdfjs)');
    }
    var maxPages = Math.min(o.maxPages || MAX_PAGES, MAX_PAGES);
    var warnings = [];

    var task = o.pdfjs.getDocument({
      data: toBytes(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0
    });
    var pdf = await task.promise;

    try {
      var info = null;
      try {
        var md = await pdf.getMetadata();
        info = (md && md.info) || null;
      } catch (_) { /* metadatos opcionales */ }

      var total = pdf.numPages || 0;
      var blocks = [];
      var ctxLeft = Infinity;
      var docBodySize = 0;
      var emptyPages = 0;

      for (var p = 1; p <= Math.min(total, maxPages); p++) {
        if (o.signal && o.signal.aborted) throw new Error('pdf-text: cancelado por el llamador');
        var lines = [];
        try {
          var page = await pdf.getPage(p);
          var tc = await page.getTextContent();
          lines = toLines(tc.items || []);
          if (lines.length) ctxLeft = Math.min(ctxLeft, minLeft(lines));
        } catch (e) {
          warnings.push('pagina ' + p + ': no se pudo leer el texto (' + (e && e.message ? e.message : 'sin detalle') + ')');
          continue;
        }
        if (!lines.length) { emptyPages++; continue; }

        var pageBlocks = linesToBlocks(lines, {
          left: ctxLeft === Infinity ? minLeft(lines) : ctxLeft,
          // El cuerpo de fuente se mantiene entre paginas: si una pagina es
          // solo un titulo, su propia mediana no sirve para compararse.
          bodySize: docBodySize
        });
        // Una pagina con tres lineas o mas es texto corriente: su mediana si
        // sirve como cuerpo de referencia para las paginas siguientes.
        if (!docBodySize && lines.length >= 3) docBodySize = medianSize(lines);
        // El limite de pagina es un hecho del archivo, no una opinion sobre el
        // texto: va entre bloques y no dentro de ninguno.
        if (blocks.length && pageBlocks.length) {
          var last = blocks[blocks.length - 1];
          if (last.type !== 'pagebreak') blocks.push({ type: 'pagebreak' });
        }
        blocks = blocks.concat(pageBlocks);
        if (o.onProgress) o.onProgress({ page: p, total: total });
      }

      if (total > maxPages) warnings.push('solo se leyeron las primeras ' + maxPages + ' de ' + total + ' paginas');
      if (emptyPages) {
        warnings.push('paginas sin texto extraible: ' + emptyPages + ' de ' + total +
          ' (puede ser un PDF escaneado: necesita OCR)');
      }
      if (!blocks.length) {
        warnings.push('este PDF no tiene texto extraible: parece escaneado o son solo imagenes. '
          + 'Haria falta OCR para editarlo como texto.');
      }

      return {
        blocks: blocks,
        pages: Math.min(total, maxPages),
        pageCount: total,
        meta: {
          title: str(info && (info.Title || info.title)),
          author: str(info && (info.Author || info.author)),
          subject: str(info && (info.Subject || info.subject)),
          producer: str(info && (info.Producer || info.producer))
        },
        warnings: warnings,
        empty: !blocks.length
      };
    } finally {
      try { await pdf.destroy(); } catch (_) { /* nada que hacer */ }
    }

    function str(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : ''; }
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('pdf-text: se esperaba un Uint8Array');
  }

  return {
    pdfBytesToBlocks: pdfBytesToBlocks,
    toLines: toLines,
    linesToBlocks: linesToBlocks,
    MAX_PAGES: MAX_PAGES
  };
});