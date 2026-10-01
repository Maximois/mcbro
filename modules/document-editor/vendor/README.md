# Vendor: pdf.js

Estos dos archivos son **código de terceros, sin modificar**. Vienen de
[`pdfjs-dist`](https://github.com/mozilla/pdf.js) y están vendorizados (copiados
al repo) para que el módulo funcione sin `node_modules` y sin red.

| Archivo | Origen | Tamaño |
| --- | --- | --- |
| `pdf.min.js` | `pdfjs-dist@3.11.174` → `legacy/build/pdf.min.js` | 377 116 B |
| `pdf.worker.min.js` | `pdfjs-dist@3.11.174` → `legacy/build/pdf.worker.min.js` | 1 133 660 B |

Licencia: **Apache-2.0** (Mozilla Foundation). El aviso completo está en la
cabecera de cada archivo y en
<https://github.com/mozilla/pdf.js/blob/master/LICENSE>.

## Por qué la build `legacy`

La app se sirve por `file://` (ver `main.js`, `mainWin.loadFile`). La build
moderna (`pdfjs-dist/build/`) es *ESM* y además intenta crear Web Workers con
`new Worker(URL)`, que los navegadores bloquean desde `file://`. La build
`legacy/` es UMD y funciona tanto en `<script>` como en `require()` de Node
(main usa `worker_threads`), que es justo lo que necesitamos:

- **main** (`worker_threads`): extrae texto y estructura del PDF.
- **renderer** (`<script>` + fake worker): dibuja las páginas en canvas para
  la vista previa y para las capturas que se le envían a la IA.

## Por qué esta versión y no la más nueva

`3.11.174` es la última 3.x: sigue siendo UMD en la build legacy y funciona con
Node 22 y con Electron sin parches. Las 4.x+ eliminaron la build legacy UMD.

## Cómo actualizar

1. `npm pack pdfjs-dist@<version>`
2. Copiar `package/legacy/build/pdf.min.js` y `package/legacy/build/pdf.worker.min.js`
   sobre estos mismos nombres.
3. Actualizar la tabla de arriba y el smoke test `tools/pdf-smoke.js`.

Verificar que nada más se toca: `git diff --stat modules/document-editor/vendor`
solo debe mostrar estos dos archivos.