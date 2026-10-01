'use strict';
/**
 * Round-trip y lectura de .docx reales.
 * Uso: node tools/docx-read.js [archivo.docx ...]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const C = (n) => require(path.join(root, 'modules/document-editor/core', n));

const model = C('model.js');
const zip = C('zip.js');
const docxWrite = C('docx-write.js');
const docxRead = C('docx-read.js');

const args = process.argv.slice(2);
const files = args.length ? args : [path.join(require('os').tmpdir(), 'mc-docx-smoke.docx')];

(async () => {
  for (const file of files) {
    console.log('\n=== ' + file);
    if (!fs.existsSync(file)) { console.log('  (no existe)'); continue; }
    const bytes = new Uint8Array(fs.readFileSync(file));
    let res;
    try {
      res = await docxRead.docxBytesToDoc(bytes, { sourcePath: file });
    } catch (e) {
      console.log('  ERROR:', e.message);
      continue;
    }
    const doc = res.doc;
    const s = model.stats(doc);
    console.log(`  titulo: ${doc.title}`);
    console.log(`  meta:   autor="${doc.meta.author}" asunto="${doc.meta.subject}"`);
    console.log(`  stats:  ${s.blocks} bloques, ${s.words} palabras, ${s.headings} titulos, ${s.images} imagenes, ${s.tables} tablas`);
    console.log('  --- outline:', JSON.stringify(model.outline(doc).map(h => 'H' + h.level + ' ' + h.text)));
    console.log('  --- texto (primeros 700 chars) ---');
    console.log(model.plainText(doc, { maxChars: 700 }).split('\n').map(l => '  | ' + l).join('\n'));
  }
})().catch(e => { console.error('FALLO', e); process.exit(1); });
