'use strict';
/**
 * tools/doc-editor-smoke.js
 *
 * Prueba la capa de escritura/guardado del modulo con un stub de Electron.
 * No abre la app: ejercita main._internals contra un directorio temporal.
 * printToPDF no se prueba acá (necesita una ventana real).
 *
 *   node tools/doc-editor-smoke.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

// ── Stub de electron ──────────────────────────────────────────────────────
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'doced-smoke-'));
const stub = {
  app: {
    getPath: () => tmpUserData,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  dialog: {},
  BrowserWindow: class {},
  shell: { showItemInFolder: () => {} }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
const stubEntry = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };
require.cache['electron-stub'] = stubEntry;
require.cache.electron_stub = stubEntry;

// ── Modulos ───────────────────────────────────────────────────────────────
const model = require('../modules/document-editor/core/model');
const zip = require('../modules/document-editor/core/zip');
const docxRead = require('../modules/document-editor/core/docx-read');
const main = require('../modules/document-editor/main');
const I = main._internals;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}

// PDF minimo valido (una pagina en blanco) con la tabla xref correcta: alcanza
// para ejercitar la regla de "un PDF de origen no se guarda en el sitio" sin
// depender de un archivo real del disco.
function MINIMAL_PDF() {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 20 100 Td (hola) Tj ET\nendstream\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return pdf;
}

const DOC = () => model.createDoc({
  title: 'Informe de prueba',
  meta: { author: 'MC Browser' },
  blocks: [
    { type: 'heading', level: 1, text: 'Informe de prueba' },
    { type: 'paragraph', text: 'Resumen ejecutivo del trimestre.' },
    { type: 'heading', level: 2, text: 'Contexto' },
    { type: 'paragraph', text: 'El equipo circulo el documento con exito.' },
    { type: 'list', ordered: false, items: ['Primer punto', 'Segundo punto'] },
    { type: 'quote', text: 'La informacion es el activo mas valioso.' },
    { type: 'code', text: 'const x = 1;' },
    { type: 'table', header: true, rows: [['Campo', 'Valor'], ['Estado', 'Activo']] },
    { type: 'pagebreak' },
    { type: 'paragraph', text: 'Segunda pagina del informe.' }
  ]
});

(async function run() {
  // ── Deteccion de formato ───────────────────────────────────────────────
  console.log('\nDeteccion de formato');
  t('extension .pdf', () => assert.strictEqual(I.formatFromExt('a.pdf'), 'pdf'));
  t('extension .docx sin distinguir mayusculas', () => assert.strictEqual(I.formatFromExt('a.DOCX'), 'docx'));
  t('extension .md / .markdown', () => {
    assert.strictEqual(I.formatFromExt('a.md'), 'md');
    assert.strictEqual(I.formatFromExt('a.markdown'), 'md');
  });
  t('extension .txt', () => assert.strictEqual(I.formatFromExt('a.txt'), 'txt'));
  t('extension desconocida', () => assert.strictEqual(I.formatFromExt('a.exe'), ''));
  t('sniff PDF por magic bytes', () => assert.strictEqual(I.sniff(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])), 'pdf'));
  t('sniff DOCX por magic bytes', () => assert.strictEqual(I.sniff(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), 'docx'));
  t('sniff texto plano no detecta nada', () => assert.strictEqual(I.sniff(Uint8Array.from([0x68, 0x6f, 0x6c, 0x61])), ''));

  // ── Permisos de ruta ───────────────────────────────────────────────────
  console.log('\nPermisos de ruta');
  t('una ruta no concedida se rechaza', () => {
    assert.strictEqual(I.isGranted(path.join(tmpUserData, 'nope.txt')), false);
  });
  t('grant abre una ruta concreta', () => {
    const p = path.join(tmpUserData, 'concedido.txt');
    I.grant(p);
    assert.strictEqual(I.isGranted(p), true);
  });
  t('una ruta vecina no se concede por compartir prefijo', () => {
    assert.strictEqual(I.isGranted(path.resolve(tmpUserData, '..', 'otro', 'x.txt')), false);
  });

  // ── Escritura del modelo ───────────────────────────────────────────────
  console.log('\nEscritura del modelo');
  await ta('DOCX se serializa y se relee con la misma estructura', async () => {
    const doc = DOC();
    const bytes = await I.docToBytes(doc, 'docx');
    assert.ok(bytes.length > 400, 'DOCX demasiado chico: ' + bytes.length);
    const back = await docxRead.docxBytesToDoc(bytes, {});
    assert.strictEqual(back.doc.title, doc.title);
    assert.strictEqual(back.doc.blocks.length, doc.blocks.length);
    assert.ok(back.doc.blocks.some(b => b.type === 'table'), 'la tabla no sobrevive el round-trip');
    assert.ok(back.doc.blocks.some(b => b.type === 'pagebreak'), 'el salto de pagina no sobrevive');
    assert.ok(back.doc.blocks.some(b => b.type === 'list'), 'la lista no sobrevive el round-trip');
  });
  await ta('TXT sale en texto plano sin HTML', async () => {
    const txt = zip.toStr(await I.docToBytes(DOC(), 'txt'));
    assert.ok(txt.includes('Resumen ejecutivo'), 'falta el texto en TXT');
    assert.ok(!txt.includes('<'), 'el TXT no debe traer HTML');
  });
  await ta('Markdown trae el titulo como H1', async () => {
    const md = zip.toStr(await I.docToBytes(DOC(), 'md'));
    assert.ok(/# Informe de prueba/.test(md), 'falta el H1: ' + md.slice(0, 80));
  });
  await ta('un formato que no se puede escribir tira error claro', async () => {
    await assert.rejects(() => I.docToBytes(DOC(), 'exe'), /No se puede escribir/);
  });

  // ── Apertura ───────────────────────────────────────────────────────────
  console.log('\nApertura de archivos');
  const txtPath = path.join(tmpUserData, 'notas.txt');
  fs.writeFileSync(txtPath, '# Notas\n\nPrimer parrafo.\n\n- uno\n- dos\n', 'utf8');
  I.grant(txtPath);

  await ta('abrir un TXT de verdad', async () => {
    const res = await I.openFile(txtPath, { withBytes: true });
    assert.strictEqual(res.error, undefined, res.error);
    assert.strictEqual(res.open, true);
    assert.strictEqual(res.format, 'txt');
    assert.strictEqual(res.dirty, false);
    assert.ok(res.doc.blocks.length >= 3, 'pocos bloques: ' + res.doc.blocks.length);
    assert.ok(res.doc.hash, 'falta el hash del documento');
    assert.strictEqual(res.capabilities.canSaveInPlace, true, 'un TXT se deberia poder guardar en el sitio');
  });
  await ta('abrir un archivo no concedido se rechaza', async () => {
    const otro = path.join(tmpUserData, 'privado.txt');
    fs.writeFileSync(otro, 'secreto', 'utf8');
    const res = await I.openFile(otro, {});
    assert.ok(res.error, 'deberia rechazar la ruta');
    assert.match(res.error, /Ruta no permitida/);
  });
  await ta('abrir un archivo inexistente da un error legible', async () => {
    const res = await I.openFile(path.join(tmpUserData, 'fantasma.txt'), {});
    assert.ok(res.error, 'deberia avisar que no existe');
  });
  await ta('abrir un formato no soportado se explica', async () => {
    const exe = path.join(tmpUserData, 'programa.exe');
    fs.writeFileSync(exe, 'MZ...', 'utf8');
    I.grant(exe);
    const res = await I.openFile(exe, {});
    assert.ok(res.error, 'deberia rechazar el formato');
    assert.match(res.error, /Formato no soportado/);
  });
  await ta('abrir un DOCX generado por el propio modulo', async () => {
    const p = path.join(tmpUserData, 'generado.docx');
    fs.writeFileSync(p, await I.docToBytes(DOC(), 'docx'));
    I.grant(p);
    const res = await I.openFile(p, {});
    assert.strictEqual(res.error, undefined, res.error);
    assert.strictEqual(res.format, 'docx');
    assert.strictEqual(res.capabilities.canSaveInPlace, true);
    assert.strictEqual(res.capabilities.isPdfSource, false);
  });

  // ── Guardado ───────────────────────────────────────────────────────────
  console.log('\nGuardado');
  await ta('guardar un TXT escribe el texto del documento abierto', async () => {
    await I.openFile(txtPath, {});
    const target = path.join(tmpUserData, 'guardado.txt');
    const snap = await I.saveTo(target, 'txt');
    assert.strictEqual(snap.error, undefined, snap.error);
    assert.strictEqual(snap.dirty, false);
    assert.strictEqual(snap.format, 'txt');
    const leido = fs.readFileSync(target, 'utf8');
    assert.ok(leido.includes('Primer parrafo'), 'el TXT guardado no tiene el texto del documento');
  });

  const docxTarget = path.join(tmpUserData, 'salida.docx');
  fs.writeFileSync(docxTarget, 'contenido viejo que debe quedar en backup', 'utf8');
  await ta('guardar encima crea copia de seguridad del original', async () => {
    const snap = await I.saveTo(docxTarget, 'docx');
    assert.strictEqual(snap.error, undefined, snap.error);
    const backups = fs.readdirSync(path.join(tmpUserData, 'doc-editor', 'backups'));
    assert.ok(backups.length >= 1, 'no se creo ningun backup');
    const b = path.join(tmpUserData, 'doc-editor', 'backups', backups[0]);
    assert.strictEqual(fs.readFileSync(b, 'utf8'), 'contenido viejo que debe quedar en backup');
  });
  await ta('el DOCX guardado conserva los bloques del documento que estaba abierto', async () => {
    const abiertos = main.getState().doc.blocks.length;
    const res = await I.openFile(docxTarget, {});
    assert.strictEqual(res.error, undefined, res.error);
    assert.strictEqual(res.format, 'docx');
    assert.strictEqual(res.doc.blocks.length, abiertos, 'bloques perdidos en el round-trip por disco');
    assert.ok(res.doc.hash, 'falta el hash tras reabrir');
  });

  // ── Patches: una sola via para el usuario y la IA ──────────────────────
  console.log('\nParches');
  await ta('un parche valido cambia el documento y lo marca sucio', async () => {
    await I.openFile(docxTarget, {});
    const st = main.getState();
    const res = I.applyUserPatch({
      expectedHash: st.doc.hash,
      ops: [{ op: 'setTitle', title: 'Informe corregido' }]
    }, 'test');
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    assert.strictEqual(res.doc.title, 'Informe corregido');
    assert.strictEqual(res.dirty, true);
  });
  await ta('deshacer y rehacer restauran el documento y actualizan disponibilidad', async () => {
    const before = main.getState();
    const edited = I.applyUserPatch({
      expectedHash: before.doc.hash,
      ops: [{ op: 'setTitle', title: 'Cambio reversible' }]
    }, 'test');
    assert.strictEqual(edited.ok, true);
    assert.strictEqual(edited.history.canUndo, true);
    assert.strictEqual(edited.history.canRedo, false);

    const undone = I.travelDocumentHistory('undo');
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(undone.doc.title, before.doc.title);
    assert.strictEqual(undone.history.canRedo, true);

    const redone = I.travelDocumentHistory('redo');
    assert.strictEqual(redone.ok, true);
    assert.strictEqual(redone.doc.title, 'Cambio reversible');
    assert.strictEqual(redone.history.canUndo, true);
    assert.strictEqual(redone.history.canRedo, false);
  });
  await ta('un hash viejo se rechaza como documento obsoleto', async () => {
    const res = I.applyUserPatch({ expectedHash: 'hash-inventado', ops: [{ op: 'setTitle', title: 'x' }] }, 'test');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'stale_document');
    assert.ok(res.hash && res.hash !== 'hash-inventado', 'deberia devolver el hash actual para reintentar');
  });
  await ta('sin expectedHash no se aplica nada', async () => {
    const res = I.applyUserPatch({ ops: [{ op: 'setTitle', title: 'x' }] }, 'test');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'missing_hash');
  });
  await ta('un parche invalido deja el documento intacto', async () => {
    const antes = main.getState();
    const res = I.applyUserPatch({
      expectedHash: antes.doc.hash,
      ops: [{ op: 'delete', find: 'texto que no existe en el documento' }]
    }, 'test');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'patch_failed');
    assert.strictEqual(main.getState().doc.hash, antes.doc.hash, 'el documento no deberia haber cambiado');
  });

  // ── PDF de origen: nunca se guarda en el sitio ─────────────────────────
  console.log('\nPDF como origen');
  const pdfPath = path.join(tmpUserData, 'origen.pdf');
  // PDF minimo valido (1 pagina en blanco) escrito a mano.
  fs.writeFileSync(pdfPath, MINIMAL_PDF(), 'latin1');
  I.grant(pdfPath);
  await ta('un PDF se abre pero no se puede guardar en el sitio', async () => {
    const res = await I.openFile(pdfPath, {});
    assert.strictEqual(res.error, undefined, res.error);
    assert.strictEqual(res.format, 'pdf');
    assert.strictEqual(res.capabilities.isPdfSource, true);
    // Regresion: antes savedFormat pasaba a 'docx' y doc:save escribia bytes
    // DOCX encima del .pdf.
    assert.strictEqual(res.capabilities.canSaveInPlace, false, 'un PDF no deberia poder guardarse en el sitio');
    assert.strictEqual(res.savedFormat, 'pdf', 'savedFormat deberia seguir siendo pdf');
  });
  await ta('guardar un PDF de origen pide Guardar como en vez de tocar el archivo', async () => {
    const antes = fs.readFileSync(pdfPath, 'latin1');
    const res = await I.saveInPlace();
    assert.strictEqual(res.needsSaveAs, true, 'deberia pedir Guardar como');
    assert.match(res.error, /Guardar como/);
    assert.strictEqual(fs.readFileSync(pdfPath, 'latin1'), antes, 'el PDF no se debe haber tocado');
    assert.strictEqual(main.getState().sourcePath, pdfPath, 'el documento sigue siendo el PDF abierto');
  });

  // ── Asociacion de archivos (argv de Windows/Linux) ─────────────────────
  console.log('\nAsociacion de archivos');
  await ta('extractDocumentPath encuentra el documento entre los argumentos', () => {
    const argv = ['C:\\Program Files\\MC Browser\\MC Browser.exe', '--enable-features=X', pdfPath, '--no-sandbox'];
    assert.strictEqual(main.extractDocumentPath(argv), pdfPath);
  });
  await ta('extractDocumentPath ignora switches y rutas que no son documentos', () => {
    assert.strictEqual(main.extractDocumentPath(['app.exe', '--flag', 'https://ejemplo.com']), '');
    assert.strictEqual(main.extractDocumentPath(['app.exe', path.join(tmpUserData, 'no-existe.pdf')]), '');
    assert.strictEqual(main.extractDocumentPath([]), '');
    assert.strictEqual(main.extractDocumentPath(null), '');
  });
  await ta('handleExternalOpen concede la ruta y deja el documento abierto', async () => {
    const txtExterno = path.join(tmpUserData, 'externo.txt');
    fs.writeFileSync(txtExterno, 'abierto desde el sistema operativo\n', 'utf8');
    // Sin Grant previo: esto es lo que llega al hacer doble clic en el archivo.
    const res = await main.handleExternalOpen(txtExterno);
    assert.strictEqual(res.error, undefined, res.error);
    assert.strictEqual(res.open, true);
    assert.strictEqual(res.sourceName, 'externo.txt');
    assert.strictEqual(main.isOpen(), true);
    // Queda concedido, asi que despues se puede guardar sin volver a pickear.
    assert.strictEqual(I.isGranted(txtExterno), true);
  });
  await ta('handleExternalOpen con una ruta vacia no rompe', async () => {
    const res = await main.handleExternalOpen('');
    assert.ok(res.error, 'deberia avisar de ruta vacia');
  });

  console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron\n');
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\nsmoke fallo de forma inesperada:', e && e.stack || e);
  process.exit(1);
});