'use strict';
/**
 * modules/document-editor/renderer.js — vista del editor de documentos.
 *
 * El renderer no es dueño de nada: el main tiene el archivo y el documento
 * (ver main.js). Acá se pintan los bloques, se renderizan las páginas del PDF
 * y se mandan parches. Cada cambio del usuario vuelve como parche (`doc:edit`),
 * igual que los de la IA (`doc:patch`): un solo camino y un solo control de
 * concurrencia (el hash).
 *
 * El editor vive como una PESTAÑA del navegador (mc://doc → panel-doc), no
 * como modal: no tapa la interfaz y se cierra con el mismo botón que las
 * demás pestañas. La UI se inyecta dentro de #doc-host.
 */

(function () {
  'use strict';

  const API = window.mc || {};
  const PANEL_ID = 'panel-doc';
  const HOST_ID = 'doc-host';
  const BTN_ID = 'doc-editor-btn';
  const TAB_URL = 'mc://doc';

  const ui = {
    snap: null,        // último estado que mandó el main
    view: 'content',   // 'content' | 'pages'
    pdfRenderToken: 0,
    toast: null
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const panel = () => document.getElementById(PANEL_ID);
  const host = () => document.getElementById(HOST_ID);
  const el = (id) => { const h = host(); return h ? h.querySelector('#' + id) : null; };

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // El panel está activo cuando la app puso .active (showPanel) y cuando su
  // pestaña es la activa. Con los dos chequeos no hay que adivinar.
  function isActive() {
    const p = panel();
    if (!p || !p.classList.contains('active')) return false;
    try { return state0().activeTab === docTab()?.id; } catch { return true; }
  }
  function state0() {
    // `state` es un binding global del renderer.html; se accede por nombre para
    // no depender de window.
    return typeof state === 'object' ? state : { tabs: [], activeTab: null };
  }
  function docTab() {
    const s = state0();
    return (s.tabs || []).find((t) => t.url === TAB_URL) || null;
  }

  function toast(msg, kind) {
    const t = el('doc-toast');
    if (!t) { console.log('[DocEditor]', msg); return; }
    t.textContent = msg;
    t.className = 'doc-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(ui.toast);
    ui.toast = setTimeout(() => { t.className = 'doc-toast'; }, kind === 'error' ? 6000 : 3000);
  }

  // ── Estilos ────────────────────────────────────────────────────────────
  const DOC_CSS = [
'#' + HOST_ID + '{font-family:Calibri,"Segoe UI",Arial,sans-serif;color:var(--text,#e6e8ee);}',
'#' + HOST_ID + ' .doc-bar{display:flex;align-items:center;gap:6px;padding:8px 14px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface2,#191c24);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-formatbar{display:flex;align-items:center;gap:8px;padding:7px 12px;',
'border-bottom:1px solid var(--border,#2a2f3a);background:var(--surface,#14161c);flex-wrap:wrap;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-format-group{display:flex;align-items:center;gap:3px;padding-right:9px;border-right:1px solid var(--border,#2a2f3a);}',
'#' + HOST_ID + ' .doc-format-group:last-child{border:0;padding-right:0;}',
'#' + HOST_ID + ' .doc-formatbar select{height:27px;padding:3px 6px;background:var(--surface2,#191c24);',
'color:inherit;border:1px solid var(--border,#2a2f3a);border-radius:4px;font:inherit;font-size:.82rem;}',
'#' + HOST_ID + ' .doc-format-tool{min-width:28px;height:27px;padding:2px 6px;background:transparent;',
'color:inherit;border:1px solid transparent;border-radius:4px;cursor:pointer;font:inherit;}',
'#' + HOST_ID + ' .doc-format-tool:hover:not(:disabled){background:var(--surface3,#22262f);}',
'#' + HOST_ID + ' .doc-format-tool.active{background:rgba(77,163,255,.2);border-color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-format-tool:disabled,#' + HOST_ID + ' .doc-formatbar select:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' .doc-formatbar .doc-format-label{font-size:.72rem;color:var(--muted,#8b93a7);margin-right:3px;}',
'#' + HOST_ID + ' .doc-title{font-size:1.15rem;font-weight:700;overflow:hidden;',
'text-overflow:ellipsis;white-space:nowrap;max-width:46%;}',
'#' + HOST_ID + ' .doc-title .doc-star{color:var(--accent,#4da3ff);margin-left:4px;}',
'#' + HOST_ID + ' .doc-sub{font-size:.82rem;color:var(--muted,#8b93a7);margin-right:auto;}',
'#' + HOST_ID + ' .doc-views{display:flex;gap:2px;}',
'#' + HOST_ID + ' button.doc-btn{background:var(--surface,#14161c);color:inherit;',
'border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px 10px;font-size:.85rem;cursor:pointer;white-space:nowrap;}',
'#' + HOST_ID + ' button.doc-btn:hover:not(:disabled){background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' button.doc-btn:disabled{opacity:.4;cursor:default;}',
'#' + HOST_ID + ' button.doc-btn.primary{background:var(--accent,#4da3ff);color:#07101c;border-color:transparent;font-weight:600;}',
'#' + HOST_ID + ' button.doc-btn.on{background:var(--surface3,#22262f);color:var(--accent,#4da3ff);}',
'#' + HOST_ID + ' .doc-warn{padding:7px 14px;font-size:.82rem;background:rgba(255,183,77,.12);',
'border-bottom:1px solid rgba(255,183,77,.3);color:#ffb74d;flex-shrink:0;}',
'#' + HOST_ID + ' .doc-scroll{flex:1;overflow:auto;padding:24px;background:#d9dde5;}',
'#' + HOST_ID + ' .doc-paper-stack{display:flex;flex-direction:column;align-items:center;gap:22px;',
'width:max-content;min-width:100%;padding-bottom:22px;}',
'#' + HOST_ID + ' .doc-paper{box-sizing:border-box;background:#fff;color:#111;flex:0 0 auto;',
'border:1px solid #c8ccd2;box-shadow:0 2px 12px rgba(0,0,0,.25);}',
'#' + HOST_ID + ' .doc-paper-content{box-sizing:border-box;width:100%;overflow:visible;}',
'#' + HOST_ID + ' .doc-pages{display:flex;flex-direction:column;align-items:center;gap:14px;}',
'#' + HOST_ID + ' .doc-page-wrap{position:relative;box-shadow:0 4px 18px rgba(0,0,0,.45);background:#fff;}',
'#' + HOST_ID + ' .doc-page-wrap canvas{display:block;}',
'#' + HOST_ID + ' .doc-page-no{position:absolute;right:6px;bottom:4px;font-size:10px;color:#55606f;',
'background:rgba(255,255,255,.85);padding:1px 5px;border-radius:3px;}',
'#' + HOST_ID + ' .doc-empty{text-align:center;padding:70px 20px;color:var(--muted,#8b93a7);}',
'#' + HOST_ID + ' .doc-empty h3{color:inherit;margin:0 0 8px;font-size:1.15rem;}',
'#' + HOST_ID + ' .doc-empty ul{list-style:none;padding:0;margin:14px 0 0;text-align:left;display:inline-block;}',
'#' + HOST_ID + ' .doc-empty li{padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;}',
'#' + HOST_ID + ' .doc-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%) translateY(8px);',
'background:var(--surface3,#22262f);border:1px solid var(--border,#2a2f3a);color:inherit;padding:8px 14px;',
'border-radius:8px;font-size:.85rem;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;max-width:80%;}',
'#' + HOST_ID + ' .doc-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}',
'#' + HOST_ID + ' .doc-toast.error{border-color:#d9534f;color:#ff8a85;}',
'.doc-b{position:relative;margin:0;max-width:none;color:#111;font-size:11pt;line-height:1.15;}',
'.doc-b:hover{background:rgba(0,0,0,.025);}',
'.doc-b.sel{background:rgba(0,120,215,.08);box-shadow:inset 2px 0 0 #0078d4;}',
'.doc-b .doc-t{display:block;width:100%;border:0;background:transparent;color:inherit;font:inherit;',
'box-sizing:border-box;outline:none;resize:none;padding:0;line-height:1.15;text-align:inherit;',
'overflow:hidden;white-space:pre-wrap;word-break:break-word;margin:0 0 6pt;}',
'.doc-b[data-type="heading"]{font-weight:700;}',
'.doc-b[data-type="heading"][data-level="1"]{font-size:17pt;margin:12pt 0 6pt;}',
'.doc-b[data-type="heading"][data-level="2"]{font-size:14pt;margin:10pt 0 5pt;}',
'.doc-b[data-type="heading"][data-level="3"]{font-size:12pt;margin:8pt 0 4pt;}',
'.doc-b[data-type="quote"]{font-style:italic;color:#444;margin:4pt 0;padding-left:18pt;}',
'.doc-b[data-type="code"]{font-family:Consolas,"Cascadia Mono","Courier New",monospace;',
'font-size:9.5pt;margin:3pt 0;padding-left:18pt;}',
'.doc-list-item{display:flex;align-items:flex-start;}',
'.doc-list-item::before{content:attr(data-marker);box-sizing:border-box;flex:0 0 36pt;',
'text-align:center;padding-right:0;line-height:1.15;}',
'.doc-list-item[data-level="1"]{margin-left:18pt;}',
'.doc-list-item[data-level="2"]{margin-left:36pt;}',
'.doc-list-item[data-level="3"]{margin-left:54pt;}',
'.doc-b[data-type="hr"]{border-top:.5pt solid #bfbfbf;margin:4pt 0;height:1px;}',
'.doc-b table{border-collapse:collapse;width:100%;margin:0 0 6pt;font-size:10pt;}',
'.doc-b th,.doc-b td{border:.5pt solid #999;padding:4pt 6pt;text-align:left;vertical-align:top;}',
'.doc-b th{background:#eee;font-weight:600;}',
'.doc-b img.doc-img{max-width:100%;display:block;margin:8px;border-radius:4px;}',
'#' + BTN_ID + '{width:18px;min-width:18px;flex:1;background:var(--surface);border:0;',
'border-top:1px solid var(--border,#2a2f3a);cursor:pointer;display:flex;align-items:center;',
'justify-content:center;color:var(--muted,#8b93a7);font-size:.92rem;user-select:none;',
'transition:color .2s,background .2s;}',
'#' + BTN_ID + ':hover,#' + BTN_ID + '.open{background:var(--surface2);color:var(--accent,#4da3ff);}'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('doc-editor-css')) return;
    const s = document.createElement('style');
    s.id = 'doc-editor-css';
    s.textContent = DOC_CSS;
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const bar = document.getElementById('left-toggles');
    if (!bar) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.title = 'Documentos (Ctrl+Shift+D)';
    b.innerHTML = '&#128196;';
    b.addEventListener('click', () => api.toggle());
    bar.appendChild(b);
  }

  // ── UI dentro del panel ────────────────────────────────────────────────
  function buildUI() {
    const h = host();
    if (!h || h.dataset.built) return;
    h.dataset.built = '1';
    h.innerHTML = [
'<div class="doc-bar">',
  '<span class="doc-title" id="doc-title">Documentos</span>',
  '<span class="doc-sub" id="doc-sub"></span>',
  '<div class="doc-views" id="doc-views">',
    '<button class="doc-btn on" data-view="content" title="Contenido editable">Contenido</button>',
    '<button class="doc-btn" data-view="pages" title="Paginas del PDF original">Paginas</button>',
  '</div>',
  '<button class="doc-btn" id="doc-new" title="Documento nuevo">Nuevo</button>',
  '<button class="doc-btn" id="doc-open" title="Abrir PDF, DOCX, TXT o Markdown">Abrir</button>',
  '<button class="doc-btn" id="doc-recent" title="Documentos recientes">Recientes</button>',
  '<button class="doc-btn" id="doc-undo" title="Deshacer (Ctrl+Z)" disabled>↶</button>',
  '<button class="doc-btn" id="doc-redo" title="Rehacer (Ctrl+Y)" disabled>↷</button>',
  '<button class="doc-btn" id="doc-find" title="Buscar y reemplazar">Buscar</button>',
  '<button class="doc-btn" id="doc-stats" title="Recuento de palabras y elementos">Recuento</button>',
  '<button class="doc-btn primary" id="doc-save" title="Guardar (Ctrl+S)">Guardar</button>',
  '<button class="doc-btn" id="doc-saveas" title="Guardar como DOCX, PDF, TXT o Markdown">Guardar como</button>',
'</div>',
  '<div class="doc-formatbar" id="doc-formatbar" aria-label="Formato del bloque seleccionado">',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-style">Estilo</label>',
      '<select id="doc-style" title="Cambiar estilo del bloque"><option value="paragraph">Normal</option>',
        '<option value="heading-1">Título 1</option><option value="heading-2">Título 2</option>',
        '<option value="heading-3">Título 3</option><option value="quote">Cita</option>',
        '<option value="code">Código</option></select></div>',
    '<div class="doc-format-group"><label class="doc-format-label" for="doc-size">Tamaño</label>',
      '<select id="doc-size" title="Tamaño de fuente del bloque"><option value="11">11</option>',
        '<option value="9">9</option><option value="10">10</option><option value="12">12</option>',
        '<option value="14">14</option><option value="16">16</option><option value="18">18</option>',
        '<option value="24">24</option><option value="36">36</option></select>',
      '<button class="doc-format-tool" data-block-toggle="bold" title="Negrita del bloque"><b>B</b></button>',
      '<button class="doc-format-tool" data-block-toggle="italic" title="Cursiva del bloque"><i>I</i></button>',
      '<button class="doc-format-tool" data-block-toggle="underline" title="Subrayado del bloque"><u>U</u></button></div>',
    '<div class="doc-format-group" aria-label="Alineación">',
      '<button class="doc-format-tool" data-block-align="left" title="Alinear a la izquierda">⇤</button>',
      '<button class="doc-format-tool" data-block-align="center" title="Centrar">↔</button>',
      '<button class="doc-format-tool" data-block-align="right" title="Alinear a la derecha">⇥</button>',
      '<button class="doc-format-tool" data-block-align="justify" title="Justificar">☰</button></div>',
    '<div class="doc-format-group" aria-label="Listas">',
      '<button class="doc-format-tool" data-block-list="bullet" title="Viñetas">•</button>',
      '<button class="doc-format-tool" data-block-list="ordered" title="Numeración">1.</button>',
      '<button class="doc-format-tool" id="doc-insert-pagebreak" title="Insertar salto de página">↵</button>',
      '<button class="doc-format-tool" data-block-move="up" title="Mover bloque arriba">↑</button>',
      '<button class="doc-format-tool" data-block-move="down" title="Mover bloque abajo">↓</button>',
      '<button class="doc-format-tool" data-block-delete title="Eliminar bloque seleccionado">×</button></div>',
  '</div>',
'<div id="doc-warn-host"></div>',
'<div class="doc-scroll" id="doc-scroll"><div id="doc-body"></div></div>',
'<div class="doc-toast" id="doc-toast"></div>'].join('\n');

    h.querySelector('#doc-new').addEventListener('click', onNew);
    h.querySelector('#doc-open').addEventListener('click', onOpen);
    h.querySelector('#doc-recent').addEventListener('click', onRecents);
    h.querySelector('#doc-save').addEventListener('click', onSave);
    h.querySelector('#doc-saveas').addEventListener('click', onSaveAs);
    h.querySelector('#doc-undo').addEventListener('click', () => travelHistory('undo'));
    h.querySelector('#doc-redo').addEventListener('click', () => travelHistory('redo'));
    h.querySelector('#doc-find').addEventListener('click', findAndReplace);
    h.querySelector('#doc-stats').addEventListener('click', showDocumentStats);
    h.querySelector('#doc-formatbar').addEventListener('click', onFormatClick);
    h.querySelector('#doc-style').addEventListener('change', (e) => {
      if (e.target.value === 'paragraph' || e.target.value === 'quote' || e.target.value === 'code') {
        applyBlockType(e.target.value);
      } else {
        const level = Number(e.target.value.split('-')[1]);
        if (level >= 1 && level <= 3) applyBlockType('heading', level);
      }
    });
    h.querySelector('#doc-size').addEventListener('change', (e) => {
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        const size = Number(e.target.value);
        if (size > 0) next.size = size;
        else delete next.size;
        return next;
      });
    });
    h.querySelector('#doc-views').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) setView(b.dataset.view);
    });
    wireEditing();
  }

  function setView(v) {
    ui.view = v === 'pages' ? 'pages' : 'content';
    const h = host();
    if (!h) return;
    h.querySelectorAll('#doc-views button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === ui.view);
    });
    if (ui.view === 'pages') renderPages();
    else render();
  }

  // ── Pestaña ────────────────────────────────────────────────────────────
