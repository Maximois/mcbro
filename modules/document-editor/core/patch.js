'use strict';
/**
 * MC Browser -- modulo document-editor / core/patch.js
 *
 * Motor de parches. Es la pieza que hace que la IA pueda editar un documento
 * sin poder destruirlo.
 *
 * Reglas, en orden de importancia:
 *  1. Un parche es ATOMICO. Si una operacion falla, no se aplica ninguna y se
 *     devuelve el documento original. Un "quedó a medias" es peor que un
 *     error visible.
 *  2. Toda ancla textual debe matchear EXACTAMENTE UNA vez, salvo que pida
 *     `all: true`. Cero matches o varios matches son error. Esto es lo que
 *     impide que un texto parecido se sustituya en el lugar equivocado.
 *  3. `expectedHash` es obligatorio en el camino de la IA: si el documento
 *     cambio desde que la IA lo leyo, el parche se rechaza en vez de pisar
 *     una edicion que no vio.
 *  4. No existe "reescribir el documento entero". El modelo solo puede
 *     apuntar a una ancla y cambiarla. Un bloque suelto se reemplaza por id.
 *
 * Todo es puro: recibe un doc, devuelve un doc. No toca disco ni UI.
 */

(function (root, factory) {
  const mod = factory({ model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model) });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.patch = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const MAX_OPS = 200;
  const MAX_ANCHOR = 2000;

  const OP_KINDS = [
    'replace', 'insert', 'delete', 'style', 'replaceBlock', 'deleteBlock',
    'setTitle', 'setMeta', 'find'
  ];

  /** Descripcion del formato, para incrustar en el prompt del asistente. */
  const SPEC = [
    'PATCH (documento abierto en el editor de documentos):',
    '{ "expectedHash": "<hash actual>", "ops": [ ...operaciones... ] }',
    '',
    'Operaciones (todas requieren que el texto ancla exista y sea unico salvo "all"):',
    '  { "op":"replace", "find":"texto exacto", "replace":"texto nuevo", "all":false, "caseSensitive":false, "regex":false }',
    '  { "op":"insert",  "after":"ancla", "block":{"type":"paragraph","text":"..."} }   // o "before", o "index": 12',
    '  { "op":"insert",  "index":0, "block":{"type":"heading","level":1,"text":"Titulo"} }',
    '  { "op":"delete",  "find":"texto exacto", "all":false }',
    '  { "op":"style",   "find":"texto", "bold":true, "italic":false, "underline":false, "align":"center", "size":14, "color":"#333333" }',
    '  { "op":"replaceBlock", "id":"b12", "block":{"type":"paragraph","text":"..."} }',
    '  { "op":"deleteBlock", "id":"b12" }',
    '  { "op":"setTitle", "title":"..." }   { "op":"setMeta", "key":"author", "value":"..." }',
    '  { "op":"find", "find":"texto" }   // solo consulta: devuelve donde aparece, no modifica',
    '',
    'Tipos de bloque validos: heading(level 1-3), paragraph, list(items[], ordered),',
    'quote, code, image(src data:), table(rows[][], header), pagebreak, hr.',
    '',
    'Reglas:',
    '- SIEMPRE responde primero con doc:read y usa texto copiado de ahi, nunca de memoria.',
    '- Un parche por cambio logico. Si algo falla, el parche entero se descarta.',
    '- Nunca intentes reescribir el documento completo: no hay operacion para eso.',
    '- "style" con bold/italic/underline/color/size marca SOLO el fragmento dentro de',
    '  parrafos y titulos. En listas y tablas el estilo se aplica al elemento entero.',
    '- Si despues de un "style" hacés un "replace" sobre el mismo parrafo, el texto se',
    '  reemplaza plano y se pierde el formato del fragmento. Separate en dos parches si',
    '  el formato importa.'
  ].join('\n');

  function isTextual(block) {
    return block && (block.type === 'heading' || block.type === 'paragraph' ||
      block.type === 'quote' || block.type === 'code' || block.type === 'list' ||
      block.type === 'table');
  }

  /**
   * Encuentra TODAS las apariciones del ancla, una por coincidencia (no una
   * por bloque): la deteccion de ambiguedad depende de contarlas, y `locate`
   * se expone para que la UI pueda resaltar antes de aplicar.
   */
  function locate(doc, anchor, opts) {
    const o = opts || {};
    const caseSensitive = o.caseSensitive !== false;
    const hits = [];

    for (let i = 0; i < doc.blocks.length; i++) {
      const b = doc.blocks[i];
      if (b.type === 'list') {
        (b.items || []).forEach((item, j) => {
          for (const m of allMatchesIn(item, anchor, Object.assign({}, o, { caseSensitive }))) {
            hits.push({ blockIndex: i, itemIndex: j, at: m.at, len: m.len, text: item });
          }
        });
        continue;
      }
      if (b.type === 'table') {
        (b.rows || []).forEach((row, r) => row.forEach((cell, c) => {
          for (const m of allMatchesIn(cell, anchor, Object.assign({}, o, { caseSensitive }))) {
            hits.push({ blockIndex: i, row: r, col: c, at: m.at, len: m.len, text: cell });
          }
        }));
        continue;
      }
      if (!isTextual(b)) continue;
      const text = model.blockText(b);
      for (const m of allMatchesIn(text, anchor, Object.assign({}, o, { caseSensitive }))) {
        hits.push({ blockIndex: i, at: m.at, len: m.len, text });
      }
    }
    return hits;
  }

  function matchIn(haystack, anchor, o) {
    if (typeof haystack !== 'string' || !haystack) return -1;
    if (o.regex) {
      let re;
      try { re = new RegExp(anchor, o.caseSensitive === false ? 'gi' : 'g'); } catch { return -1; }
      const m = re.exec(haystack);
      return m ? m.index : -1;
    }
    const h = o.caseSensitive === false ? haystack.toLowerCase() : haystack;
    const a = o.caseSensitive === false ? String(anchor).toLowerCase() : String(anchor);
    return h.indexOf(a);
  }

  function allMatchesIn(haystack, anchor, o) {
    const out = [];
    if (typeof haystack !== 'string' || !haystack) return out;
    if (o.regex) {
      let re;
      try { re = new RegExp(anchor, o.caseSensitive === false ? 'gi' : 'g'); } catch { return out; }
      let m;
      while ((m = re.exec(haystack)) !== null) {
        out.push({ at: m.index, len: m[0].length });
        if (m[0].length === 0) re.lastIndex++;
        if (out.length > 1000) break;
      }
      return out;
    }
    const h = o.caseSensitive === false ? haystack.toLowerCase() : haystack;
    const a = o.caseSensitive === false ? String(anchor).toLowerCase() : String(anchor);
    if (!a) return out;
    let from = 0;
    for (;;) {
      const at = h.indexOf(a, from);
      if (at === -1) break;
      out.push({ at, len: a.length });
      from = at + a.length;
      if (out.length > 1000) break;
    }
    return out;
  }

  function sliceReplace(text, spans, replacement, o) {
    // De derecha a izquierda para que los indices sigan siendo validos.
    const sorted = spans.slice().sort((x, y) => y.at - x.at);
    let out = text;
    for (const span of sorted) {
      out = out.slice(0, span.at) + replacement + out.slice(span.at + span.len);
    }
    void o;
    return out;
  }

  function err(opIndex, code, message, detail) {
    return { opIndex, code, message, detail: detail || null };
  }

  // ------------------------------------------------------------ operaciones

  function opFind(state, op, index) {
    const hits = locate(state.doc, String(op.find || ''), op);
    return { hits, result: hits.slice(0, 20) };
  }

  function opReplace(state, op, index) {
    const anchor = String(op.find == null ? '' : op.find);
    if (!anchor) return err(index, 'INVALID', 'replace sin "find"');
    if (anchor.length > MAX_ANCHOR) return err(index, 'TOO_LONG', 'ancla demasiado larga', { max: MAX_ANCHOR });
    const all = op.all === true;
    const hits = locate(state.doc, anchor, op);
    if (!hits.length) return err(index, 'NOT_FOUND', `no se encontro: ${truncate(anchor, 60)}`);
    if (!all && hits.length > 1) {
      return err(index, 'AMBIGUOUS', `el texto aparece ${hits.length} veces, se necesita "all":true o mas contexto`,
        { occurrences: hits.length, locations: hits.slice(0, 5).map(h => ({ index: h.blockIndex, id: state.doc.blocks[h.blockIndex] && state.doc.blocks[h.blockIndex].id })) });
    }

    const replacement = op.replace == null ? '' : String(op.replace);
    const byBlock = groupByBlock(hits);
    const diffs = [];

    for (const blockIndex of Object.keys(byBlock).map(Number).sort((a, b) => a - b)) {
      const block = state.doc.blocks[blockIndex];
      const before = describeTarget(block);
      // Los offsets se resuelven por cadena, no por bloque: una coincidencia
      // en la celda (0,1) no puede desplazar el texto de la celda (1,0).
      for (const target of targetsFor(block, byBlock[blockIndex].hits, anchor, op, all)) {
        if (op.regex) {
          target.set(target.get().replace(safeRegExp(anchor, op), replacement));
        } else {
          target.set(sliceReplace(target.get(), target.spans, replacement, op));
        }
      }
      diffs.push({ op: 'replace', index: blockIndex, id: block.id, before, after: describeTarget(block) });
    }
    return { diffs, count: hits.length };
  }

  function opDelete(state, op, index) {
    const anchor = String(op.find == null ? '' : op.find);
    if (!anchor) return err(index, 'INVALID', 'delete sin "find"');
    const all = op.all === true;
    const hits = locate(state.doc, anchor, op);
    if (!hits.length) return err(index, 'NOT_FOUND', `no se encontro: ${truncate(anchor, 60)}`);
    if (!all && hits.length > 1) {
      return err(index, 'AMBIGUOUS', `el texto aparece ${hits.length} veces, se necesita "all":true`, { occurrences: hits.length });
    }
    const byBlock = groupByBlock(hits);
    const diffs = [];
    for (const blockIndex of Object.keys(byBlock).map(Number).sort((a, b) => b - a)) {
      const block = state.doc.blocks[blockIndex];
      const before = describeTarget(block);
      for (const target of targetsFor(block, byBlock[blockIndex].hits, anchor, op, all)) {
        if (op.regex) target.set(target.get().replace(safeRegExp(anchor, op), ''));
        else target.set(sliceReplace(target.get(), target.spans, '', op));
      }
      diffs.push({ op: 'delete', index: blockIndex, id: block.id, before, after: '' });
    }
    return { diffs, count: hits.length };
  }

  /**
   * Agrupa los hits de un bloque por cadena destino y devuelve un par
   * get/set por cadena con sus propios spans ya calculados.
   */
  function targetsFor(block, hits, anchor, op, all) {
    const groups = new Map();
    for (const h of hits) {
      const key = h.itemIndex != null ? `i${h.itemIndex}`
        : (h.row != null ? `r${h.row}c${h.col}` : 't');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    const out = [];
    for (const group of groups.values()) {
      const h0 = group[0];
      let get, set;
      if (h0.itemIndex != null) {
        get = () => block.items[h0.itemIndex];
        set = v => { block.items[h0.itemIndex] = v; };
      } else if (h0.row != null) {
        get = () => block.rows[h0.row][h0.col];
        set = v => { block.rows[h0.row][h0.col] = v; };
      } else {
        get = () => model.blockText(block);
        set = v => {
          const next = model.withText(block, v);
          delete block.runs;
          Object.assign(block, next);
        };
      }
      const spans = all ? allMatchesIn(get(), anchor, op) : group.map(h => ({ at: h.at, len: h.len }));
      out.push({ get, set, spans });
    }
    return out;
  }

  function opStyle(state, op, index) {
    const anchor = String(op.find == null ? '' : op.find);
    if (!anchor) return err(index, 'INVALID', 'style sin "find"');
    const all = op.all === true;
    const hits = locate(state.doc, anchor, op);
    if (!hits.length) return err(index, 'NOT_FOUND', `no se encontro: ${truncate(anchor, 60)}`);
    if (!all && hits.length > 1) {
      return err(index, 'AMBIGUOUS', `el texto aparece ${hits.length} veces, se necesita "all":true`, { occurrences: hits.length });
    }
    // Propiedades de caracter (negrita/cursiva/subrayado/color/tamano) se
    // pueden aplicar a una parte del parrafo: se parte el texto en runs.
    // Alineado e indentado son de bloque y se aplican al bloque entero.
    const runProps = pickRunProps(op);
    const blockProps = pickBlockProps(op);
    if (!runProps && !blockProps) return err(index, 'INVALID', 'style sin propiedades');

    const byBlock = groupByBlock(hits);
    const diffs = [];
    for (const blockIndex of Object.keys(byBlock).map(Number)) {
      const block = state.doc.blocks[blockIndex];
      const before = describeTarget(block);

      if (blockProps) {
        for (const key of Object.keys(blockProps)) {
          if (blockProps[key] === false) delete block[key];
          else block[key] = blockProps[key];
        }
      }

      if (runProps) {
        const blockHits = byBlock[blockIndex].hits;
        const simple = blockHits.every(h => h.itemIndex == null && h.row == null);
        if (simple && (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote' || block.type === 'code')) {
          const text = model.blockText(block);
          const spans = all ? allMatchesIn(text, anchor, op) : blockHits.map(h => ({ at: h.at, len: h.len }));
          block.runs = runsWithProps(text, spans, runProps);
          delete block.text;
        } else {
          // Listas y tablas no tienen runs: el estilo queda a nivel de bloque
          // o de celda, que es lo mejor que el modelo puede expresar.
          for (const key of Object.keys(runProps)) {
            if (runProps[key] === false) delete block[key];
            else block[key] = runProps[key];
          }
        }
      }
      state.doc.blocks[blockIndex] = model.normalizeBlock(block) || block;
      diffs.push({ op: 'style', index: blockIndex, id: block.id, before, after: describeTarget(block), style: Object.assign({}, runProps, blockProps) });
    }
    return { diffs, count: hits.length };
  }

  function pickRunProps(op) {
    const out = {};
    for (const key of ['bold', 'italic', 'underline', 'color', 'size']) {
      if (op[key] === true) out[key] = true;
      else if (op[key] === false) out[key] = false;
      else if (key === 'color' || key === 'size') {
        if (op[key] != null && String(op[key]) !== '' && String(op[key]) !== 'undefined') out[key] = op[key];
      }
    }
    return Object.keys(out).length ? out : null;
  }

  function pickBlockProps(op) {
    const out = {};
    for (const key of ['align', 'indent']) {
      if (op[key] == null) continue;
      if (op[key] === false) out[key] = false;
      else out[key] = op[key];
    }
    return Object.keys(out).length ? out : null;
  }

  /** Parte el texto en runs, aplicando las propiedades a los spans dados. */
  function runsWithProps(text, spans, props) {
    const sorted = spans.slice().sort((a, b) => a.at - b.at);
    const runs = [];
    let pos = 0;
    for (const span of sorted) {
      if (span.at < pos) continue; // solapado: se ignora la segunda pasada
      if (span.at > pos) runs.push({ text: text.slice(pos, span.at) });
      const chunk = text.slice(span.at, span.at + span.len);
      if (chunk) {
        const run = { text: chunk };
        for (const key of Object.keys(props)) {
          if (props[key] === false) continue;
          run[key] = props[key];
        }
        runs.push(run);
      }
      pos = span.at + span.len;
    }
    if (pos < text.length) runs.push({ text: text.slice(pos) });
    return runs.length ? runs : [{ text }];
  }

  function opInsert(state, op, index) {
    const block = model.normalizeBlock(op.block);
    if (!block) return err(index, 'INVALID', 'insert sin "block" valido', { block: op.block || null });

    let at = -1;
    if (Number.isInteger(op.index)) {
      at = Math.max(0, Math.min(state.doc.blocks.length, op.index));
    } else if (op.after != null || op.before != null) {
      const anchor = String(op.after != null ? op.after : op.before);
      const hits = locate(state.doc, anchor, { caseSensitive: op.caseSensitive });
      if (!hits.length) return err(index, 'NOT_FOUND', `ancla no encontrada: ${truncate(anchor, 60)}`);
      if (hits.length > 1) {
        return err(index, 'AMBIGUOUS', `ancla ambigua (${hits.length} coincidencias)`, { occurrences: hits.length });
      }
      at = op.after != null ? hits[0].blockIndex + 1 : hits[0].blockIndex;
    } else {
      at = state.doc.blocks.length;
    }
    state.doc.blocks.splice(at, 0, block);
    return { diffs: [{ op: 'insert', index: at, id: block.id, before: '', after: describeTarget(block) }], count: 1 };
  }

  function opReplaceBlock(state, op, index) {
    const at = state.doc.blocks.findIndex(b => b.id === op.id);
    if (at === -1) return err(index, 'NOT_FOUND', `no existe el bloque ${op.id}`);
    const block = model.normalizeBlock(Object.assign({}, op.block, { id: op.id }));
    if (!block) return err(index, 'INVALID', 'replaceBlock sin contenido valido');
    const before = describeTarget(state.doc.blocks[at]);
    state.doc.blocks[at] = block;
    return { diffs: [{ op: 'replaceBlock', index: at, id: op.id, before, after: describeTarget(block) }], count: 1 };
  }

  function opDeleteBlock(state, op, index) {
    const at = state.doc.blocks.findIndex(b => b.id === op.id);
    if (at === -1) return err(index, 'NOT_FOUND', `no existe el bloque ${op.id}`);
    const before = describeTarget(state.doc.blocks[at]);
    state.doc.blocks.splice(at, 1);
    return { diffs: [{ op: 'deleteBlock', index: at, id: op.id, before, after: '' }], count: 1 };
  }

  function opSetTitle(state, op, index) {
    const title = String(op.title == null ? '' : op.title).trim();
    if (!title) return err(index, 'INVALID', 'setTitle vacio');
    const before = state.doc.title;
    state.doc.title = title.slice(0, 300);
    return { diffs: [{ op: 'setTitle', id: 'meta', before, after: state.doc.title }], count: 1 };
  }

  function opSetMeta(state, op, index) {
    const key = String(op.key || '');
    const allowed = ['author', 'subject', 'keywords', 'title'];
    if (allowed.indexOf(key) === -1) return err(index, 'INVALID', `meta no editable: ${key}`, { allowed });
    if (key === 'title') return opSetTitle(state, { title: op.value }, index);
    const before = state.doc.meta[key];
    state.doc.meta[key] = String(op.value == null ? '' : op.value).slice(0, 400);
    return { diffs: [{ op: 'setMeta', id: 'meta', key, before, after: state.doc.meta[key] }], count: 1 };
  }

  function groupByBlock(hits) {
    const out = Object.create(null);
    for (const hit of hits) {
      const key = String(hit.blockIndex);
      if (!out[key]) out[key] = { spans: [], hits: [] };
      out[key].spans.push({ at: hit.at, len: hit.len });
      out[key].hits.push(hit);
    }
    return out;
  }

  function safeRegExp(source, op) {
    return new RegExp(source, op.caseSensitive === false ? 'gi' : 'g');
  }

  function describeTarget(block) {
    if (!block) return '';
    if (block.type === 'list') return (block.items || []).join(' | ');
    if (block.type === 'table') return (block.rows || []).map(r => r.join(' | ')).join(' / ');
    if (block.type === 'image') return `[imagen${block.alt ? ': ' + block.alt : ''}]`;
    if (block.type === 'pagebreak') return '[salto de pagina]';
    if (block.type === 'hr') return '[separador]';
    return model.blockText(block);
  }

  function truncate(str, n) {
    const s = String(str);
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  // ------------------------------------------------------------- aplicacion

  /**
   * applyPatch(doc, patch, opts) -> {
   *   ok, doc, diff, errors, applied, stale, reason, summary
   * }
   * Nunca lanza: los problemas se devuelven en `errors`.
   */
  function applyPatch(doc, patch, opts) {
    const options = opts || {};
    const source = model.normalizeDoc(doc);
    const errors = [];

    if (!patch || typeof patch !== 'object') {
      return fail(source, [err(0, 'INVALID', 'parche vacio o malformado')], 0);
    }
    const ops = Array.isArray(patch.ops) ? patch.ops : (patch.op ? [patch] : null);
    if (!ops || !ops.length) return fail(source, [err(0, 'INVALID', 'el parche no tiene "ops"')], 0);
    if (ops.length > MAX_OPS) return fail(source, [err(0, 'TOO_MANY', `maximo ${MAX_OPS} operaciones por parche`, { got: ops.length })], 0);

    // Control de concurrencia: si el documento cambio, no se toca.
    if (options.requireHash !== false) {
      const expected = patch.expectedHash == null ? options.expectedHash : String(patch.expectedHash);
      if (expected && String(expected) !== source.hash) {
        return Object.assign(fail(source, [], 0), {
          stale: true,
          reason: 'stale_document',
          message: 'el documento cambio desde la ultima lectura: el parche se descarto',
          expectedHash: expected,
          actualHash: source.hash
        });
      }
    }

    const state = { doc: JSON.parse(JSON.stringify(source)) };
    const diff = [];
    let applied = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] || {};
      const kind = String(op.op || '');
      if (OP_KINDS.indexOf(kind) === -1) {
        errors.push(err(i, 'UNKNOWN_OP', `operacion desconocida: "${kind || '(vacia)'}"`, { allowed: OP_KINDS }));
        break;
      }
      let res;
      try {
        switch (kind) {
          case 'replace': res = opReplace(state, op, i); break;
          case 'delete': res = opDelete(state, op, i); break;
          case 'style': res = opStyle(state, op, i); break;
          case 'insert': res = opInsert(state, op, i); break;
          case 'replaceBlock': res = opReplaceBlock(state, op, i); break;
          case 'deleteBlock': res = opDeleteBlock(state, op, i); break;
          case 'setTitle': res = opSetTitle(state, op, i); break;
          case 'setMeta': res = opSetMeta(state, op, i); break;
          case 'find': res = opFind(state, op, i); break;
          default: res = err(i, 'UNKNOWN_OP', kind);
        }
      } catch (e) {
        res = err(i, 'THREW', `la operacion fallo: ${e && e.message ? e.message : e}`);
      }
      if (res && res.code) { errors.push(res); break; }
      if (res && res.diffs) diff.push(...res.diffs);
      if (kind === 'find') {
        if (!res || !res.result || !res.result.length) {
          errors.push(err(i, 'NOT_FOUND', `no se encontro: ${truncate(String(op.find || ''), 60)}`));
          break;
        }
      } else {
        applied += (res && res.count) || 0;
      }
    }

    if (errors.length) {
      return Object.assign(fail(source, errors, applied), { diff: [] });
    }

    // Normalizar y limpiar: bloques que quedaron sin texto se van, salvo los
    // que son literalmente un salto o un separador.
    const before = JSON.parse(JSON.stringify(source));
    const next = model.normalizeDoc(state.doc);
    const removed = diffBlocks(before, next);
    if (removed.length) {
      for (const r of removed) diff.push({ op: 'cleanup', index: r.index, id: r.id, before: r.before, after: '' });
    }

    const result = {
      ok: true,
      doc: next,
      diff,
      errors: [],
      applied,
      stale: false,
      hash: next.hash,
      version: next.version,
      summary: summarize(next, diff, applied)
    };
    void options;
    return result;
  }

  function fail(source, errors, applied) {
    return {
      ok: false,
      doc: source,
      diff: [],
      errors,
      applied: 0,
      stale: false,
      hash: source.hash,
      version: source.version,
      summary: summarizeError(errors)
    };
  }

  function summarizeError(errors) {
    if (!errors.length) return 'sin cambios';
    const e = errors[0];
    return `parche rechazado (${e.code}): ${e.message}`;
  }

  function summarize(doc, diff, applied) {
    const lines = [`${applied} cambio(s) aplicado(s). hash ${doc.hash}`];
    for (const d of diff.slice(0, 20)) {
      const id = d.id ? `[${d.id}]` : '';
      if (d.op === 'setTitle' || d.op === 'setMeta') {
        lines.push(`- ${d.op}: "${truncate(d.before, 40)}" -> "${truncate(d.after, 60)}"`);
      } else if (d.op === 'insert') {
        lines.push(`- insercion ${id}: ${truncate(d.after, 100)}`);
      } else if (d.op === 'delete' || d.op === 'deleteBlock' || d.op === 'cleanup') {
        lines.push(`- borrado ${id}: ${truncate(d.before, 100)}`);
      } else {
        lines.push(`- ${d.op} ${id}: "${truncate(d.before, 60)}" -> "${truncate(d.after, 100)}"`);
      }
    }
    if (diff.length > 20) lines.push(`- ... y ${diff.length - 20} mas`);
    return lines.join('\n');
  }

  /** Bloques que estaban antes y ya no estan (limpieza por texto vacio). */
  function diffBlocks(before, after) {
    const afterIds = new Set(after.blocks.map(b => b.id));
    const out = [];
    before.blocks.forEach((b, i) => {
      if (afterIds.has(b.id)) return;
      if (b.type === 'pagebreak' || b.type === 'hr') return;
      out.push({ index: i, id: b.id, before: describeTarget(b) });
    });
    return out;
  }

  /** Simula el parche sin mutar nada. Util para previsualizar en la UI. */
  function previewPatch(doc, patch, opts) {
    const res = applyPatch(doc, patch, opts);
    return { ok: res.ok, diff: res.diff, errors: res.errors, stale: res.stale, summary: res.summary, hash: res.hash };
  }

  return { applyPatch, previewPatch, SPEC, OP_KINDS, MAX_OPS, locate, describeTarget };
});
