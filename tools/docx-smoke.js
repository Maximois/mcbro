'use strict';
/**
 * Smoke test manual del export DOCX: arma un modelo varied, lo empaqueta y lo
 * guarda en disco para validarlo con una herramienta externa (Word/LibreOffice/
 * .NET) y con el lector del propio modulo.
 *
 * Uso: node tools/docx-smoke.js [salida.docx]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const model = require(path.join(root, 'modules/document-editor/core/model.js'));
const zip = require(path.join(root, 'modules/document-editor/core/zip.js'));
const docxWrite = require(path.join(root, 'modules/document-editor/core/docx-write.js'));

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const doc = model.createDoc({
  title: 'Prueba de exportacion DOCX',
  meta: { author: 'MC Browser', subject: 'smoke test' },
  blocks: [
    { type: 'heading', level: 1, text: 'Titulo principal' },
    { type: 'paragraph', text: 'Parrafo con <caracteres> & "comillas" y acentos: áéíóú ñ.' },
    { type: 'heading', level: 2, text: 'Subtitulo' },
    { type: 'paragraph', runs: [
      { text: 'Un fragmento ' },
      { text: 'en negrita', bold: true },
      { text: ' y otro en ' },
      { text: 'cursiva', italic: true },
      { text: '.' }
    ] },
    { type: 'list', items: ['Primero', 'Segundo', 'Tercero'], ordered: true },
    { type: 'list', items: ['vino', 'pera'], ordered: false },
    { type: 'quote', text: 'Una cita textual.' },
    { type: 'code', text: 'const x = 1 < 2 && 3 > 2;' },
    { type: 'table', rows: [['Columna A', 'Columna B'], ['a1', 'b1'], ['a2', 'b2']], header: true },
    { type: 'image', src: PNG_1PX, alt: 'Pixel de prueba' },
    { type: 'pagebreak' },
    { type: 'paragraph', text: 'Despues del salto de pagina.', align: 'center' },
    { type: 'hr' }
  ]
});

(async () => {
  const { parts, warnings, mediaCount } = docxWrite.docToDocxParts(doc, { warnings: [] });
  const bytes = await zip.writeZip(parts);
  const out = process.argv[2] || path.join(require('os').tmpdir(), 'mc-docx-smoke.docx');
  fs.writeFileSync(out, bytes);
  console.log('escrito:', out, bytes.length, 'bytes');
  console.log('partes:', parts.map(p => p.name).join(', '));
  console.log('advertencias:', warnings.join('; ') || '(ninguna)', '| media:', mediaCount);
})().catch(e => { console.error('FALLO', e); process.exit(1); });
