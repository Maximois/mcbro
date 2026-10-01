# Editor de documentos (PDF, DOCX, TXT, Markdown)

Módulo independiente para abrir, editar y reexportar documentos dentro de MC
Browser. PDF y DOCX no se editan página a página: se convierten a un modelo
canónico de bloques, se edita eso y se vuelve a exportar.

## Qué abre

| Formato | Lectura | Guardado en el sitio | Exportación |
|---|---|---|---|
| PDF | texto y estructura por geometría | no (se guarda como DOCX/TXT/PDF nuevo) | PDF, DOCX, TXT, MD |
| DOCX | OOXML completo: runs, tablas, listas, imágenes, metadatos | sí | PDF, DOCX, TXT, MD |
| TXT | texto plano | sí | PDF, DOCX, TXT, MD |
| Markdown | estructura por marcas | sí | PDF, DOCX, TXT, MD |

Un PDF no se puede "guardar en el sitio" porque escribir sobre el original
destruiría el archivo sin forma de recuperar la maquetación: el editor fuerza
"Guardar como" y genera un archivo nuevo.

## Cómo se usa

El editor es una **pestaña del navegador** (`mc://doc`), no una ventana
superpuesta: la barra de direcciones, las pestañas y la barra lateral siguen
visibles y en su lugar normal.

- Botón de documento en la barra lateral izquierda, o **Ctrl+Shift+D**, abre la
  pestaña (y la enfoca si ya estaba abierta, sin duplicarla).
- **Ctrl+S** guarda, **Ctrl+O** abre, **Esc** cierra la pestaña.
- **Ctrl+Z** deshace, **Ctrl+Y** o **Ctrl+Shift+Z** rehace, y **Ctrl+F** busca/reemplaza.
- El botón `×` de la pestaña y **Ctrl+W** la cierran como cualquier otra.
- Clic en un bloque y Enter crea el bloque siguiente.
- Backspace al principio de un bloque lo fusiona con el anterior.
- La cinta superior da formato al bloque seleccionado, cambia su orden o lo elimina.
- Deshacer incluye cambios del usuario y parches de la IA (hasta 100 pasos).
- Pestaña **Páginas** muestra el PDF original renderizado (hasta 60 páginas);
  **Contenido** muestra el texto editable.
- Si el usuario abre un `.pdf`/`.docx`/`.txt`/`.md` haciendo doble clic (o con
  "Abrir con"), el editor aparece solo en esa pestaña.

## Arquitectura

```
core/          puro, sin Electron ni DOM. Testeable con node --test.
  model.js       modelo canónico, hash, outline, texto plano, Markdown
  patch.js       parches atómicos con expectedHash
  pdf-text.js    extracción PDF por geometría de pdf.js
  docx-read.js   DOCX -> bloques
  docx-write.js  bloques -> OOXML
  zip.js         lector/escritor ZIP (métodos 0 y 8, CompressionStream)
  xml.js         parser XML tolerante a namespaces
  html.js        bloques -> HTML para preview y para printToPDF
  text-io.js     TXT/Markdown -> bloques y viceversa
main.js        dueño del archivo: lecturas, escrituras, diálogos, backups,
               recientes, sandbox y export a PDF (printToPDF)
worker.js      extracción PDF/DOCX en un worker_threads
renderer.js    pestaña mc://doc: UI, edición de bloques y render de páginas
vendor/        pdfjs-dist 3.11.174 legacy (Apache-2.0)
```

El **main** es dueño del documento. El renderer y la IA mandan los mismos
parches sobre el mismo hash: no hay dos caminos que puedan pisarse.

La pestaña se apoya en tres enganches en `src/renderer.html`: el panel
`#panel-doc` con su `#doc-host`, y dos ramas que reconhecen `mc://doc`
(`showWebview()` y `loadUrl()`), igual que `mc://newtab` y `mc://lab`.

## Cómo se prueba

```
npm test                                  # nucleo (node --test)
node tools/doc-editor-smoke.js            # main con stub de Electron
node tools/doc-editor-worker.js           # worker con archivos reales
npx electron tools/doc-editor-tab-smoke.js --pdf "C:\ruta\a\algo.pdf"
```

El último abre la UI real y el preload real dentro de Electron y comprueba que
el editor aparece como pestaña (y no como modal), que TXT/DOCX/MD se abren, que
una edición llega a main por `doc:edit`, que el PDF se pinta con pdf.js y que
`printToPDF` genera un PDF válido.

## Reglas de la IA

La IA edita con parches atómicos, nunca reescribiendo el documento:

```doc:read
```

Trae el texto y el **hash** actual. Después:

````
```doc:patch
{ "expectedHash": "<hash del doc:read>", "ops": [
  { "op": "replace", "find": "texto exacto", "replace": "texto nuevo" },
  { "op": "insert", "after": "ancla", "block": { "type": "paragraph", "text": "..." } },
  { "op": "style", "find": "texto", "bold": true },
  { "op": "setTitle", "title": "..." }
] }
```
````

Si el parche vuelve con error de hash obsoleto, el documento cambió: hay que
volver a `doc:read`. Si falla una operación, se descarta el parche entero.

## Seguridad

- Solo se tocan archivos concedidos: los que el usuario eligió con un diálogo,
  los que abrió el sistema operativo con la app, o los del sandbox.
- Nada se sobrescribe sin dejar copia en `userData/doc-editor/backups/`.
- La escritura es atómica (temporal + rename).
- Las imágenes del modelo solo se aceptan como `data:`.
- Límites: 100 MB por archivo, 2000 páginas, 5000 bloques, 200 operaciones
  por parche.

## Limitaciones

- La extracción de PDF es heurística. No hay OCR: un PDF escaneado como
  imagen sale vacío, y el editor lo avisa. Las tablas en PDF no se detectan
  como tablas (salen como líneas de texto).
- No se conservan los estilos de página del PDF original: al exportar se
  reconstruye con CSS de impresión A4.
- La escritura a PDF usa `printToPDF`, así que el resultado se parece al modelo,
  no al archivo original.

## Herramientas de prueba

```
node --test test/document-editor.test.js   # núcleo, parches, DOCX, PDF
node tools/doc-editor-smoke.js             # main con stub de Electron
node tools/doc-editor-worker.js            # worker real de extracción
node tools/docx-smoke.js                   # round-trip DOCX
node tools/pdf-smoke.js <archivo.pdf>      # extracción PDF real
```

`doc-editor-smoke.js` intercepta `require('electron')` con un stub, así que
corre fuera de la app. La exportación a PDF necesita una ventana real y solo
se prueba a mano dentro de Electron.