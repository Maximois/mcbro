'use strict';
/**
 * MC Browser -- modulo document-editor / core/docx-write.js
 *
 * Modelo -> partes OOXML de un .docx. No se usa la libreria `docx` a
 * proposito: el modelo ya es pequeno y controlado, y generar el paquete a
 * mano evita 1 MB de dependencia y un arbol de objetos que habria que mapear
 * bloque por bloque igual.
 *
 * Lo que se emite es WordprocessingML minimo pero correcto: partes
 * obligatorias ([Content_Types].xml, _rels, document.xml), estilos basicos
 * para que los titulos sean titulos de verdad, numeracion real para las
 * listas y formato de caracter directo para el resto.
 *
 * El orden de los elementos dentro de <w:pPr> y <w:rPr> NO es libre: lo fija
 * el esquema XSD y Word rechaza el archivo si se altera. Por eso los
 * emisores de abajo arman las propiedades en el orden de la especificacion y
 * no "en el orden que queda comodo".
 */

(function (root, factory) {
  const mod = factory({
    model: (typeof require === 'function' && typeof module === 'object') ? require('./model.js') : (root.MCDoc && root.MCDoc.model)
  });
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.docxWrite = mod;
  }
})(this, function (deps) {
  const model = deps.model;
  const X = (s) => escapeXml(s);

  function escapeXml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Caracteres de control que Word no acepta en XML.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  const NS = [
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
  ].join(' ');

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const PT_TO_TWIP = 20;          // 1 pt = 20 twips
  const PT_TO_EMU = 12700;        // 1 pt = 12700 EMU
  const PX_TO_EMU = 9525;         // 1 px @96dpi = 9525 EMU

  function halfPoints(pt) {
    const n = Math.round(Number(pt) * 2);
    return Math.min(96, Math.max(8, n || 22));
  }

  // ------------------------------------------------------------ propiedades

  /** <w:rPr> en el orden que exige el esquema: rFonts, b, i, color, sz, szCs, u. */
  function runProps(props) {
    if (!props) return '';
    let out = '<w:rPr>';
    out += '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
    if (props.bold) out += '<w:b/><w:bCs/>';
    if (props.italic) out += '<w:i/><w:iCs/>';
    if (props.color) out += `<w:color w:val="${X(String(props.color).replace('#', '').slice(0, 6).toUpperCase())}"/>`;
    if (props.size) {
      const hp = halfPoints(props.size);
      out += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
    }
    if (props.underline) out += '<w:u w:val="single"/>';
    out += '</w:rPr>';
    return out;
  }

  /**
   * <w:pPr> en el orden del esquema: pStyle, numPr, pBdr, spacing, ind, jc, rPr.
   */
  function paraProps(block, opts) {
    const o = opts || {};
    let out = '<w:pPr>';

    if (block.type === 'heading') {
      out += `<w:pStyle w:val="Heading${Math.min(3, Math.max(1, block.level || 1))}"/>`;
    } else if (block.type === 'quote') {
      out += `<w:pStyle w:val="Quote"/>`;
    } else if (block.type === 'code') {
      out += '<w:spacing w:before="60" w:after="60"/><w:ind w:left="360"/>';
    } else if (block.type === 'list') {
      out += `<w:pStyle w:val="ListParagraph"/>`;
      out += `<w:numPr><w:ilvl w:val="${Math.min(2, Number(block.level) || 0)}"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`;
    } else if (block.type === 'hr') {
      out += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:before="80" w:after="80"/>';
    } else {
      out += '<w:spacing w:after="120"/>';
    }

    if (block.indent) {
      out += `<w:ind w:left="${(Number(block.indent) * 360)}"/>`;
    }
    if (block.align && block.align !== 'left') {
      const jc = { center: 'center', right: 'right', justify: 'both' }[block.align];
      if (jc) out += `<w:jc w:val="${jc}"/>`;
    }

    // Formato de caracter a nivel de parrafo (afecta a las marcas de parrafo).
    const blockRun = {};
    if (block.bold) blockRun.bold = true;
    if (block.italic) blockRun.italic = true;
    if (block.underline) blockRun.underline = true;
    if (block.color) blockRun.color = block.color;
    if (block.size) blockRun.size = block.size;
    if (Object.keys(blockRun).length) out += runProps(blockRun);

    out += '</w:pPr>';
    void o;
    return out;
  }

  function textRun(text, props) {
    if (text == null || text === '') return '';
    const parts = String(text).split('\n');
    let out = '';
    parts.forEach((part, i) => {
      if (i) out += '<w:r><w:br/></w:r>';
      if (!part) return;
      out += `<w:r>${runProps(props)}<w:t xml:space="preserve">${X(part)}</w:t></w:r>`;
    });
    return out;
  }

  function runsOf(block, blockProps) {
    const base = {};
    if (blockProps.bold) base.bold = true;
    if (blockProps.italic) base.italic = true;
    if (blockProps.underline) base.underline = true;
    if (blockProps.color) base.color = blockProps.color;
    if (blockProps.size) base.size = blockProps.size;

    if (Array.isArray(block.runs) && block.runs.length) {
      return block.runs.map(run => textRun(run.text, Object.assign({}, base, run))).join('');
    }
    return textRun(model.blockText(block), base);
  }

  // ------------------------------------------------------------- bloques

  function emitParagraph(block, ctx) {
    if (block.type === 'pagebreak') {
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
    return `<w:p>${paraProps(block, ctx)}${runsOf(block, block)}</w:p>`;
  }

  function emitList(block, ctx) {
    const items = block.items || [];
    return items.map(item => {
      // Cada item es un parrafo con numeracion, que es como Word modela
      // una lista: permite seguir editandola con los controles de Word.
      return `<w:p>${paraProps(block, ctx)}${textRun(item, {
        bold: block.bold, italic: block.italic, underline: block.underline,
        color: block.color, size: block.size
      })}</w:p>`;
    }).join('');
  }

  function emitTable(block, ctx) {
    const rows = block.rows || [];
    const cols = rows.reduce((max, r) => Math.max(max, r.length), 1);
    const total = Math.round(((ctx.pageWidth - ctx.margin * 2) * PT_TO_TWIP) / cols);
    const grid = new Array(cols).fill(`<w:gridCol w:w="${total}"/>`).join('');

    const body = rows.map((row, r) => {
      const isHead = block.header !== false && r === 0;
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const text = row[c] == null ? '' : String(row[c]);
        const runs = textRun(text, { bold: isHead });
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${total}" w:type="dxa"/>` +
          (isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : '') +
          `</w:tcPr><w:p>${isHead ? paraProps({ type: 'paragraph' }, ctx) : paraProps({ type: 'paragraph' }, ctx)}${runs}</w:p></w:tc>`
        );
      }
      return `<w:tr>${cells.join('')}</w:tr>`;
    }).join('');

    return (
      '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
      '<w:tblBorders>' +
      '<w:top w:val="single" w:sz="4" w:space="0" w:color="9E9E9E"/>' +
      '<w:left w:val="single" w:sz="4" w:space="0" w:color="9E9E9E"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="9E9E9E"/>' +
      '<w:right w:val="single" w:sz="4" w:space="0" w:color="9E9E9E"/>' +
      '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C8C8C8"/>' +
      '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="C8C8C8"/>' +
      '</w:tblBorders></w:tblPr>' +
      `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>` +
      // Word exige un parrafo despues de una tabla.
      '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
    );
  }

  function emitImage(block, ctx) {
    if (!model.isSafeImageSrc(block.src)) return '';
    const media = ctx.addMedia(block.src);
    if (!media) return '';
    const maxW = Math.round((ctx.pageWidth - ctx.margin * 2) * PT_TO_EMU);
    const maxH = Math.round((ctx.pageHeight - ctx.margin * 2) * PT_TO_EMU);
    let cx = block.width ? Number(block.width) * PX_TO_EMU : maxW;
    let cy = block.height ? Number(block.height) * PX_TO_EMU : Math.round(maxH * 0.6);
    const scale = Math.min(1, maxW / cx, maxH / cy);
    cx = Math.round(cx * scale);
    cy = Math.round(cy * scale);
    ctx.imageSeq++;
    const id = ctx.imageSeq;
    const name = `Imagen ${id}`;
    return (
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      `<wp:docPr id="${id}" name="${X(name)}" descr="${X(block.alt || '')}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr>' +
      `<pic:cNvPr id="${id}" name="${X(media.file)}" descr="${X(block.alt || '')}"/><pic:cNvPicPr/>` +
      '</pic:nvPicPr>' +
      `<pic:blipFill><a:blip r:embed="${media.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
      (block.alt ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr>` +
        `<w:r>${runProps({ italic: true, color: '666666', size: 9 })}<w:t xml:space="preserve">${X(block.alt)}</w:t></w:r></w:p>` : '')
    );
  }

  // ------------------------------------------------------------- partes

  function contentTypes(ctx) {
    const defaults = [
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>'
    ];
    for (const ext of Object.keys(ctx.mediaByExt)) {
      defaults.push(`<Default Extension="${ext}" ContentType="${ctx.mediaByExt[ext]}"/>`);
    }
    const overrides = [
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    ];
    if (ctx.hasLists) {
      overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>');
    }
    return XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      defaults.join('') + overrides.join('') + '</Types>';
  }

  function rootRels() {
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';
  }

  function coreProps(doc) {
    const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
    return XML_HEAD +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${X(doc.title)}</dc:title>` +
      (doc.meta.author ? `<dc:creator>${X(doc.meta.author)}</dc:creator>` : '') +
      (doc.meta.subject ? `<dc:subject>${X(doc.meta.subject)}</dc:subject>` : '') +
      (doc.meta.keywords ? `<cp:keywords>${X(doc.meta.keywords)}</cp:keywords>` : '') +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${iso(doc.meta.created)}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso(doc.meta.modified)}</dcterms:modified>` +
      '</cp:coreProperties>';
  }

  function appProps(doc) {
    const s = model.stats(doc);
    return XML_HEAD +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>MC Browser</Application><DocSecurity>0</DocSecurity>' +
      `<Paragraphs>${s.blocks}</Paragraphs><Words>${s.words}</Words><Characters>${s.chars}</Characters>` +
      `<Lines>${s.blocks}</Lines><Pages>${s.pages}</Pages>` +
      '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
      '<HyperlinksChanged>false</HyperlinksChanged><ScaleCrop>false</ScaleCrop>' +
      '</Properties>';
  }

  function documentRels(ctx) {
    const rels = [
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    ];
    if (ctx.hasLists) {
      rels.push('<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>');
    }
    for (const m of ctx.media) {
      rels.push(`<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.target}"/>`);
    }
    return XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>';
  }

  function styles() {
    return XML_HEAD +
      `<w:styles ${NS}>` +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="es-ES"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
      '<w:rPr><w:b/><w:bCs/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>' +
      '<w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>' +
      '<w:rPr><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="360"/><w:spacing w:before="80" w:after="80"/></w:pPr>' +
      '<w:rPr><w:i/><w:iCs/><w:color w:val="444444"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
      '</w:styles>';
  }

  function numbering() {
    const bulletLevels = [0, 1, 2].map(ilvl =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
      `<w:lvlText w:val="${['•', '◦', '▪'][ilvl]}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + ilvl * 360}" w:hanging="360"/></w:pPr>` +
      '<w:rPr><w:rFonts w:hint="default"/></w:rPr></w:lvl>').join('');

    const decimalLevels = [0, 1, 2].map(ilvl =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${ilvl ? 'lowerLetter' : 'decimal'}"/>` +
      `<w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="${720 + ilvl * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');

    return XML_HEAD + `<w:numbering ${NS}>` +
      '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + bulletLevels + '</w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' + decimalLevels + '</w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
      '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      '</w:numbering>';
  }

  // ---------------------------------------------------------------- entrada

  /**
   * docToDocxParts(doc, opts) -> { parts: [{name, data}], warnings: [] }
   * No devuelve bytes: el ZIP lo arma el llamador (core/zip.js), asi el
   * mismo codigo sirve para el proceso main y para el renderer.
   */
  function docToDocxParts(doc, opts) {
    const o = opts || {};
    const warnings = (o.warnings || []).slice();
    const page = Object.assign({}, model.PAGE.A4, doc.page || {});
    const media = [];
    const mediaByExt = Object.create(null);

    const ctx = {
      pageWidth: page.width,
      pageHeight: page.height,
      margin: page.margin,
      media,
      mediaByExt,
      hasLists: (doc.blocks || []).some(b => b.type === 'list'),
      imageSeq: 0,
      addMedia(src) {
        const parsed = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/i.exec(src);
        if (!parsed) return null;
        const raw = parsed[1].toLowerCase();
        const ext = raw === 'jpeg' ? 'jpg' : raw === 'svg+xml' ? 'svg' : raw;
        const mime = raw === 'jpg' ? 'image/jpeg' : `image/${raw}`;
        const bytes = base64ToBytes(parsed[2]);
        if (!bytes || !bytes.length) return null;
        const entry = {
          rid: `rIdImg${media.length + 1}`,
          target: `media/image${media.length + 1}.${ext}`,
          file: `image${media.length + 1}.${ext}`,
          ext, bytes
        };
        media.push(entry);
        mediaByExt[ext] = mime;
        return entry;
      }
    };

    const body = [];
    for (const block of doc.blocks || []) {
      if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote' ||
          block.type === 'code' || block.type === 'pagebreak' || block.type === 'hr') {
        body.push(emitParagraph(block, ctx));
      } else if (block.type === 'list') {
        body.push(emitList(block, ctx));
      } else if (block.type === 'table') {
        body.push(emitTable(block, ctx));
      } else if (block.type === 'image') {
        const xml = emitImage(block, ctx);
        if (xml) body.push(xml);
        else warnings.push('una imagen fue descartada: formato no soportado');
      }
    }

    const sectPr =
      '<w:sectPr>' +
      `<w:pgSz w:w="${Math.round(page.width * PT_TO_TWIP)}" w:h="${Math.round(page.height * PT_TO_TWIP)}"/>` +
      `<w:pgMar w:top="${Math.round(page.margin * PT_TO_TWIP)}" w:right="${Math.round(page.margin * PT_TO_TWIP)}" ` +
      `w:bottom="${Math.round(page.margin * PT_TO_TWIP)}" w:left="${Math.round(page.margin * PT_TO_TWIP)}" ` +
      'w:header="708" w:footer="708" w:gutter="0"/>' +
      '</w:sectPr>';

    const document = XML_HEAD + `<w:document ${NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

    const parts = [
      { name: '[Content_Types].xml', data: contentTypes(ctx) },
      { name: '_rels/.rels', data: rootRels() },
      { name: 'docProps/core.xml', data: coreProps(doc) },
      { name: 'docProps/app.xml', data: appProps(doc) },
      { name: 'word/_rels/document.xml.rels', data: documentRels(ctx) },
      { name: 'word/styles.xml', data: styles() },
      { name: 'word/document.xml', data: document }
    ];
    if (ctx.hasLists) parts.push({ name: 'word/numbering.xml', data: numbering() });

    for (const m of media) {
      parts.push({ name: `word/${m.target}`, data: m.bytes, binary: true });
    }
    return { parts, warnings, mediaCount: media.length };
  }

  /** atob existe en Chromium y en Node >= 16; Buffer es el respaldo. */
  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '');
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(clean, 'base64'));
    return new Uint8Array(0);
  }

  return { docToDocxParts, emitParagraph, emitTable, runProps, paraProps, styles, numbering, base64ToBytes, NS, XML_HEAD };
});
