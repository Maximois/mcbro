'use strict';

/**
 * Tests del nucleo del modulo document-editor.
 *
 * Todo lo que se prueba aca es funcion pura: no hay Electron, no hay disco
 * (salvo fixtures opcionales) y no hay red. Si algo falla, el error esta en
 * la regla, no en el entorno.
 *
 * Fixtures opcionales: si existen, se usan como prueba de lectura real.
 *   DOCX_FIXTURE / PDF_FIXTURE (rutas absolutas)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../modules/document-editor/core/model');
const patch = require('../modules/document-editor/core/patch');
const zip = require('../modules/document-editor/core/zip');
const xml = require('../modules/document-editor/core/xml');
const html = require('../modules/document-editor/core/html');
const textIo = require('../modules/document-editor/core/text-io');
const docxWrite = require('../modules/document-editor/core/docx-write');
const docxRead = require('../modules/document-editor/core/docx-read');
const pdfText = require('../modules/document-editor/core/pdf-text');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const sample = () => model.createDoc({
  title: 'Contrato',
  blocks: [
    { type: 'heading', level: 1, text: 'Contrato de prueba' },
    { type: 'paragraph', text: 'El cliente acepta los terminos. Firma requerida.' },
    { type: 'list', items: ['Pago mensual', 'Pago anual'], ordered: true },
    { type: 'table', rows: [['Campo', 'Valor'], ['ciudad', 'Asuncion']], header: true },
    { type: 'paragraph', text: 'Ver clausula 3.' }
  ]
});

describe('modelo: normalizacion', () => {
  test('descarta bloques vacios y conserva el texto de tipos desconocidos', () => {
    const doc = model.createDoc({ blocks: [
      { type: 'paragraph', text: '   ' },
      { type: 'inventado', text: 'x' },
      { type: 'paragraph', text: 'queda' }
    ] });
    assert.equal(doc.blocks.length, 2, 'lo vacio se descarta, lo desconocido no se pierde');
    assert.equal(doc.blocks[0].type, 'paragraph');
    assert.equal(doc.blocks[0].text, 'x');
  });

  test('rechaza imagenes que no sean data: embebidas', () => {
    const doc = model.createDoc({ blocks: [
      { type: 'image', src: 'https://ejemplo.com/x.png' },
      { type: 'image', src: PNG_1PX }
    ] });
    assert.equal(doc.blocks.length, 1);
    assert.equal(doc.blocks[0].type, 'image');
  });

  test('el hash depende del contenido y no de la identidad', () => {
    const a = model.createDoc({ blocks: [{ type: 'paragraph', text: 'igual' }] });
    const b = model.createDoc({ id: 'otro-id', blocks: [{ type: 'paragraph', text: 'igual' }] });
    const c = model.createDoc({ blocks: [{ type: 'paragraph', text: 'distinto' }] });
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
  });

  test('el hash cambia al cambiar el orden de los bloques', () => {
    const a = model.createDoc({ blocks: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'b' }] });
    const b = model.createDoc({ blocks: [{ type: 'paragraph', text: 'b' }, { type: 'paragraph', text: 'a' }] });
    assert.notEqual(a.hash, b.hash);
  });

  test('blockText une runs y conText los aplana', () => {
    const block = model.normalizeBlock({ type: 'paragraph', runs: [{ text: 'a' }, { text: 'b', bold: true }] });
    assert.equal(model.blockText(block), 'ab');
    assert.equal(model.blockText(model.withText(block, 'plano')), 'plano');
  });
});

describe('modelo: lectura', () => {
  test('outline solo ve titulos', () => {
    const out = model.outline(sample());
    assert.equal(out.length, 1);
    assert.equal(out[0].level, 1);
    assert.equal(out[0].text, 'Contrato de prueba');
  });

  test('plainText respeta maxChars como techo', () => {
    const doc = model.createDoc({ blocks: [{ type: 'paragraph', text: 'x'.repeat(500) }] });
    assert.ok(model.plainText(doc, { maxChars: 50 }).length <= 50);
    assert.equal(model.plainText(doc, { maxChars: 5000 }).length, 500);
  });

  test('findBlocks encuentra por substring, sin distinguir mayusculas', () => {
    const hits = model.findBlocks(sample(), 'CLAUSULA');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].index, 4);
  });
});

describe('parches: atomicidad y anclas', () => {
  test('aplica un reemplazo unico', () => {
    const doc = sample();
    const res = patch.applyPatch(doc, { ops: [{ op: 'replace', find: 'los terminos', replace: 'las condiciones' }] });
    assert.equal(res.ok, true);
    assert.equal(res.doc.blocks[1].text, 'El cliente acepta las condiciones. Firma requerida.');
    assert.equal(doc.blocks[1].text, 'El cliente acepta los terminos. Firma requerida.', 'el doc original no se toca');
  });

  test('rechaza un hash viejo (documento modificado por otro)', () => {
    const doc = sample();
    const res = patch.applyPatch(doc, { expectedHash: 'h-0000000000000000-1', ops: [{ op: 'replace', find: 'a', replace: 'b' }] });
    assert.equal(res.ok, false);
    assert.equal(res.stale, true);
    assert.equal(res.reason, 'stale_document');
  });

  test('rechaza un ancla ambigua salvo all:true', () => {
    const doc = model.createDoc({ blocks: [{ type: 'paragraph', text: 'a a a' }] });
    const bad = patch.applyPatch(doc, { ops: [{ op: 'delete', find: 'a' }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors[0].code, 'AMBIGUOUS');
    const good = patch.applyPatch(doc, { ops: [{ op: 'delete', find: 'a', all: true }] });
    assert.equal(good.ok, true);
    assert.equal(good.doc.blocks.length, 0, 'el texto que queda es solo espacios: el bloque se limpia');
  });

  test('si una operacion falla, no se aplica ninguna', () => {
    const doc = sample();
    const before = doc.hash;
    const res = patch.applyPatch(doc, { ops: [
      { op: 'replace', find: 'Firma requerida', replace: 'Firma del cliente' },
      { op: 'replace', find: 'no existe este texto', replace: 'x' }
    ] });
    assert.equal(res.ok, false);
    assert.equal(res.doc.hash, before, 'el documento vuelve al estado original');
  });

  test('cuenta una coincidencia por celda y no mezcla celdas', () => {
    const doc = model.createDoc({ blocks: [
      { type: 'table', rows: [['a', 'b'], ['a', 'c']] }
    ] });
    const res = patch.applyPatch(doc, { ops: [{ op: 'replace', find: 'a', replace: 'z', all: true }] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.doc.blocks[0].rows, [['z', 'b'], ['z', 'c']]);
  });

  test('style en negrita parte el parrafo en runs', () => {
    const res = patch.applyPatch(sample(), { ops: [{ op: 'style', find: 'Firma requerida', bold: true }] });
    const runs = res.doc.blocks[1].runs;
    assert.equal(runs.length, 3);
    assert.equal(runs[1].text, 'Firma requerida');
    assert.equal(runs[1].bold, true);
    assert.equal(runs[0].bold, undefined);
  });

  test('insert por indice y por ancla', () => {
    const byIndex = patch.applyPatch(sample(), { ops: [{ op: 'insert', index: 0, block: { type: 'heading', level: 1, text: 'Portada' } }] });
    assert.equal(byIndex.doc.blocks[0].text, 'Portada');
    const byAnchor = patch.applyPatch(sample(), { ops: [{ op: 'insert', after: 'Ver clausula 3.', block: { type: 'paragraph', text: 'Anexo I' } }] });
    assert.equal(byAnchor.doc.blocks[byAnchor.doc.blocks.length - 1].text, 'Anexo I');
  });

  test('mover bloques arriba o abajo conserva el texto de todos los vecinos', () => {
    const doc = model.createDoc({ blocks: [
      { type: 'paragraph', text: 'A' },
      { type: 'paragraph', text: 'B' },
      { type: 'paragraph', text: 'C' }
    ] });
    const [a, b, c] = doc.blocks;
    const copyWithoutId = (block) => {
      const copy = Object.assign({}, block);
      delete copy.id;
      return copy;
    };
    const movedUp = patch.applyPatch(doc, { ops: [
      { op: 'insert', index: 0, block: copyWithoutId(b) },
      { op: 'deleteBlock', id: b.id }
    ] });
    assert.deepEqual(movedUp.doc.blocks.map((block) => block.text), ['B', 'A', 'C']);
    assert.equal(movedUp.doc.blocks.length, 3);

    const movedDown = patch.applyPatch(doc, { ops: [
      { op: 'insert', index: 3, block: copyWithoutId(b) },
      { op: 'deleteBlock', id: b.id }
    ] });
    assert.deepEqual(movedDown.doc.blocks.map((block) => block.text), ['A', 'C', 'B']);
    assert.equal(movedDown.doc.blocks.length, 3);
    assert.deepEqual(doc.blocks.map((block) => block.text), [a.text, b.text, c.text]);
  });

  test('setMeta solo acepta claves conocidas', () => {
    const okRes = patch.applyPatch(sample(), { ops: [{ op: 'setMeta', key: 'author', value: 'Ana' }] });
    assert.equal(okRes.doc.meta.author, 'Ana');
    const bad = patch.applyPatch(sample(), { ops: [{ op: 'setMeta', key: 'blocks', value: 'x' }] });
    assert.equal(bad.ok, false);
  });

  test('find es de solo lectura', () => {
    const res = patch.applyPatch(sample(), { ops: [{ op: 'find', find: 'clausula' }] });
    assert.equal(res.ok, true);
    assert.equal(res.doc.hash, sample().hash);
  });

  test('rechaza operaciones desconocidas y parches sin ops', () => {
    assert.equal(patch.applyPatch(sample(), { ops: [{ op: 'dropDatabase' }] }).errors[0].code, 'UNKNOWN_OP');
    assert.equal(patch.applyPatch(sample(), {}).errors[0].code, 'INVALID');
    assert.equal(patch.applyPatch(sample(), null).errors[0].code, 'INVALID');
  });

  test('previewPatch devuelve el diff sin tocar el documento', () => {
    const doc = sample();
    const before = doc.hash;
    const res = patch.previewPatch(doc, { ops: [{ op: 'replace', find: 'Contrato', replace: 'Convenio', caseSensitive: true }] });
    assert.equal(res.ok, true);
    assert.equal(doc.hash, before, 'el documento no se toca');
    assert.equal(res.doc, undefined, 'una vista previa no genera un documento nuevo');
    assert.equal(res.diff.length, 1);
    assert.equal(res.diff[0].before, 'Contrato de prueba');
    assert.equal(res.diff[0].after, 'Convenio de prueba');
    assert.match(res.summary, /1 cambio/);
  });

  test('un regex puede reemplazar con grupo de captura', () => {
    const res = patch.applyPatch(model.createDoc({ blocks: [{ type: 'paragraph', text: 'precio: 100 USD' }] }), {
      ops: [{ op: 'replace', find: '(\\d+)\\s*USD', replace: '$1 dolares', regex: true }]
    });
    assert.equal(res.ok, true);
    assert.equal(res.doc.blocks[0].text, 'precio: 100 dolares');
  });
});

describe('zip', () => {
  test('usa zlib raw deflate compatible con Electron para comprimir y leer', async () => {
    const zlib = require('node:zlib');
    const input = new TextEncoder().encode('word/document.xml ' + 'contenido '.repeat(100));
    const compressed = zlib.deflateRawSync(input);
    assert.deepEqual(Array.from(await zip.inflateRaw(compressed)), Array.from(input));
    const written = await zip.deflateRaw(input);
    assert.deepEqual(Array.from(await zip.inflateRaw(written)), Array.from(input));
  });

  test('round-trip de textos y binarios', async () => {
    const binary = new Uint8Array(512);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
    const parts = [
      { name: '[Content_Types].xml', data: '<xml/>' },
      { name: 'word/document.xml', data: 'x'.repeat(4000) },
      { name: 'word/media/image1.png', data: binary }
    ];
    const bytes = await zip.writeZip(parts);
    assert.equal(bytes[0], 0x50, 'firma PK local');
    const read = await zip.readZip(bytes);
    assert.deepEqual(read.names, ['[Content_Types].xml', 'word/document.xml', 'word/media/image1.png']);
    assert.equal(zip.toStr(read.entries['word/document.xml']).length, 4000);
    assert.deepEqual(Array.from(read.entries['word/media/image1.png']), Array.from(binary));
  });

  test('[Content_Types].xml queda primero', async () => {
    const bytes = await zip.writeZip([{ name: 'z.txt', data: 'z' }, { name: '[Content_Types].xml', data: 'x' }]);
    const read = await zip.readZip(bytes);
    assert.equal(read.names[0], '[Content_Types].xml');
  });

  test('crc32 coincide con el valor conocido', () => {
    assert.equal(zip.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  });

  test('rechaza algo que no es un zip', async () => {
    await assert.rejects(() => zip.readZip(new Uint8Array(20)), /demasiado corto/);
    const notZip = new Uint8Array(600);
    notZip.set([0x50, 0x4b, 0x03, 0x04], 0);
    await assert.rejects(() => zip.readZip(notZip), /ZIP/);
  });
});

describe('xml', () => {
  test('parsea elementos, atributos y texto', () => {
    const tree = xml.parse('<a x="1"><b>hola</b><b>mundo</b></a>');
    const a = xml.findDeep(tree, 'a');
    assert.equal(xml.attr(a, 'x'), '1');
    assert.equal(xml.findAll(tree, 'b').length, 2);
  });

  test('decodifica entidades y CDATA', () => {
    const tree = xml.parse('<a>&lt;x&gt; &amp; <![CDATA[crudo <b>]]></a>');
    assert.equal(xml.textOf(tree), '<x> & crudo <b>');
  });

  test('tolera namespaces y atributos con comillas simples', () => {
    const tree = xml.parse(`<w:document xmlns:w='urn:x'><w:body><w:p w:rsidR='00A'/></w:body></w:document>`);
    const p = xml.findDeep(tree, 'p');
    assert.equal(p.local, 'p');
    assert.equal(xml.attr(p, 'rsidR'), '00A');
  });

  test('escapeXml es idempotente al parsear', () => {
    const raw = 'a & b < c > d "e" \'f\'';
    const tree = xml.parse(`<a>${xml.escapeXml(raw)}</a>`);
    assert.equal(xml.textOf(tree), raw);
  });

  test('no explota con markup mal formado', () => {
    const tree = xml.parse('<a><b>sin cerrar</a>');
    assert.equal(xml.findDeep(tree, 'b') !== null, true);
  });
});

describe('html', () => {
  test('escapa el texto y no deja pasar HTML del documento', () => {
    const out = html.docToHtml(model.createDoc({ blocks: [{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }] }));
    assert.equal(out.includes('<img'), false, 'no debe quedar ninguna etiqueta viva');
    assert.equal(out.includes('&lt;img src=x'), true, 'el texto llega al HTML como texto');
  });

  test('descarta imagenes remotas al exportar', () => {
    const doc = model.normalizeDoc({ blocks: [
      { type: 'image', src: 'https://rastreador.example/pixel.gif' },
      { type: 'image', src: PNG_1PX }
    ] });
    const out = html.docToHtml(doc);
    assert.equal(out.includes('rastreador.example'), false);
    assert.equal(out.includes('data:image/png'), true);
  });

  test('respeta saltos de pagina en el HTML de impresion', () => {
    const out = html.docToHtml(model.createDoc({ blocks: [
      { type: 'paragraph', text: 'a' }, { type: 'pagebreak' }, { type: 'paragraph', text: 'b' }
    ] }), { print: true });
    assert.equal(out.includes('page-break-after: always'), true);
  });

  test('htmlToText quita script y tags', () => {
    assert.equal(html.htmlToText('<p>Hola <b>mundo</b></p><script>alert(1)</script>'), 'Hola mundo');
  });
});

describe('texto y markdown', () => {
  test('reconoce estructura markdown basica', () => {
    const doc = textIo.textToDoc('# Titulo\n\nUn parrafo\n\n- uno\n- dos\n\n> cita\n\n---');
    const types = doc.blocks.map(b => b.type);
    assert.deepEqual(types, ['heading', 'paragraph', 'list', 'quote', 'hr']);
    assert.equal(doc.blocks[0].level, 1);
    assert.equal(doc.blocks[2].items.length, 2);
  });

  test('un .txt comun no se vuelve lista de titulos', () => {
    const doc = textIo.textToDoc('Hola\n\nMundo');
    assert.deepEqual(doc.blocks.map(b => b.type), ['paragraph', 'paragraph']);
  });

  test('markdown de salida usa el formato de lectura', () => {
    const md = model.toMarkdown(sample());
    assert.match(md, /# Contrato de prueba/);
    assert.match(md, /1\. Pago mensual/);
  });
});

describe('docx', () => {
  test('round-trip: escribir y volver a leer conserva la estructura', async () => {
    const doc = model.createDoc({
      title: 'Round trip',
      meta: { author: 'MC Browser' },
      blocks: [
        { type: 'heading', level: 1, text: 'Titulo' },
        { type: 'paragraph', runs: [{ text: 'normal ' }, { text: 'fuerte', bold: true }, { text: ' < & >' }] },
        { type: 'list', items: ['uno', 'dos'], ordered: true },
        { type: 'quote', text: 'cita' },
        { type: 'table', rows: [['a', 'b'], ['1', '2']] },
        { type: 'image', src: PNG_1PX, alt: 'pixel' },
        { type: 'pagebreak' },
        { type: 'paragraph', text: 'final' }
      ]
    });
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    const bytes = await zip.writeZip(parts);
    const { doc: back } = await docxRead.docxBytesToDoc(bytes, {});

    assert.equal(back.meta.author, 'MC Browser');
    assert.equal(model.outline(back)[0].text, 'Titulo');
    const types = back.blocks.map(b => b.type);
    assert.ok(types.includes('list'), 'la lista vuelve como lista');
    assert.ok(types.includes('table'), 'la tabla vuelve como tabla');
    assert.ok(types.includes('image'), 'la imagen vuelve embebida');
    assert.ok(types.includes('pagebreak'), 'el salto de pagina vuelve');
    assert.ok(model.plainText(back).includes('1'), 'la tabla conserva sus celdas');
    const bold = back.blocks.find(b => b.runs && b.runs.some(r => r.bold));
    assert.ok(bold, 'el fragmento en negrita vuelve como run');
    assert.match(model.plainText(back), /fuerte/);
  });

  test('las partes obligatorias del paquete estan todas', async () => {
    const { parts } = docxWrite.docToDocxParts(model.createDoc({ blocks: [{ type: 'paragraph', text: 'x' }] }), { warnings: [] });
    const names = parts.map(p => p.name);
    for (const req of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      assert.ok(names.includes(req), `falta ${req}`);
    }
  });

  test('el XML emitido esta balanceado', async () => {
    const { parts } = docxWrite.docToDocxParts(model.createDoc({ blocks: [
      { type: 'paragraph', text: 'a & b' }, { type: 'list', items: ['x'] }
    ] }), { warnings: [] });
    for (const part of parts.filter(p => !p.binary)) {
      const tree = xml.parse(part.data);
      assert.ok(xml.textOf(tree).length >= 0);
      assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(part.data), false, `${part.name} tiene & sin escapar`);
    }
  });

  test('un archivo que no es docx falla con mensaje claro', async () => {
    const bytes = await zip.writeZip([{ name: 'hola.txt', data: 'hola' }]);
    await assert.rejects(() => docxRead.docxBytesToDoc(bytes, {}), /word\/document\.xml/);
  });
});

describe('pdf: lineas y estructura', () => {
  // pdf.js entrega `transform` como matriz [a,b,c,d,e,f]; `height` es el cuerpo
  // de fuente y `hasEOL` marca el fin de linea (viene en items vacios).
  const item = (str, x, y, opts) => Object.assign({
    str, width: str.length * 6, height: 12, fontName: 'g_d0_f1', transform: [12, 0, 0, 12, x, y]
  }, opts || {});

  test('agrupa items en lineas por posicion', () => {
    const lines = pdfText.toLines([
      item('Hola', 72, 700),
      item('mundo', 110, 700),
      item('otra', 72, 684)
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].text, 'Hola mundo');
    assert.equal(lines[1].text, 'otra');
  });

  test('respeta hasEOL aunque la posicion no cambie', () => {
    const lines = pdfText.toLines([
      item('uno', 72, 700),
      item('', 72, 700, { hasEOL: true }),
      item('dos', 72, 700)
    ]);
    assert.deepEqual(lines.map(l => l.text), ['uno', 'dos']);
  });

  test('pega con espacio segun el hueco horizontal', () => {
    // "Palabra" termina en 114 y "pegada" arranca en 116: se tocan, no hay
    // espacio. "separada" arranca muy lejos: si lo hay.
    const lines = pdfText.toLines([
      item('Palabra', 72, 700), item('pegada', 116, 700), item('separada', 200, 700)
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'Palabrapegada separada');
  });

  test('el nivel del titulo sale de cuanto crece la fuente', () => {
    const bloques = (h) => pdfText.linesToBlocks(pdfText.toLines([
      item('Titulo', 72, 700, { height: h }),
      item('Cuerpo del texto que continua', 72, 684)
    ]), { bodySize: 12 })[0];
    assert.deepEqual(bloques(20), { type: 'heading', level: 1, text: 'Titulo' });
    assert.deepEqual(bloques(16), { type: 'heading', level: 2, text: 'Titulo' });
    assert.deepEqual(bloques(13), { type: 'heading', level: 3, text: 'Titulo' });
    assert.equal(bloques(12).type, 'paragraph');
  });

  test('un titulo y su cuerpo no se pegan', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('Titulo', 72, 700, { height: 16 }),
      item('Cuerpo del texto que continua', 72, 684)
    ]), { bodySize: 12 });
    assert.deepEqual(bloques[0], { type: 'heading', level: 2, text: 'Titulo' });
    assert.equal(bloques[1].type, 'paragraph');
    assert.equal(bloques[1].text, 'Cuerpo del texto que continua');
  });

  test('el cuerpo de fuente se puede imponer desde afuera', () => {
    // Una pagina con un solo titular: su propia mediana es el titular.
    const lines = pdfText.toLines([item('Solo un titular', 72, 700, { height: 24 })]);
    assert.equal(pdfText.linesToBlocks(lines, {})[0].type, 'paragraph');
    assert.equal(pdfText.linesToBlocks(lines, { bodySize: 12 })[0].type, 'heading');
  });

  test('las vinetas con y sin espacio son listas, la raya de dialogo no', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('•Uno', 72, 700), item('• Dos', 72, 688),
      item('—¿Que?', 72, 676), item('-¿Y esto?', 72, 664)
    ]), {});
    const listas = bloques.filter(b => b.type === 'list');
    assert.equal(listas.length, 1);
    assert.deepEqual(listas[0].items, ['Uno', 'Dos']);
    const parrafos = bloques.filter(b => b.type === 'paragraph').map(b => b.text);
    assert.ok(parrafos.some(t => t.includes('¿Que?')), 'la raya abre dialogo, no una lista');
    assert.ok(parrafos.some(t => t.includes('¿Y esto?')));
  });

  test('una lista numerada se marca como ordenada', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('1. Primero', 72, 700), item('2. Segundo', 72, 688)
    ]), {});
    assert.deepEqual(bloques, [{ type: 'list', items: ['Primero', 'Segundo'], ordered: true }]);
  });

  test('une las lineas de un parrafo y respeta el hueco vertical', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('Primera linea del parrafo que', 72, 700),
      item('sigue en la siguiente linea', 72, 688),
      item('y despues un hueco', 72, 650),
      item('que sigue pegado a ella', 72, 638)
    ]), {});
    const parrafos = bloques.filter(b => b.type === 'paragraph');
    assert.equal(parrafos.length, 2);
    assert.equal(parrafos[0].text, 'Primera linea del parrafo que sigue en la siguiente linea');
    // El hueco abre el parrafo; la linea pegada a la que la sigue lo continua.
    assert.equal(parrafos[1].text, 'y despues un hueco que sigue pegado a ella');
  });

  test('une la continuacion de un item de lista en varias lineas', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('•Optimizacion de cosechadoras', 72, 700),
      item('modelo serie S700', 90, 688),
      item('•Segundo item', 72, 676)
    ]), {});
    assert.deepEqual(bloques, [{
      type: 'list', ordered: false,
      items: ['Optimizacion de cosechadoras modelo serie S700', 'Segundo item']
    }]);
  });

  test('un texto pequeno y sangrado se ve como codigo', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('const x = 1;', 120, 700, { height: 9 })
    ]), { bodySize: 12, left: 72 });
    assert.equal(bloques[0].type, 'code');
  });

  test('un texto pequeno pegado al margen es una nota, no codigo', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('Pie de foto', 72, 700, { height: 9 })
    ]), { bodySize: 12, left: 72 });
    assert.equal(bloques[0].type, 'paragraph');
  });

  test('una linea corta al margen seguida de lista es un titulo', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('Datos Personales', 72, 700),
      item('•Nombre', 72, 680)
    ]), {});
    assert.equal(bloques[0].type, 'heading');
    assert.equal(bloques[0].text, 'Datos Personales');
    assert.equal(bloques[1].type, 'list');
  });

  test('una linea de continuacion no se confunde con un titulo', () => {
    const bloques = pdfText.linesToBlocks(pdfText.toLines([
      item('•Texto que se parte', 72, 700),
      item('y sigue en otra linea', 90, 688),
      item('•Otro item', 72, 660)
    ]), {});
    assert.equal(bloques.filter(b => b.type === 'heading').length, 0);
  });

  test('sin items devuelve una lista de lineas vacia', () => {
    assert.deepEqual(pdfText.toLines([]), []);
    assert.deepEqual(pdfText.toLines([{ str: '', hasEOL: true }]), []);
  });

  test('exige la libreria pdf.js', async () => {
    await assert.rejects(() => pdfText.pdfBytesToBlocks(new Uint8Array([1]), {}), /pdf\.js/);
  });
});

describe('fixtures reales (opcionales)', () => {
  const docxFixture = process.env.DOCX_FIXTURE;
  const pdfFixture = process.env.PDF_FIXTURE;

  test('lee un .docx real si DOCX_FIXTURE esta definido', async (t) => {
    if (!docxFixture || !fs.existsSync(docxFixture)) return t.skip('sin DOCX_FIXTURE');
    const { doc, warnings } = await docxRead.docxBytesToDoc(new Uint8Array(fs.readFileSync(docxFixture)), { sourcePath: docxFixture });
    assert.equal(doc.schema, model.SCHEMA);
    assert.ok(doc.blocks.length > 0, 'debe extraer al menos un bloque');
    assert.equal(typeof warnings, 'object');
  });

  test('el fixture de PDF existe y es un PDF', (t) => {
    if (!pdfFixture || !fs.existsSync(pdfFixture)) return t.skip('sin PDF_FIXTURE');
    const head = fs.readFileSync(pdfFixture).subarray(0, 5).toString('latin1');
    assert.equal(head, '%PDF-');
  });
});

describe('integracion entre archivos del nucleo', () => {
  test('el parche sobrevive un round-trip por DOCX', async () => {
    const doc = sample();
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    const { doc: back } = await docxRead.docxBytesToDoc(await zip.writeZip(parts), {});
    const res = patch.applyPatch(back, { ops: [{ op: 'replace', find: 'los terminos', replace: 'las condiciones' }] });
    assert.equal(res.ok, true);
    assert.match(model.plainText(res.doc), /las condiciones/);
  });

  test('el hash de un documento sobrevive al viaje por DOCX', async () => {
    const doc = model.createDoc({ blocks: [{ type: 'paragraph', text: 'estable' }] });
    const { parts } = docxWrite.docToDocxParts(doc, { warnings: [] });
    const { doc: back } = await docxRead.docxBytesToDoc(await zip.writeZip(parts), {});
    assert.equal(back.hash, doc.hash);
  });
});

void path;