function ensureTab() {
    const existing = docTab();
    if (existing) return existing.id;
    if (typeof addTab !== 'function') return null;
    // Se crea con mc://doc y NO con about:blank a proposito: el webview de la
    // app convierte cualquier navegacion a about:blank de vuelta en
    // "mc://newtab" (ver el did-navigate de bindWebviewToTab), y eso borraria
    // la url de la pestaña. Con mc://doc la carga falla en silencio (no es
    // http) y la url se mantiene, tal como funciona la pestaña del Lab.
    addTab(TAB_URL);
    const t = docTab();
    return t ? t.id : null;
  }

  function setTabTitle(text) {
    const t = docTab();
    if (!t) return;
    t.title = text;
    const te = document.querySelector('#tab-' + t.id + ' .tab-title');
    if (te) te.textContent = text;
    const fav = document.querySelector('#tab-' + t.id + ' .tab-favicon');
    if (fav) fav.textContent = '📄';
  }

  function select(id) {
    const h = host();
    if (!h) return;
    h.querySelectorAll('.doc-b.sel').forEach((x) => x.classList.remove('sel'));
    if (id) {
      const b = h.querySelector('.doc-b[data-id="' + cssEscape(id) + '"]');
      if (b) b.classList.add('sel');
    }
    refreshFormatBar();
  }

  function selectedBlock() {
    const h = host();
    const id = h && h.querySelector('.doc-b.sel')?.dataset.id;
    return id && ui.snap && ui.snap.doc
      ? (ui.snap.doc.blocks || []).find((block) => block.id === id) || null
      : null;
  }

  function refreshFormatBar() {
    const h = host();
    const bar = h && h.querySelector('#doc-formatbar');
    if (!bar) return;
    const block = selectedBlock();
    const supported = block && ['paragraph', 'heading', 'quote', 'code', 'list'].includes(block.type);
    bar.querySelectorAll('button,select').forEach((control) => {
      const formatOnly = control.id === 'doc-style' || control.id === 'doc-size' ||
        control.hasAttribute('data-block-toggle') || control.hasAttribute('data-block-align') ||
        control.hasAttribute('data-block-list') || control.id === 'doc-insert-pagebreak';
      control.disabled = !block || (formatOnly && !supported);
    });
    if (!block) return;
    const blocks = ui.snap.doc.blocks || [];
    const index = blocks.findIndex((item) => item.id === block.id);
    bar.querySelectorAll('[data-block-move]').forEach((button) => {
      button.disabled = button.dataset.blockMove === 'up' ? index <= 0 : index < 0 || index >= blocks.length - 1;
    });
    bar.querySelector('#doc-style').value = block.type === 'heading' ? 'heading-' + (block.level || 1)
      : ['paragraph', 'quote', 'code'].includes(block.type) ? block.type : 'paragraph';
    if (!supported) return;
    bar.querySelector('#doc-size').value = String(block.size || 11);
    bar.querySelectorAll('[data-block-toggle]').forEach((button) => {
      button.classList.toggle('active', !!block[button.dataset.blockToggle]);
    });
    bar.querySelectorAll('[data-block-align]').forEach((button) => {
      button.classList.toggle('active', (block.align || 'left') === button.dataset.blockAlign);
    });
    bar.querySelectorAll('[data-block-list]').forEach((button) => {
      button.classList.toggle('active', block.type === 'list' && block.ordered === (button.dataset.blockList === 'ordered'));
    });
  }

  async function applySelectedBlock(update) {
    const h = host();
    const selected = h && h.querySelector('.doc-b.sel');
    const id = selected && selected.dataset.id;
    if (!id || !ui.snap || !ui.snap.open) return;
    await flushPending();
    const current = (ui.snap.doc.blocks || []).find((block) => block.id === id);
    if (!current) return;
    const next = update(current);
    if (!next) return;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'replaceBlock', id, block: next }] });
    if (res && res.ok) { applySnapshot(res); select(id); }
    else if (res && res.error) toast(res.error, 'error');
  }

  function applyBlockType(type, level) {
    applySelectedBlock((block) => {
      const next = Object.assign({}, block);
      if (type === 'list') {
        next.items = block.type === 'list' ? block.items.slice() : blockText(block).split(/\r?\n/).filter((item) => item.trim());
        if (!next.items.length) return null;
        next.ordered = false;
        if (block.type !== 'list') { delete next.text; delete next.runs; }
      } else if (block.type === 'list') {
        next.text = blockText(block);
        delete next.items; delete next.ordered;
      }
      next.type = type;
      if (type === 'heading') next.level = level || 1;
      else if (type !== 'list') delete next.level;
      return next;
    });
  }

  function onFormatClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.blockToggle) {
      const key = button.dataset.blockToggle;
      applySelectedBlock((block) => {
        const next = Object.assign({}, block);
        if (next[key]) delete next[key];
        else next[key] = true;
        return next;
      });
    } else if (button.dataset.blockAlign) {
      applySelectedBlock((block) => Object.assign({}, block, { align: button.dataset.blockAlign }));
    } else if (button.dataset.blockList) {
      const block = selectedBlock();
      if (!block) return;
      const ordered = button.dataset.blockList === 'ordered';
      if (block.type === 'list' && block.ordered === ordered) applyBlockType('paragraph');
      else applySelectedBlock((current) => {
        const next = Object.assign({}, current);
        next.items = current.type === 'list' ? current.items.slice() : blockText(current).split(/\r?\n/).filter((item) => item.trim());
        if (!next.items.length) return null;
        next.type = 'list'; next.ordered = ordered;
        delete next.text; delete next.runs;
        return next;
      });
    } else if (button.id === 'doc-insert-pagebreak') {
      insertSelectedPageBreak();
    } else if (button.dataset.blockMove) {
      moveSelectedBlock(button.dataset.blockMove);
    } else if (button.hasAttribute('data-block-delete')) {
      deleteSelectedBlock();
    }
  }

  async function insertSelectedPageBreak() {
    const block = selectedBlock();
    if (!block || !ui.snap) return;
    await flushPending();
    const index = ui.snap.doc.blocks.findIndex((item) => item.id === block.id);
    if (index < 0) return;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'insert', index: index + 1, block: { type: 'pagebreak' } }
    ] });
    if (res && res.ok) { applySnapshot(res); select(block.id); }
    else if (res && res.error) toast(res.error, 'error');
  }

  async function moveSelectedBlock(direction) {
    const selected = selectedBlock();
    if (!selected || !ui.snap) return;
    await flushPending();
    const blocks = ui.snap.doc.blocks || [];
    const index = blocks.findIndex((block) => block.id === selected.id);
    const insertAt = direction === 'up' ? index - 1 : index + 2;
    if (index < 0 || insertAt < 0 || index >= blocks.length || (direction === 'down' && index >= blocks.length - 1)) return;
    const moved = Object.assign({}, blocks[index]);
    delete moved.id;
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [
      { op: 'insert', index: insertAt, block: moved },
      { op: 'deleteBlock', id: selected.id }
    ] });
    if (res && res.ok) {
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      const movedId = res.doc.blocks[newIndex]?.id;
      applySnapshot(res);
      if (movedId) select(movedId);
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function deleteSelectedBlock() {
    const block = selectedBlock();
    if (!block || !ui.snap) return;
    const label = blockText(block).trim().slice(0, 80) || block.type;
    if (!window.confirm('¿Eliminar este bloque?\n\n' + label)) return;
    await flushPending();
    const res = await API.docEdit({ expectedHash: ui.snap.doc.hash, ops: [{ op: 'deleteBlock', id: block.id }] });
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error, 'error');
  }

  async function travelHistory(direction) {
    await flushPending();
    const res = direction === 'undo' ? await API.docUndo() : await API.docRedo();
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error);
  }

  async function findAndReplace() {
    await flushPending();
    const find = window.prompt('Buscar texto en el documento:');
    if (!find) return;
    const replace = window.prompt('Reemplazar por:', '');
    if (replace == null) return;
    if (!window.confirm('Reemplazar todas las coincidencias de «' + find + '»?')) return;
    const res = await API.docEdit({ expectedHash: ui.snap?.doc?.hash, ops: [
      { op: 'replace', find, replace, all: true, caseSensitive: false }
    ] });
    if (res && res.ok) { applySnapshot(res); toast('Reemplazo aplicado en ' + res.applied + ' bloque(s)'); }
    else if (res && res.error) toast(res.error, 'error');
  }

  async function showDocumentStats() {
    await flushPending();
    const res = await API.docRead({ maxChars: 200000 });
    if (res && res.error) { toast(res.error, 'error'); return; }
    const stats = res && res.stats;
    if (!stats) return;
    window.alert('Palabras: ' + stats.words + '\nCaracteres: ' + stats.chars +
      '\nBloques: ' + stats.blocks + '\nTítulos: ' + stats.headings +
      '\nTablas: ' + stats.tables + '\nImágenes: ' + stats.images + '\nPáginas: ' + stats.pages);
  }

  // ── Contenido ──────────────────────────────────────────────────────────
  function blockText(b) {
    if (typeof b.text === 'string') return b.text;
    if (Array.isArray(b.runs)) return b.runs.map((r) => (r && r.text) || '').join('');
    if (Array.isArray(b.items)) return b.items.join('\n');
    return '';
  }

  function blockMarkup(b) {
    if (b.type === 'list') {
      const items = Array.isArray(b.items) ? b.items.slice() : [];
      if (!items.length) items.push('');
      const level = Math.min(3, Math.max(0, Number(b.level) || 0));
      return items.map((it, i) => '<div class="doc-list-item" data-level="' + level + '" data-marker="' +
        esc(b.ordered ? (i + 1) + '.' : '•') + '"><textarea class="doc-t" rows="1" data-li="' + i +
        '" placeholder="elemento">' + esc(it) + '</textarea></div>').join('');
    }
    if (b.type === 'table') {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      let out = '<table>';
      rows.forEach((row, ri) => {
        const tag = (b.header && ri === 0) ? 'th' : 'td';
        out += '<tr>';
        (Array.isArray(row) ? row : []).forEach((cell) => { out += '<' + tag + '>' + esc(cell) + '</' + tag + '>'; });
        out += '</tr>';
      });
      return out + '</table>';
    }
    if (b.type === 'image') {
      return '<img class="doc-img" src="' + esc(b.src || '') + '" alt="' + esc(b.alt || '') + '">';
    }
    if (b.type === 'pagebreak' || b.type === 'hr') return '';
    return '<textarea class="doc-t" rows="1">' + esc(blockText(b)) + '</textarea>';
  }

  function blockStyle(b) {
    const styles = [];
    if (b.align && ['left', 'center', 'right', 'justify'].includes(b.align)) styles.push('text-align:' + b.align);
    if (Number.isFinite(Number(b.size)) && Number(b.size) >= 4) styles.push('font-size:' + Number(b.size) + 'pt');
    if (b.color && /^#[0-9a-fA-F]{3,8}$/.test(b.color)) styles.push('color:' + b.color);
    if (b.bold) styles.push('font-weight:700');
    if (b.italic) styles.push('font-style:italic');
    if (b.underline) styles.push('text-decoration:underline');
    return styles.length ? ' style="' + esc(styles.join(';')) + '"' : '';
  }

  function createPaperPage(stack, page, pageNumber) {
    const scale = 96 / 72;
    const width = Math.max(100, Number(page.width) || 595) * scale;
    const height = Math.max(100, Number(page.height) || 842) * scale;
    const margin = Math.max(0, Number(page.margin) || 0) * scale;
    const paper = document.createElement('section');
    paper.className = 'doc-paper';
    paper.dataset.page = pageNumber;
    paper.style.width = width + 'px';
    paper.style.height = height + 'px';
    paper.style.padding = margin + 'px';
    const content = document.createElement('div');
    content.className = 'doc-paper-content';
    content.style.height = Math.max(1, height - margin * 2 - 2) + 'px';
    paper.appendChild(content);
    stack.appendChild(paper);
    return content;
  }

  function layoutPaperPages(stack, blocks, nodes, page) {
    stack.replaceChildren();
    let content = createPaperPage(stack, page, 1);
    for (const block of blocks) {
      if (block.type === 'pagebreak') {
        if (content.childElementCount) content = createPaperPage(stack, page, stack.children.length + 1);
        continue;
      }
      const node = nodes.get(block.id);
      if (!node) continue;
      content.appendChild(node);
      node.querySelectorAll('.doc-t').forEach(autosize);
      if (content.childElementCount > 1 && content.scrollHeight > content.clientHeight + 1) {
        content.removeChild(node);
        content = createPaperPage(stack, page, stack.children.length + 1);
        content.appendChild(node);
      }
    }
  }

  function render() {
    const b0 = el('doc-body');
    if (!b0) return;
    const snap = ui.snap;
    if (!snap || !snap.open) {
      b0.innerHTML = '<div class="doc-empty"><h3>Ningun documento abierto</h3>' +
        '<p>Abri un PDF, DOCX, TXT o Markdown para editarlo.</p>' +
        '<p style="margin-top:14px"><button class="doc-btn primary" id="doc-open2">Abrir documento</button></p></div>';
      const b2 = b0.querySelector('#doc-open2');
      if (b2) b2.addEventListener('click', onOpen);
      return;
    }
    const blocks = (snap.doc && snap.doc.blocks) || [];
    b0.innerHTML = blocks.map((b) =>
      '<div class="doc-b" data-type="' + esc(b.type) + '" data-level="' + (b.level || '') +
        '" data-id="' + esc(b.id) + '"' + blockStyle(b) + '>' + blockMarkup(b) + '</div>'
    ).join('');
    const nodes = new Map(Array.from(b0.querySelectorAll(':scope > .doc-b')).map(node => [node.dataset.id, node]));
    const stack = document.createElement('div');
    stack.className = 'doc-paper-stack';
    b0.replaceChildren(stack);
    layoutPaperPages(stack, blocks, nodes, snap.doc.page || { width: 595, height: 842, margin: 57 });
  }

  // Para distinguir pestañas manda el nombre del archivo; el titulo que trae el
  // documento dentro (primer encabezado) va como dato secundario.
  function labelOf(snap) {
    if (!snap || !snap.open) return 'Documentos';
    return snap.sourceName || (snap.doc && snap.doc.title) || 'Documento';
  }

  function renderChrome() {
    const h = host();
    if (!h) return;
    const snap = ui.snap;
    const t = el('doc-title');
    const s = el('doc-sub');
    const btnSave = el('doc-save');
    const btnUndo = el('doc-undo');
    const btnRedo = el('doc-redo');
    if (!snap || !snap.open) {
      t.textContent = 'Documentos';
      s.textContent = '';
      btnSave.disabled = true;
      btnUndo.disabled = true;
      btnRedo.disabled = true;
      setTabTitle('📄 Documentos');
      return;
    }
    const nombre = labelOf(snap);
    t.innerHTML = esc(nombre) + (snap.dirty ? '<span class="doc-star">*</span>' : '');
    const bits = [];
    bits.push(snap.capabilities && snap.capabilities.isPdfSource ? 'PDF' : String(snap.format || '').toUpperCase());
    if (snap.pageCount) bits.push(snap.pageCount + ' pag');
    bits.push(((snap.doc && snap.doc.blocks) || []).length + ' bloques');
    const tituloDoc = snap.doc && snap.doc.title;
    if (tituloDoc && tituloDoc !== nombre) bits.push(tituloDoc);
    s.textContent = bits.join(' · ');
    btnSave.disabled = !snap.dirty || !snap.sourcePath;
    btnUndo.disabled = !snap.history?.canUndo;
    btnRedo.disabled = !snap.history?.canRedo;
    setTabTitle('📄 ' + nombre + (snap.dirty ? ' *' : ''));
  }

  function renderWarnings() {
    const wh = el('doc-warn-host');
    if (!wh) return;
    const w = (ui.snap && ui.snap.warnings) || [];
    wh.innerHTML = w.length
      ? '<div class="doc-warn">' + esc(w.slice(0, 3).join(' · ')) +
        (w.length > 3 ? ' (+' + (w.length - 3) + ' avisos)' : '') + '</div>'
      : '';
  }

  function repaint() {
    if (!host()) return;
    renderChrome();
    renderWarnings();
    if (ui.view === 'pages') renderPages();
    else render();
  }

  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 18) + 'px';
  }

  // ── Paginas del PDF ────────────────────────────────────────────────────
  async function renderPages() {
    const scroll = el('doc-scroll');
    if (!scroll) return;
    const b0 = el('doc-body');
    const token = ++ui.pdfRenderToken;
    b0.innerHTML = '<div class="doc-empty"><p>Cargando paginas...</p></div>';
    const res = await API.docBytes();
    if (token !== ui.pdfRenderToken) return;
    if (!res || !res.ok || !res.bytes) {
      b0.innerHTML = '<div class="doc-empty"><h3>Sin paginas que mostrar</h3>' +
        '<p>La vista de paginas solo existe para los PDF originales. Para TXT, Markdown o DOCX usa la pestana Contenido.</p></div>';
      return;
    }
    try {
      const lib = await loadPdfjs();
      if (token !== ui.pdfRenderToken) return;
      const task = lib.getDocument({ data: new Uint8Array(res.bytes), disableWorker: true, isEvalSupported: false });
      const pdf = await task.promise;
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-pages"></div>';
      const pages = b0.querySelector('.doc-pages');
      const total = pdf.numPages;
      const MAX = 60;
      for (let i = 1; i <= Math.min(total, MAX); i++) {
        const page = await pdf.getPage(i);
        if (token !== ui.pdfRenderToken) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min((scroll.clientWidth - 60) / base.width, 1.5) || 1;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const wrap = document.createElement('div');
        wrap.className = 'doc-page-wrap';
        wrap.appendChild(canvas);
        const no = document.createElement('span');
        no.className = 'doc-page-no';
        no.textContent = i + ' / ' + total;
        wrap.appendChild(no);
        pages.appendChild(wrap);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      if (total > MAX) {
        const note = document.createElement('div');
        note.className = 'doc-empty';
        note.innerHTML = '<p>Solo se pintan las primeras ' + MAX + ' paginas de ' + total +
          '.<br>El texto completo esta en la pestana Contenido.</p>';
        pages.appendChild(note);
      }
    } catch (e) {
      if (token !== ui.pdfRenderToken) return;
      b0.innerHTML = '<div class="doc-empty"><h3>No pude pintar las paginas</h3><p>' + esc(e.message) + '</p></div>';
    }
  }

  // pdf.js en el renderer: los bundles estan vendorizados y se sirven por
  // file://, asi que se puede usar el worker fake sin CSP que lo bloquee.
  const VENDOR = '../modules/document-editor/vendor/';
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = injectScript(VENDOR + 'pdf.worker.min.js')
      .then(() => injectScript(VENDOR + 'pdf.min.js'))
      .then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js no se cargo');
        if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.js';
        return lib;
      })
      .catch((e) => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  // ── Acciones ───────────────────────────────────────────────────────────
  // Todas las acciones de abrir/create usan el snapshot que devuelve el main y,
  // ademas, el evento doc:changed. Aplicar el retorno evita que, si el evento
  // llegara tarde o perdiera el renderer, la pestana quedara mostrando el
  // documento anterior.
  async function onOpen() {
    const res = await API.docOpen();
    if (!res) return;
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); setView('content'); }
  }

  async function onNew() {
    const res = await API.docCreate({ title: 'Documento nuevo' });
    if (res && res.error) toast(res.error, 'error');
    else { applySnapshot(res); setView('content'); }
  }

  async function onRecents() {
    const res = await API.docRecents();
    const items = (res && res.recents) || [];
    const b0 = el('doc-body');
    if (!b0) return;
    if (ui.view === 'pages') setView('content');
    b0.innerHTML = '<div class="doc-empty" style="text-align:left;padding:26px">' +
      '<h3>Documentos recientes</h3>' +
      (items.length
        ? '<ul>' + items.map((r) =>
            '<li><button class="doc-btn" data-recent="' + esc(r.path) + '">Abrir</button>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.name || r.path) + '</span>' +
            '<span style="color:var(--muted);font-size:.78rem">' + esc(String(r.format || '').toUpperCase()) + '</span></li>').join('') + '</ul>'
        : '<p style="margin-top:10px">Todavia no abriste ningun documento.</p>') +
      '</div>';
    b0.querySelectorAll('[data-recent]').forEach((b) => b.addEventListener('click', async () => {
      const r = await API.docRecentOpen({ path: b.dataset.recent });
      if (r && r.error) toast(r.error, 'error');
      else { applySnapshot(r); setView('content'); }
    }));
  }

  async function onSave() {
    await flushPending();
    const res = await API.docSave();
    if (!res) return;
    if (res.needsSaveAs) {
      toast(res.error || 'Elige "Guardar como"');
      return onSaveAs();
    }
    if (res.error) toast(res.error, 'error');
    else { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  async function onSaveAs() {
    await flushPending();
    const res = await API.docSaveAs({});
    if (res && res.error) toast(res.error, 'error');
    else if (res && res.canceled) return;
    else if (res) { applySnapshot(res); toast('Guardado ' + res.sourceName); }
  }

  // ── Edición ────────────────────────────────────────────────────────────
  let pending = null;   // { id, text } esperando confirmación

  function flushPending() {
    if (!pending) return Promise.resolve();
    const p = pending;
    pending = null;
    return commit(p.id, p.text, p.itemIndex);
  }

  async function commit(id, text, itemIndex) {
    const snap = ui.snap;
    if (!snap || !snap.open) return;
    const block = ((snap.doc && snap.doc.blocks) || []).find((b) => b.id === id);
    if (!block) return;
    if (itemIndex != null && block.type === 'list') {
      if (block.items[itemIndex] === text) return;
      const items = block.items.slice();
      items[itemIndex] = text;
      const res = await API.docEdit({
        expectedHash: snap.doc.hash,
        ops: [{ op: 'replaceBlock', id, block: Object.assign({}, block, { items }) }]
      });
      if (res && res.ok) applySnapshot(res);
      else if (res && res.error) toast(res.error, 'error');
      return;
    }
    if (blockText(block) === text) return;
    const next = Object.assign({}, block, { text });
    delete next.runs;
    const res = await API.docEdit({
      expectedHash: snap.doc.hash,
      ops: [{ op: 'replaceBlock', id, block: next }]
    });
    if (res && res.ok) applySnapshot(res);
    else if (res && res.error) toast(res.error, 'error');
  }

  // Solo acepta snapshots de verdad: `{canceled:true}` de un dialogo o
  // `{error}` no pueden pisar lo que hay en pantalla.
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (snap.error || snap.canceled) return;
    if (!('open' in snap)) return;
    ui.snap = snap;
    repaint();
  }

  async function insertAfter(id) {
    const snap = ui.snap;
    if (!snap || !snap.open) return;
    const blocks = (snap.doc && snap.doc.blocks) || [];
    const i = blocks.findIndex((b) => b.id === id);
    const res = await API.docEdit({
      expectedHash: snap.doc.hash,
      ops: [{ op: 'insert', index: i + 1, block: { type: 'paragraph', text: '' } }]
    });
    if (res && res.ok) {
      applySnapshot(res);
      const nuevo = ((res.doc.blocks || [])[i + 1] || {}).id;
      setTimeout(() => focusBlock(nuevo), 30);
    } else if (res && res.error) toast(res.error, 'error');
  }

  async function mergeIntoPrevious(blocks, i) {
    const prev = blocks[i - 1];
    const cur = blocks[i];
    if (!prev || !cur) return;
    const hash = ui.snap.doc.hash;
    const texto = blockText(cur);
    const items = (cur.items || []).filter((x) => x !== '');
    let ops;
    if (prev.type === 'list') {
      const nuevo = (prev.items || []).concat(texto.split('\n')).filter((x) => x !== '');
      if (!nuevo.length) return;
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { items: nuevo }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    } else if (items.length) {
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { text: blockText(prev) + '\n' + items.join('\n') }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    } else if (texto === '') {
      return;   // un bloque vacío no se fusiona: se deja para borrar
    } else {
      ops = [
        { op: 'replaceBlock', id: prev.id, block: Object.assign({}, prev, { text: blockText(prev) + '\n' + texto }) },
        { op: 'deleteBlock', id: cur.id }
      ];
    }
    const res = await API.docEdit({ expectedHash: hash, ops });
    if (res && res.ok) {
      applySnapshot(res);
      setTimeout(() => focusBlock(prev.id), 30);
    } else if (res && res.error) toast(res.error, 'error');
  }

  function focusBlock(id) {
    const h = host();
    if (!h) return;
    const t = h.querySelector('.doc-b[data-id="' + cssEscape(id) + '"] .doc-t');
    if (t) {
      t.focus();
      t.selectionStart = t.selectionEnd = t.value.length;
    }
  }

  // ── Fila flotante de bloque ────────────────────────────────────────────
  // ── Cableado de edición ────────────────────────────────────────────────
  function wireEditing() {
    const b0 = el('doc-body');
    if (!b0 || b0.dataset.wired) return;
    b0.dataset.wired = '1';

    b0.addEventListener('focusin', (e) => {
      const ta = e.target.closest && e.target.closest('.doc-t');
      if (!ta) return;
      autosize(ta);
      const bEl = ta.closest('.doc-b');
      if (bEl) {
        select(bEl.dataset.id);
        pending = { id: bEl.dataset.id, text: ta.value, itemIndex: ta.dataset.li == null ? null : Number(ta.dataset.li) };
      }
    });
    b0.addEventListener('input', (e) => {
      const ta = e.target.closest && e.target.closest('.doc-t');
      if (!ta) return;
      autosize(ta);
      const bEl = ta.closest('.doc-b');
      if (bEl) pending = { id: bEl.dataset.id, text: ta.value, itemIndex: ta.dataset.li == null ? null : Number(ta.dataset.li) };
    });
    b0.addEventListener('focusout', () => {
      // Un tick de retardo deja que el click en la fila flotante cuente como
      // edición y no como "perdí el foco sin guardar nada".
      setTimeout(() => flushPending(), 0);
    });
    b0.addEventListener('mousedown', (e) => {
      const bEl = e.target.closest('.doc-b');
      select(bEl ? bEl.dataset.id : null);
    });
  }

  // ── Teclado ────────────────────────────────────────────────────────────
  async function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      api.toggle();
      return;
    }
    if (!isActive()) return;

    const enCampo = !!(e.target && e.target.closest && e.target.closest('textarea, input'));
    if (e.key === 'Escape' && !enCampo) { e.preventDefault(); api.close(); return; }
    if (e.ctrlKey || e.metaKey) {
      const k = String(e.key || '').toLowerCase();
      if (k === 'z') { e.preventDefault(); await travelHistory(e.shiftKey ? 'redo' : 'undo'); return; }
      if (k === 'y') { e.preventDefault(); await travelHistory('redo'); return; }
      if (k === 'f') { e.preventDefault(); findAndReplace(); return; }
      if (k === 's') { e.preventDefault(); onSave(); return; }
      if (k === 'o') { e.preventDefault(); onOpen(); return; }
    }

    const ta = e.target && e.target.closest && e.target.closest('.doc-t');
    if (!ta || ta.dataset.li) return;
    const bEl = ta.closest('.doc-b');
    if (!bEl) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter confirma y crea el bloque siguiente.
      e.preventDefault();
      await flushPending();
      await insertAfter(bEl.dataset.id);
      return;
    }
    if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const blocks = (ui.snap && ui.snap.doc && ui.snap.doc.blocks) || [];
      const i = blocks.findIndex((x) => x.id === bEl.dataset.id);
      if (i > 0) {
        e.preventDefault();
        await flushPending();
        await mergeIntoPrevious(blocks, i);
      }
    }
  }

  // ── API pública ────────────────────────────────────────────────────────
  const api = {
    async open() {
      injectStyles(); injectButton(); buildUI();
      const id = ensureTab();
      if (id != null && typeof switchTab === 'function' && state0().activeTab !== id) switchTab(id);
      // showPanel deja el panel visible; si la pestaña quedó activa, switchTab
      // ya lo hizo.
      if (panel() && !panel().classList.contains('active') && typeof showPanel === 'function') showPanel('doc');
      wireEditing();
      if (!ui.snap) {
        ui.snap = await API.docState({});
        repaint();
      } else {
        repaint();
      }
      return api;
    },
    toggle() {
      const t = docTab();
      if (t && state0().activeTab === t.id) return api.close();
      return api.open();
    },
    close() {
      flushPending();
      const t = docTab();
      const s = state0();
      if (!t) return;
      // No se puede cerrar la última pestaña: en ese caso se vuelve a la
      // primera que no sea de documentos.
      if (typeof closeTab === 'function' && (s.tabs || []).length > 1) {
        closeTab({ stopPropagation() {} }, t.id);
      } else {
        const otra = (s.tabs || []).find((x) => x.url !== TAB_URL);
        if (otra && typeof switchTab === 'function') switchTab(otra.id);
      }
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.remove('open');
    },
    isOpen() {
      const t = docTab();
      return !!(t && state0().activeTab === t.id);
    },
    /** Lo llama el main cuando el SO abre un archivo con la app. */
    async openPath(p) {
      await api.open();
      // El main ya abrio el archivo y mando el snapshot con la peticion: solo
      // hay que mostrarlo. Si por alguna razon no vino, se pide explicitamente
      // (con withBytes:false, que los bytes del PDF se piden aparte).
      if (p && p.snap) {
        applySnapshot(p.snap);
      } else {
        const res = await API.docOpenPath({ path: (p && p.path) || '', withBytes: false });
        if (res && res.error) { toast(res.error, 'error'); return res; }
        if (res && res.ok) applySnapshot(res);
      }
      setView('content');
      return ui.snap;
    },
    snapshot() { return ui.snap; },
    applySnapshot
  };

  window.DocEditor = api;

  // ── Eventos del main ───────────────────────────────────────────────────
  try {
    API.on('doc:changed', (snap) => {
      ui.snap = snap;
      if (!host()) return;
      if (isActive()) repaint();
      else renderChrome();   // alcanza con actualizar el título de la pestaña
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.classList.toggle('open', api.isOpen());
    });
    API.on('doc:open-request', (p) => { api.openPath(p); });
    API.on('doc:error', (p) => toast((p && p.error) || 'Error del editor', 'error'));
  } catch {}

  // ── Arranque ───────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    injectButton();
    buildUI();
    document.addEventListener('keydown', onKeyDown, true);
    API.docState({}).then((snap) => {
      ui.snap = snap;
      if (snap && snap.open && host()) renderChrome();
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // El panel y la barra lateral pueden aparecer después (la barra se
  // reemplaza al cambiar de sesión). Se agrupa con rAF para no correr por
  // cada nodo que mueve la app.
  let moQueued = false;
  const mo = new MutationObserver(() => {
    if (moQueued) return;
    moQueued = true;
    requestAnimationFrame(() => {
      moQueued = false;
      injectButton();
      buildUI();
    });
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();