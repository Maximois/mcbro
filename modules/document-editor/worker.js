'use strict';
/**
 * modules/document-editor/worker.js — worker_threads para extracción PDF/DOCX
 *
 * Por qué worker: un PDF con miles de paginas se procesa en bucle y bloquea el
 * proceso principal. Aquí sí se puede usar CPU intensivo sin congelar la UI.
 *
 * La extracción PDF es heurística. Las llamadas a pdf.js son síncronas dentro
 * de la promesa pero corren fuera del main loop. Se cargan los bundles
 * vendorizados en este proceso aislado.
 */
const path = require('path');
const { parentPort } = require('worker_threads');

const docxRead = require('./core/docx-read');
const pdfText = require('./core/pdf-text');
const zip = require('./core/zip');
const textIo = require('./core/text-io');
const model = require('./core/model');

let pdfjsLoaded = false;
let pdfjsMod = null;

function loadPdfjs() {
  if (pdfjsLoaded) return pdfjsMod;
  try {
    globalThis.pdfjsWorker = require('./vendor/pdf.worker.min.js');
    pdfjsMod = require('./vendor/pdf.min.js');
    pdfjsLoaded = true;
    return pdfjsMod;
  } catch (e) {
    throw new Error('No pude cargar pdf.js en el worker: ' + e.message);
  }
}

function toUint8Array(arr) {
  if (arr instanceof Uint8Array) return arr;
  if (arr && typeof arr === 'object' && 'length' in arr) {
    return new Uint8Array(arr);
  }
  if (Array.isArray(arr)) return new Uint8Array(arr);
  return Uint8Array.from(arr || []);
}

function extractPdf(bytes, limits) {
  const pdfjs = loadPdfjs();
  return pdfText.pdfBytesToBlocks(bytes, { pdfjs, maxPages: limits && limits.maxPages });
}

function extractDocx(bytes, sourcePath) {
  return docxRead.docxBytesToDoc(bytes, { sourcePath });
}

function extractText(bytes, sourcePath) {
  const text = zip.toStr(bytes);
  const doc = textIo.textToDoc(text, { sourcePath });
  return { doc, warnings: [] };
}

async function handleExtract(msg) {
  const fmt = String(msg.format || '').toLowerCase();
  const src = msg.sourcePath || '';
  const bytes = toUint8Array(msg.data);
  const limits = msg.limits || { maxPages: 2000 };

  if (fmt === 'docx') {
    const res = await extractDocx(bytes, src);
    const doc = res.doc || model.createDoc({ title: path.basename(src, '.docx'), blocks: [] });
    if (!doc.hash) doc.hash = model.hashDoc(doc);
    return {
      blocks: doc.blocks,
      meta: doc.meta,
      title: doc.title,
      warnings: res.warnings || [],
      pages: 0,
      pageCount: 0
    };
  }
  if (fmt === 'pdf') {
    const res = await extractPdf(bytes, limits);
    return {
      blocks: res.blocks,
      meta: res.meta,
      title: res.meta && res.meta.title,
      warnings: res.warnings || [],
      pages: res.pages || 0,
      pageCount: res.pageCount || 0,
      empty: res.empty
    };
  }
  if (fmt === 'txt' || fmt === 'md') {
    const res = extractText(bytes, src);
    const doc = res.doc || model.createDoc({ title: path.basename(src, path.extname(src)), blocks: [] });
    if (!doc.hash) doc.hash = model.hashDoc(doc);
    return {
      blocks: doc.blocks,
      meta: doc.meta,
      title: doc.title,
      warnings: res.warnings || [],
      pages: 0,
      pageCount: 0
    };
  }
  throw new Error('Formato no soportado en el worker: ' + fmt);
}

parentPort.on('message', async (msg) => {
  if (!msg || !msg.id) return;
  try {
    if (msg.type === 'extract') {
      const result = await handleExtract(msg);
      parentPort.postMessage({ id: msg.id, type: 'ok', result });
    } else {
      parentPort.postMessage({ id: msg.id, type: 'error', error: 'Mensaje desconocido' });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, type: 'error', error: e && e.message ? e.message : String(e) });
  }
});

module.exports = {}; // para Node
