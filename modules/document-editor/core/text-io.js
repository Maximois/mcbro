'use strict';
/**
 * MC Browser -- modulo document-editor / core/text-io.js
 *
 * Texto plano y Markdown hacia/desde el modelo. Es el formato mas barato de
 * entrada y salida: sirve para abrir .txt/.md, para pegar contenido, y para
 * que la IA pueda leer o escribir un documento sin pasar por el parche.
 *
 * La deteccion de Markdown es deliberadamente conservadora: solo marca como
 * titulo lo que empieza con #, como lista lo que empieza con guion, asterisco
 * o numero seguido de punto, y como cita lo que empieza con >. Un .txt comun
 * no se convierte en una lista de titulos.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.textIo = mod;
  }
})(this, function (deps) {
  const model = deps.model;

  const RE_HEADING = /^(#{1,3})\s+(.*)$/;
  const RE_UL = /^\s*[-*+]\s+(.*)$/;
  const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
  const RE_QUOTE = /^\s*>\s?(.*)$/;
  const RE_HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

  /**
   * textToDoc(text, opts) -> doc
   * Un bloque de lineas en blanco separa parrafos. Las lineas sueltas de una
   * lista se agrupan en un solo bloque `list`, como en el modelo.
   */
  function textToDoc(text, opts) {
    const o = opts || {};
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    let listItems = null;
    let listOrdered = false;
    let quoteLines = null;
    let codeLines = null;

    const flushPara = () => {
      if (para.length) {
        blocks.push({ type: 'paragraph', text: para.join('\n') });
        para = [];
      }
    };
    const flushList = () => {
      if (listItems && listItems.length) blocks.push({ type: 'list', items: listItems.slice(), ordered: listOrdered });
      listItems = null;
    };
    const flushQuote = () => {
      if (quoteLines && quoteLines.length) blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      quoteLines = null;
    };
    const flushCode = () => {
      if (codeLines && codeLines.length) blocks.push({ type: 'code', text: codeLines.join('\n') });
      codeLines = null;
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); flushCode(); };

    for (const line of lines) {
      if (codeLines !== null) {
        if (/^\s*```/.test(line)) flushCode();
        else codeLines.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) { flushAll(); codeLines = []; continue; }
      if (RE_HR.test(line)) { flushAll(); blocks.push({ type: 'hr' }); continue; }

      const heading = RE_HEADING.exec(line);
      if (heading) { flushAll(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() }); continue; }

      const ul = RE_UL.exec(line);
      if (ul) {
        flushPara(); flushQuote();
        if (!listItems) { listItems = []; listOrdered = false; }
        listItems.push(ul[1].trim());
        continue;
      }
      const ol = RE_OL.exec(line);
      if (ol) {
        flushPara(); flushQuote();
        if (!listItems) { listItems = []; listOrdered = true; }
        listItems.push(ol[1].trim());
        continue;
      }
      const quote = RE_QUOTE.exec(line);
      if (quote) {
        flushPara(); flushList();
        if (!quoteLines) quoteLines = [];
        quoteLines.push(quote[1]);
        continue;
      }

      if (!line.trim()) { flushAll(); continue; }

      // Continuacion de un elemento de lista: sangrado o texto pegado.
      if (listItems && /^\s{2,}\S/.test(line)) { listItems[listItems.length - 1] += ' ' + line.trim(); continue; }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();

    const doc = model.createDoc({
      title: o.title || model.deriveTitle({ blocks }),
      blocks,
      meta: Object.assign({ source: o.source || 'texto' }, o.meta || {})
    });
    return doc;
  }

  /** Quita el marcado inline de Markdown de una linea suelta. */
  function stripInlineMd(line) {
    return String(line)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1');
  }

  return { textToDoc, stripInlineMd };
});
