'use strict';
/**
 * Smoke de lectura de PDF con la libreria vendorizada.
 * Uso: node tools/pdf-smoke.js [archivo.pdf ...]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// pdf.js en Node no crea workers reales: usa el "fake worker" y busca
// `globalThis.pdfjsWorker`. Hay que cargar el worker a mano y publicarlo en el
// global ANTES de pedir cualquier documento.
globalThis.pdfjsWorker = require(path.join(root, 'modules/document-editor/vendor/pdf.worker.min.js'));
const pdfjs = require(path.join(root, 'modules/document-editor/vendor/pdf.min.js'));
const model = require(path.join(root, 'modules/document-editor/core/model.js'));
const pdfText = require(path.join(root, 'modules/document-editor/core/pdf-text.js'));

const args = process.argv.slice(2);
const files = args.length ? args : [path.join(process.env.TEMP || '.', 'mc-pdf-smoke.pdf')];

(async () => {
  for (const file of files) {
    console.log('\n=== ' + file);
    if (!fs.existsSync(file)) { console.log('  (no existe)'); continue; }
    const bytes = new Uint8Array(fs.readFileSync(file));
    const t0 = Date.now();
    let res;
    try {
      res = await pdfText.pdfBytesToBlocks(bytes, { pdfjs });
    } catch (e) {
      console.log('  ERROR:', e.message);
      continue;
    }
    const doc = model.createDoc({
      title: res.meta.title || path.basename(file),
      meta: { author: res.meta.author, subject: res.meta.subject },
      blocks: res.blocks
    });
    const s = model.stats(doc);
    console.log(`  ${res.pages}/${res.pageCount} paginas en ${Date.now() - t0} ms`);
    console.log(`  meta:  autor="${doc.meta.author}" titulo="${res.meta.title}"`);
    console.log(`  stats: ${s.blocks} bloques, ${s.words} palabras, ${s.headings} titulos, ${s.images} imagenes, ${s.tables} tablas`);
    if (res.warnings.length) console.log('  avisos: ' + res.warnings.join(' | '));
    console.log('  --- outline:', JSON.stringify(model.outline(doc).slice(0, 12).map(h => 'H' + h.level + ' ' + h.text)));
    console.log('  --- texto (primeros 800 chars) ---');
    console.log(model.plainText(doc, { maxChars: 800 }).split('\n').map(l => '  | ' + l).join('\n'));
  }
  process.exit(0);
})().catch(e => { console.error('FALLO', e); process.exit(1); });