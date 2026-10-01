'use strict';
/**
 * MC Browser -- modulo document-editor / core/html.js
 *
 * El modelo -> HTML. Este HTML tiene tres consumidores y por eso importa que
 * sea el mismo para todos:
 *  1. La exportacion a PDF (main lo imprime con printToPDF en una ventana sin
 *     JavaScript y sin red).
 *  2. La vista previa del editor (iframe con sandbox, sin scripts).
 *  3. La lectura por parte de la IA.
 *
 * Reglas de seguridad, no de estilo: el texto siempre pasa por escape, y las
 * imagenes solo pueden ser data: embebidas. Un documento importado de una
 * pagina cualquiera no puede inyectar HTML ni hacer que el exportador pida
 * una URL remota.
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.html = mod;
  }
})(this, function (deps) {
  const model = deps.model;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const escAttr = (s) => esc(s).replace(/'/g, '&#39;');

  const FONTS = '"Segoe UI", "Calibri", "Helvetica Neue", Arial, sans-serif';
  const MONO = 'Consolas, "Cascadia Mono", "Courier New", monospace';

  function runsToHtml(block) {
    const runs = Array.isArray(block.runs) && block.runs.length ? block.runs : [{ text: model.blockText(block) }];
    let out = '';
    for (const run of runs) {
      let html = esc(run.text).replace(/\n/g, '<br>');
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.underline) html = `<u>${html}</u>`;
      const styles = [];
      if (run.color) styles.push(`color:${escAttr(run.color)}`);
      if (run.size) styles.push(`font-size:${Number(run.size) || 11}pt`);
      if (styles.length) html = `<span style="${escAttr(styles.join(';'))}">${html}</span>`;
      out += html;
    }
    return out;
  }

  function blockStyle(block) {
    const styles = [];
    if (block.align) styles.push(`text-align:${block.align}`);
    if (block.size) styles.push(`font-size:${Number(block.size) || 11}pt`);
    if (block.color) styles.push(`color:${escAttr(block.color)}`);
    if (block.indent) styles.push(`margin-left:${Number(block.indent) * 18}pt`);
    return styles.length ? ` style="${escAttr(styles.join(';'))}"` : '';
  }

  function blockToHtml(block) {
    const style = blockStyle(block);
    switch (block.type) {
      case 'heading': {
        const level = Math.min(3, Math.max(1, block.level || 1));
        return `<h${level}${style}>${runsToHtml(block)}</h${level}>`;
      }
      case 'paragraph':
        return `<p${style}>${runsToHtml(block)}</p>`;
      case 'quote':
        return `<blockquote${style}>${runsToHtml(block)}</blockquote>`;
      case 'code':
        return `<pre${style}><code>${esc(model.blockText(block))}</code></pre>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const items = (block.items || []).map(it => `<li>${esc(it)}</li>`).join('');
        return `<${tag}${style}>${items}</${tag}>`;
      }
      case 'table': {
        const rows = block.rows || [];
        const head = block.header !== false;
        const body = rows.map((row, r) => {
          const tag = head && r === 0 ? 'th' : 'td';
          return `<tr>${row.map(cell => `<${tag}>${esc(cell).replace(/\n/g, '<br>')}</${tag}>`).join('')}</tr>`;
        }).join('');
        return `<table>${body}</table>`;
      }
      case 'image': {
        if (!model.isSafeImageSrc(block.src)) return '';
        const dims = [];
        if (block.width) dims.push(`width:${Number(block.width)}px`);
        if (block.height) dims.push(`height:${Number(block.height)}px`);
        const attrs = dims.length ? ` ${dims.join(';')}` : '';
        return `<figure><img src="${escAttr(block.src)}" alt="${escAttr(block.alt || '')}"${attrs}>${block.alt ? `<figcaption>${esc(block.alt)}</figcaption>` : ''}</figure>`;
      }
      case 'pagebreak':
        return '<div class="pagebreak"></div>';
      case 'hr':
        return '<hr>';
      default:
        return '';
    }
  }

  function stylesheet(doc) {
    const page = doc.page || model.PAGE.A4;
    return `
@page { size: ${page.width}pt ${page.height}pt; margin: ${page.margin}pt; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ${FONTS};
  font-size: 11pt;
  line-height: 1.5;
  color: #111;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1 { font-size: 17pt; margin: 0 0 10pt; line-height: 1.25; }
h2 { font-size: 14pt; margin: 16pt 0 6pt; }
h3 { font-size: 12pt; margin: 14pt 0 5pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
li { margin: 0 0 3pt; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 10pt; border-left: 3pt solid #ccc; color: #444; }
pre { background: #f4f4f4; padding: 8pt; border-radius: 3pt; white-space: pre-wrap; word-break: break-word; font-family: ${MONO}; font-size: 9.5pt; }
code { font-family: ${MONO}; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; font-size: 10pt; }
th, td { border: 0.5pt solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eee; }
figure { margin: 0 0 10pt; }
img { max-width: 100%; height: auto; }
figcaption { font-size: 9pt; color: #666; margin-top: 3pt; }
hr { border: 0; border-top: 0.5pt solid #ccc; margin: 12pt 0; }
.pagebreak { break-after: page; page-break-after: always; height: 0; }
`.trim();
  }

  /**
   * docToHtml(doc, opts) -> string
   * opts.print: documento completo con <head> (para imprimir o previsualizar).
   * opts.bodyOnly: solo el cuerpo (para insertar en la vista previa).
   */
  function docToHtml(doc, opts) {
    const o = opts || {};
    const body = (doc.blocks || []).map(blockToHtml).filter(Boolean).join('\n');
    const title = esc(doc.title || 'Documento');
    if (o.bodyOnly) return body;
    if (!o.print) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
        `<style>${stylesheet(doc)}body{padding:24px;max-width:820px;margin:0 auto;}</style>` +
        `</head><body>${body}</body></html>`;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>${stylesheet(doc)}</style></head><body>${body}</body></html>`;
  }

  /** Solo el texto visible de un fragmento HTML (pegar desde la web). */
  function htmlToText(html) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  return { docToHtml, blockToHtml, runsToHtml, stylesheet, htmlToText, esc, escAttr };
});
