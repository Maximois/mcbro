/**
 * tools/doc-editor-tab-smoke.js
 *
 * Prueba la PESTAÑA del editor de documentos contra la UI real y el preload
 * real dentro de Electron (no un stub): sirve src/renderer.html tal cual, abre
 * un documento de verdad por cada formato y comprueba que:
 *
 *   - aparece una pestaña mc://doc (no un modal sobre la interfaz),
 *   - el panel #panel-doc queda activo y #webview-container oculto,
 *   - los bloques se pintan,
 *   - editar un bloque llega a main por doc:edit (mismo camino que la IA),
 *   - la pestaña se cierra sola y vuelve la anterior.
 *
 * Uso:  npx electron tools/doc-editor-tab-smoke.js
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'doced-tab-'));
app.setPath('userData', tmpUserData);
app.commandLine.appendSwitch('disable-gpu');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); fail++; }
}

let win = null;
const errors = [];

app.whenReady().then(async () => {
  // ── Canales minimos que la UI real consulta al arrancar ───────────────
  const stub = (v) => () => v;
  ipcMain.handle('get-cfg', () => ({}));
  ipcMain.handle('update-cfg', () => ({}));
  ipcMain.handle('get-stats', stub({}));
  ipcMain.handle('get-media', stub({}));
  ipcMain.handle('get-sysinfo', stub({}));
  ipcMain.handle('get-processes', stub([]));
  ipcMain.handle('ai:list-models', stub([]));
  ipcMain.handle('sessions:list', stub([]));

  // ── El modulo real del editor ─────────────────────────────────────────
  const docMain = require(path.join(ROOT, 'modules', 'document-editor', 'main.js'));
  docMain.setup({ getMainWin: () => win });

  // ── Archivos de prueba ────────────────────────────────────────────────
  const docs = path.join(tmpUserData, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const txtPath = path.join(docs, 'notas.txt');
  const mdPath = path.join(docs, 'leeme.md');
  const docxPath = path.join(docs, 'informe.docx');
  fs.writeFileSync(txtPath, 'Titulo en texto\n\nPrimer parrafo con acentos: ñ, á, é.\n\n- uno\n- dos\n', 'utf8');
  fs.writeFileSync(mdPath, '# Encabezado\n\nCuerpo del markdown.\n', 'utf8');

  // Un DOCX real, generado por el propio modulo.
  const model = require(path.join(ROOT, 'modules', 'document-editor', 'core', 'model.js'));
  const I = docMain._internals;
  fs.writeFileSync(docxPath, await I.docToBytes(model.createDoc({
    title: 'Informe de la pestaña',
    blocks: [
      { type: 'heading', level: 1, text: 'Informe de la pestaña' },
      { type: 'paragraph', text: 'Parrafo para la prueba de integracion.' },
      { type: 'list', ordered: false, items: ['uno', 'dos'] }
    ]
  }), 'docx'));

  win = new BrowserWindow({
    show: false,
    width: 1280, height: 900,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && /doc-editor|DocEditor/.test(message)) errors.push(message);
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer.html'));
  const run = (code) => win.webContents.executeJavaScript(code, true);
  // Volcado de estado para que un assert fallido diga que paso de verdad.
  const probe = () => run(`(() => ({
    tabs: state.tabs.map(t => ({ id: t.id, url: t.url, title: t.title })),
    activa: state.activeTab,
    panelDoc: document.getElementById('panel-doc').classList.contains('active'),
    panelNewtab: document.getElementById('panel-newtab').classList.contains('active'),
    hayDocTab: !!document.querySelector('#tabbar .tab'),
    docTabs: state.tabs.filter(t => t.url === 'mc://doc').map(t => t.id),
    bloques: document.querySelectorAll('#doc-host .doc-b').length,
    snap: window.DocEditor && window.DocEditor.snapshot()
      ? (window.DocEditor.snapshot().sourceName || '(nuevo)') : null,
    urlBar: document.getElementById('urlinput').value
  }))()`).catch((e) => ({ error: e.message }));

  // ── 1. El boton lateral existe ────────────────────────────────────────
  await ta('el boton lateral del editor se inyecta en la barra', async () => {
    const r = await run(`(() => ({
      hayBoton: !!document.getElementById('doc-editor-btn'),
      hayPanel: !!document.getElementById('panel-doc'),
      hayHost: !!document.getElementById('doc-host'),
      api: typeof window.DocEditor
    }))()`);
    assert.strictEqual(r.hayBoton, true, 'falta el boton en la barra lateral');
    assert.strictEqual(r.hayPanel, true, 'falta el panel');
    assert.strictEqual(r.hayHost, true, 'falta el contenedor del editor');
    assert.strictEqual(r.api, 'object', 'window.DocEditor no quedo expuesto');
  });

  // ── 2. Open crea la PESTANA y activa el panel ─────────────────────────
  await ta('abrir el editor crea una pestaña mc://doc y activa su panel', async () => {
    const r = await run(`(async () => {
      await window.DocEditor.open();
      const tabs = state.tabs;
      const doc = tabs.find(t => t.url === 'mc://doc');
      return {
        totalTabs: tabs.length,
        docTabId: doc ? doc.id : null,
        docActiva: doc ? doc.id === state.activeTab : false,
        titulo: doc ? doc.title : '',
        panelActivo: document.getElementById('panel-doc').classList.contains('active'),
        webviewOculto: getComputedStyle(document.getElementById('webview-container')).display === 'none',
        barraVisible: !!document.querySelector('#doc-host .doc-bar'),
        overlay: !!document.getElementById('doc-overlay')
      };
    })()`);
    assert.ok(r.totalTabs >= 2, 'deberia existir la pestaña inicial mas la de documentos');
    assert.ok(r.docTabId, 'no se creo la pestaña mc://doc');
    assert.strictEqual(r.docActiva, true, 'la pestaña de documentos deberia quedar activa');
    assert.match(r.titulo, /Documentos/, 'la pestaña deberia llamarse Documentos: ' + r.titulo);
    assert.strictEqual(r.panelActivo, true, 'el panel #panel-doc deberia estar activo');
    assert.strictEqual(r.webviewOculto, true, 'el webview deberia quedar oculto');
    assert.strictEqual(r.barraVisible, true, 'la barra del editor deberia existir dentro del panel');
    assert.strictEqual(r.overlay, false, 'no debe quedar ningun overlay a pantalla completa');
  });

  // ── 3. No tapa la interfaz ────────────────────────────────────────────
  await ta('el editor no tapa la barra de direcciones ni la barra de pestanas', async () => {
    const r = await run(`(() => {
      const doc = document.getElementById('panel-doc');
      const cs = getComputedStyle(doc);
      const tabbar = document.getElementById('tabbar').getBoundingClientRect();
      const url = document.getElementById('urlinput').getBoundingClientRect();
      const rect = doc.getBoundingClientRect();
      return {
        posicion: cs.position,
        zIndex: cs.zIndex,
        solapaTabbar: rect.top < tabbar.bottom,
        solapaUrl: rect.top < url.bottom,
        tabbarVisible: tabbar.height > 0
      };
    })()`);
    assert.notStrictEqual(r.posicion, 'fixed', 'el panel no debe ser position:fixed sobre todo');
    assert.strictEqual(r.solapaTabbar, false, 'el panel se superpone a la barra de pestanas');
    assert.strictEqual(r.solapaUrl, false, 'el panel se superpone a la barra de direcciones');
    assert.strictEqual(r.tabbarVisible, true);
  });

  // ── 4. Abrir un TXT de verdad pinta bloques ───────────────────────────
// Se abre desde el main con handleExternalOpen: es exactamente lo que pasa
// cuando el usuario hace doble clic en el .txt con la app instalada.
await ta('abrir un TXT de verdad (como el SO) pinta los bloques', async () => {
    const r = await docMain.handleExternalOpen(txtPath);
    assert.strictEqual(r.error, undefined, 'no se abrio el TXT: ' + r.error);
    await new Promise((r2) => setTimeout(r2, 700));
    const st = await run(`(() => ({
      bloques: document.querySelectorAll('#doc-host .doc-b').length,
      titulo: document.getElementById('doc-title').textContent,
      sub: document.getElementById('doc-sub').textContent,
      fuente: window.DocEditor.snapshot() ? window.DocEditor.snapshot().sourceName : null,
      panel: document.getElementById('panel-doc').classList.contains('active')
    }))()`);
    assert.strictEqual(st.panel, true,
      'la apertura externa deberia mostrar la pestaña · estado: ' + JSON.stringify(await probe()));
    assert.ok(st.bloques >= 3, 'pocos bloques pintados: ' + st.bloques);
    assert.match(st.titulo, /notas\.txt/, 'titulo inesperado: ' + st.titulo);
    assert.match(st.sub, /TXT/);
    assert.strictEqual(st.fuente, 'notas.txt');
  });

  // ── 5. DOCX y Markdown tambien ────────────────────────────────────────
  for (const [label, file] of [['un DOCX', docxPath], ['un Markdown', mdPath]]) {
    await ta('abrir ' + label + ' de verdad pinta los bloques', async () => {
      const res = await docMain.handleExternalOpen(file);
      assert.strictEqual(res.error, undefined, 'no se abrio ' + label + ': ' + res.error);
      await new Promise((r2) => setTimeout(r2, 500));
      const st = await run(`(() => ({
        bloques: document.querySelectorAll('#doc-host .doc-b').length,
        sub: document.getElementById('doc-sub').textContent,
        lista: document.querySelectorAll('#doc-host .doc-b[data-type=list]').length
      }))()`);
      assert.ok(st.bloques >= 2, 'pocos bloques para ' + label + ': ' + st.bloques);
      if (label === 'un DOCX') {
        assert.match(st.sub, /DOCX/);
        assert.ok(st.lista >= 1, 'el DOCX deberia traer la lista');
      } else {
        assert.match(st.sub, /MD|MARKDOWN/);
      }
    });
  }

  // ── 6. Editar un bloque va a main por el camino de parches ────────────
  await ta('editar un bloque llega a main por doc:edit (mismo camino que la IA)', async () => {
    const r = await run(`(async () => {
      const ta = document.querySelector('#doc-host .doc-b .doc-t');
      const id = ta.closest('.doc-b').dataset.id;
      const antes = window.DocEditor.snapshot();
      ta.value = 'Parrafo editado desde la pestaña.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('focusout', { bubbles: true }));
      ta.blur();
      await new Promise(r2 => setTimeout(r2, 400));
      const despues = window.DocEditor.snapshot();
      return {
        id,
        hashAntes: antes.doc.hash,
        hashDespues: despues.doc.hash,
        dirty: despues.dirty,
        guardado: despues.capabilities.canSaveInPlace,
        primero: despues.doc.blocks[0].text,
        asterisco: document.getElementById('doc-title').textContent.includes('*')
      };
    })()`);
    assert.notStrictEqual(r.hashDespues, r.hashAntes, 'el hash deberia cambiar al editar');
    assert.strictEqual(r.dirty, true, 'el documento deberia quedar sucio');
    assert.strictEqual(r.primero, 'Parrafo editado desde la pestaña.', 'el cambio no llego a main');
    assert.strictEqual(r.guardado, true, 'un TXT se debe poder guardar en el sitio');
    assert.strictEqual(r.asterisco, true, 'el titulo deberia marcar el documento como modificado');
  });

  // ── 7. Ctrl+Shift+D alterna la pestaña ────────────────────────────────
  await ta('Ctrl+Shift+D cierra la pestaña y deja activa la anterior', async () => {
    const antes = await run(`(() => ({ total: state.tabs.length, docId: (state.tabs.find(t=>t.url==='mc://doc')||{}).id }))()`);
    await run(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'D', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
      }));
    })()`);
    await new Promise((r2) => setTimeout(r2, 200));
    const despues = await run(`(() => ({
      total: state.tabs.length,
      quedaDoc: state.tabs.some(t => t.url === 'mc://doc'),
      activa: state.activeTab
    }))()`);
    assert.strictEqual(despues.quedaDoc, false,
      'la pestaña de documentos deberia haberse cerrado · estado: ' + JSON.stringify(await probe()));
    assert.strictEqual(despues.total, antes.total - 1,
      'faltó o sobró una pestaña · estado: ' + JSON.stringify(await probe()));
    assert.notStrictEqual(despues.activa, antes.docId);
  });

  await ta('el boton lateral vuelve a abrir la misma pestaña (sin duplicar)', async () => {
    const r = await run(`(async () => {
      document.getElementById('doc-editor-btn').click();
      await new Promise(r2 => setTimeout(r2, 300));
      const docs = state.tabs.filter(t => t.url === 'mc://doc');
      return {
        docs: docs.length,
        activa: docs.length ? docs[0].id === state.activeTab : false,
        panel: document.getElementById('panel-doc').classList.contains('active')
      };
    })()`);
    assert.strictEqual(r.docs, 1,
      'no deberia haber mas de una pestaña de documentos · estado: ' + JSON.stringify(await probe()));
    assert.strictEqual(r.activa, true);
    assert.strictEqual(r.panel, true);
  });

  await ta('no quedaron errores de consola del editor', () => {
    assert.deepStrictEqual(errors, [], 'errores del editor: ' + errors.join(' | '));
  });

  // ── 8. Vista de Paginas con pdf.js real en el renderer ───────────────
  // El PDF minimo no alcanza para pintar (no tiene fuentes), asi que se usa uno
  // real del disco si esta; si no, se salta con aviso.
  const pdfArgIndex = process.argv.indexOf('--pdf');
  const realPdf = (pdfArgIndex > -1 ? process.argv[pdfArgIndex + 1] : '') || process.env.DOC_TEST_PDF || [
    'C:\\Downloads\\CV Victor Gonzales.pdf',
    path.join(os.homedir(), 'Downloads', 'CV Victor Gonzales.pdf'),
    path.join(os.homedir(), 'Desktop', 'CV Victor Gonzales.pdf')
  ].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

  if (realPdf) {
    await ta('la vista Paginas pinta el PDF original con pdf.js', async () => {
      const res = await docMain.handleExternalOpen(realPdf);
      assert.strictEqual(res.error, undefined, 'no se abrio el PDF: ' + res.error);
      await new Promise((r2) => setTimeout(r2, 600));
      const st = await run(`(async () => {
        document.querySelector('#doc-views button[data-view=pages]').click();
        await new Promise(r2 => setTimeout(r2, 6000));
        const cs = document.querySelectorAll('#doc-host .doc-page-wrap canvas');
        return {
          canvas: cs.length,
          ancho: cs.length ? cs[0].width : 0,
          alto: cs.length ? cs[0].height : 0,
          tieneLib: typeof window.pdfjsLib === 'object',
          sub: document.getElementById('doc-sub').textContent
        };
      })()`);
      assert.strictEqual(st.tieneLib, true, 'pdf.js no se cargo desde el vendor');
      assert.ok(st.canvas >= 1, 'no se pinto ninguna pagina');
      assert.ok(st.ancho > 50 && st.alto > 50, 'la pagina salio vacia: ' + st.ancho + 'x' + st.alto);
      assert.match(st.sub, /PDF/);
    });
    await ta('volver a Contenido restaura los bloques tras mirar Paginas', async () => {
      const st = await run(`(async () => {
        document.querySelector('#doc-views button[data-view=content]').click();
        await new Promise(r2 => setTimeout(r2, 400));
        return {
          bloques: document.querySelectorAll('#doc-host .doc-b').length,
          canvas: document.querySelectorAll('#doc-host canvas').length
        };
      })()`);
      assert.ok(st.bloques >= 1, 'no quedaron bloques visibles');
      assert.strictEqual(st.canvas, 0, 'sigue el canvas del PDF en la vista de contenido');
    });
  } else {
    console.log('  --   vista Paginas sin verificar: no encontre un PDF real en Downloads/Desktop');
  }

  // ── 9. Exportacion a PDF (si el PDF real existe) ─────────────────────
  await ta('el documento se exporta a PDF con printToPDF', async () => {
    const bytes = await I.printToPdfBytes(docMain.getState().doc);
    assert.ok(bytes && bytes.length > 1500, 'el PDF salio demasiado chico: ' + (bytes && bytes.length));
    assert.strictEqual(bytes.slice(0, 5).toString('latin1'), '%PDF-', 'no empieza con %PDF-');
    assert.ok(bytes.includes(Buffer.from('%%EOF')), 'al PDF le falta el trailer');
  });
  await ta('el HTML de impresion trae el texto del documento', async () => {
    const r = await run(`window.mc.docPrintHtml()`);
    assert.strictEqual(r.ok, true);
    assert.match(r.html, /Informe de la pestaña|CV Victor|leeme|notas/i,
      'el HTML de impresion no parece traer el contenido');
  });

  console.log('\n' + pass + ' pasaron, ' + fail + ' fallaron\n');
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('\nsmoke de pestaña fallo de forma inesperada:', (e && e.stack) || e);
  app.exit(1);
});