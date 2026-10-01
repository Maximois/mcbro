'use strict';
/**
 * tools/doc-editor-worker.js
 *
 * Verifica el worker de extracción por sí solo: arranca un worker_threads
 * real y le manda documentos de verdad (TXT, DOCX y, si está, un PDF).
 *
 *   node tools/doc-editor-worker.js [ruta.pdf]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, '..', 'modules', 'document-editor', 'worker.js');
const model = require('../modules/document-editor/core/model');
const docxWrite = require('../modules/document-editor/core/docx-write');
const zip = require('../modules/document-editor/core/zip');
const textIo = require('../modules/document-editor/core/text-io');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}

let seq = 0;
const pending = new Map();
const worker = new Worker(WORKER);
worker.on('message', (msg) => {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.type === 'error') entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
});
worker.on('error', (e) => {
  for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(e); }
  pending.clear();
});

function ask(payload, timeoutMs) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('el worker no respondio en ' + timeoutMs + ' ms'));
    }, timeoutMs || 60000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ ...payload, id });
  });
}

(async function run() {
  console.log('\nWorker de extraccion');

  await ta('responde y queda vivo entre mensajes', async () => {
    const r = await ask({ type: 'extract', format: 'txt', sourcePath: 'notas.txt', data: Array.from(Buffer.from('Hola', 'utf8')) }, 15000);
    assert.strictEqual(r.blocks.length, 1);
    assert.strictEqual(model.blockText(r.blocks[0]).trim(), 'Hola');
  });

  await ta('lee un TXT con acentos y ñ', async () => {
    const texto = 'El pingüino anda rápido por la mañana.\nSegunda línea con tilde: hace más frío.';
    const r = await ask({ type: 'extract', format: 'txt', sourcePath: 'x.txt', data: Array.from(Buffer.from(texto, 'utf8')) }, 15000);
    const todo = model.plainText({ blocks: r.blocks });
    assert.ok(todo.includes('pingüino'), 'perdio la diacritica');
    assert.ok(todo.includes('rápido'), 'perdio la tilde');
    assert.ok(todo.includes('más'), 'perdio la tilde final');
  });

  await ta('extrae estructura de Markdown', async () => {
    const md = '# Titulo\n\nParrafo uno.\n\n## Sub\n\n- a\n- b\n\n> cita\n\n```js\nconst x=1;\n```\n';
    const r = await ask({ type: 'extract', format: 'md', sourcePath: 'x.md', data: Array.from(Buffer.from(md, 'utf8')) }, 15000);
    const tipos = r.blocks.map(b => b.type);
    assert.ok(tipos.includes('heading'), 'no hay heading');
    assert.ok(tipos.includes('list'), 'no hay lista');
    assert.ok(tipos.includes('quote'), 'no hay cita');
    assert.ok(tipos.includes('code'), 'no hay bloque de codigo');
    assert.strictEqual(tipos.filter(t => t === 'heading').length, 2, 'deberian ser 2 titulos');
  });

  await ta('lee un DOCX con tabla, lista e imagen', async () => {
    const doc = model.createDoc({
      title: 'Con tabla',
      meta: { author: 'MC' },
      blocks: [
        { type: 'heading', level: 1, text: 'Con tabla' },
        { type: 'paragraph', text: 'Texto con **negrita** adentro.' },
        { type: 'list', ordered: true, items: ['Uno', 'Dos', 'Tres'] },
        { type: 'table', header: true, rows: [['A', 'B'], ['1', '2']] },
        {
          type: 'image',
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          alt: 'pixel'
        },
        { type: 'pagebreak' },
        { type: 'paragraph', text: 'Despues del salto.' }
      ]
    });
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    // writeZip es async: usa CompressionStream cuando esta disponible.
    const bytes = await zip.writeZip(parts);
    const r = await ask({ type: 'extract', format: 'docx', sourcePath: 'prueba.docx', data: Array.from(bytes) }, 30000);
    const tipos = r.blocks.map(b => b.type);
    assert.strictEqual(r.title, 'Con tabla', 'titulo: ' + r.title);
    assert.ok(tipos.includes('table'), 'no hay tabla');
    assert.ok(tipos.includes('list'), 'no hay lista');
    assert.ok(tipos.includes('image'), 'no hay imagen');
    assert.ok(tipos.includes('pagebreak'), 'no hay salto de pagina');
    assert.ok(r.warnings.length === 0, 'warnings inesperados: ' + JSON.stringify(r.warnings));
  });

  await ta('un DOCX roto devuelve error, no revienta', async () => {
    const roto = zip.writeZip([{ name: '[Content_Types].xml', data: Buffer.from('<no-es-docx') }]);
    await assert.rejects(
      () => ask({ type: 'extract', format: 'docx', sourcePath: 'roto.docx', data: Array.from(roto) }, 15000),
      /./,
      'deberia rechazar el archivo'
    );
  });

  await ta('un formato desconocido se rechaza', async () => {
    await assert.rejects(
      () => ask({ type: 'extract', format: 'exe', sourcePath: 'x.exe', data: [1, 2, 3] }, 15000),
      /Formato no soportado/
    );
  });

  const pdfArg = process.argv[2];
  const candidatos = pdfArg
    ? [pdfArg]
    : ['C:\\Downloads\\CV Victor Gonzales.pdf'].filter(p => fs.existsSync(p));
  for (const pdf of candidatos) {
    await ta('extrae un PDF real: ' + path.basename(pdf), async () => {
      const bytes = new Uint8Array(fs.readFileSync(pdf));
      const t0 = Date.now();
      const r = await ask({ type: 'extract', format: 'pdf', sourcePath: pdf, data: Array.from(bytes) }, 120000);
      const ms = Date.now() - t0;
      assert.ok(r.blocks.length > 0, 'no devolvio bloques');
      assert.ok(r.pageCount >= 1, 'no informo paginas: ' + r.pageCount);
      const txt = model.plainText({ blocks: r.blocks });
      assert.ok(txt.length > 100, 'salio casi vacio (' + txt.length + ' chars)');
      console.log(`       ${r.blocks.length} bloques, ${r.pageCount} paginas, ${txt.length} chars en ${ms} ms`);
    });
  }

  await ta('respeta el limite de paginas', async () => {
    const bytes = fs.existsSync('C:\\Downloads\\CV Victor Gonzales.pdf')
      ? new Uint8Array(fs.readFileSync('C:\\Downloads\\CV Victor Gonzales.pdf'))
      : null;
    if (!bytes) { console.log('       (omitido: no hay PDF de prueba)'); return; }
    const r = await ask({ type: 'extract', format: 'pdf', sourcePath: 'x.pdf', data: Array.from(bytes), limits: { maxPages: 1 } }, 60000);
    assert.ok(r.blocks.length > 0, 'con 1 pagina deberia devolver algo');
    assert.ok(r.pageCount <= 1, 'ignoro el limite: ' + r.pageCount);
  });

  await ta('sigue respondiendo despues de un error', async () => {
    const r = await ask({ type: 'extract', format: 'txt', sourcePath: 'ok.txt', data: Array.from(Buffer.from('Sigue vivo', 'utf8')) }, 15000);
    assert.ok(model.plainText({ blocks: r.blocks }).includes('Sigue vivo'));
  });

  console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron\n');
  await worker.terminate();
  void os; void textIo;
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nfallo inesperado:', e && e.stack || e);
  await worker.terminate();
  process.exit(1);
});