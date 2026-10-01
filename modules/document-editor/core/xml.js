'use strict';
/**
 * MC Browser -- modulo document-editor / core/xml.js
 *
 * Parser de XML minimo, sin DOM. Existe por una razon concreta: la lectura de
 * .docx ocurre en el proceso main (Node, dentro de un worker) y tambien puede
 * ocurrir en el renderer, y `DOMParser` solo existe en el segundo. Mantener
 * un unico parser puro en `core/` garantiza que ambos caminos produzcan el
 * mismo modelo y que `node --test` pueda cubrirlo.
 *
 * Es deliberadamente tolerante: si el XML esta mal formado (documentos
 * generados por Word lo estan a menudo, con espacios de nombres exoticos o
 * atributos sin comillas) no lanza error, cierra lo que puede y sigue. Perder
 * un atributo es mejor que perder el documento entero.
 */

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.MCDoc = window.MCDoc || {};
    window.MCDoc.xml = mod;
  }
})(this, function () {
  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function unescapeXml(str) {
    if (!str || str.indexOf('&') === -1) return str || '';
    return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10FFFF) return m;
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      const named = NAMED_ENTITIES[body];
      return named != null ? named : m;
    });
  }

  function escapeXml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function escapeAttr(str) {
    return escapeXml(str).replace(/[\r\n\t]/g, ' ');
  }

  function localName(name) {
    const i = String(name).indexOf(':');
    return i === -1 ? String(name) : String(name).slice(i + 1);
  }

  function makeNode(name) {
    return { type: 'element', name, local: localName(name), attrs: Object.create(null), children: [], parent: null };
  }

  /**
   * parse(xml) -> nodo raiz. children mezcla nodos elemento y strings.
   */
  function parse(xml) {
    const src = String(xml == null ? '' : xml);
    const root = makeNode('#document');
    let node = root;
    let i = 0;
    const len = src.length;

    const pushText = (text) => {
      if (!text) return;
      node.children.push(text);
    };

    while (i < len) {
      const lt = src.indexOf('<', i);
      if (lt === -1) { pushText(unescapeXml(src.slice(i))); break; }
      if (lt > i) pushText(unescapeXml(src.slice(i, lt)));

      // --- CDATA
      if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt);
        const stop = end === -1 ? len : end;
        pushText(src.slice(lt + 9, stop));
        i = end === -1 ? len : end + 3;
        continue;
      }
      // --- Comentario
      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt);
        i = end === -1 ? len : end + 3;
        continue;
      }
      // --- Declaracion / DOCTYPE / PI
      if (src[lt + 1] === '?' || src[lt + 1] === '!') {
        const end = src.indexOf('>', lt);
        i = end === -1 ? len : end + 1;
        continue;
      }
      // --- Cierre
      if (src[lt + 1] === '/') {
        const end = src.indexOf('>', lt);
        const name = src.slice(lt + 2, end === -1 ? len : end).trim();
        // Cerrar hasta encontrar el nodo correspondiente: si hay markup mal
        // anidado, se ignora el cierre huerfano en vez de romper el arbol.
        let target = node;
        while (target && target !== root && target.name !== name) target = target.parent;
        if (target && target !== root) node = target.parent || root;
        i = end === -1 ? len : end + 1;
        continue;
      }
      // --- Apertura
      const end = findTagEnd(src, lt);
      const raw = src.slice(lt + 1, end);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameMatch = /^[^\s/>]+/.exec(body);
      if (!nameMatch) { i = end + 1; continue; }

      const child = makeNode(nameMatch[0]);
      readAttrs(body.slice(nameMatch[0].length), child.attrs);
      child.parent = node;
      node.children.push(child);
      if (!selfClosing) node = child;
      i = end + 1;
    }

    return root;
  }

  // Encuentra el '>' que cierra una etiqueta respetando comillas en atributos.
  function findTagEnd(src, start) {
    let quote = null;
    for (let i = start + 1; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return i;
    }
    return src.length;
  }

  function readAttrs(str, out) {
    const re = /([^\s=/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '';
      out[m[1]] = unescapeXml(value);
    }
  }

  // ----------------------------------------------------------- consulta

  function isElement(n) { return n && n.type === 'element'; }

  function textOf(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    let out = '';
    for (const child of node.children) out += isElement(child) ? textOf(child) : child;
    return out;
  }

  function childNodes(node, local) {
    if (!isElement(node)) return [];
    const out = [];
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (local == null || c.local === local) out.push(c);
    }
    return out;
  }

  function findAll(node, local, out) {
    const acc = out || [];
    if (!isElement(node)) return acc;
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (c.local === local) acc.push(c);
      findAll(c, local, acc);
    }
    return acc;
  }

  function find(node, local) {
    if (!isElement(node)) return null;
    for (const c of node.children) {
      if (isElement(c) && c.local === local) return c;
    }
    return null;
  }

  /** Primer descendiente con ese nombre local, en profundidad. */
  function findDeep(node, local) {
    if (!isElement(node)) return null;
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (c.local === local) return c;
      const deep = findDeep(c, local);
      if (deep) return deep;
    }
    return null;
  }

  /** Primer descendiente que cumple el predicado sobre nombre local. */
  function findWhere(node, predicate) {
    if (!isElement(node)) return null;
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (predicate(c)) return c;
      const deep = findWhere(c, predicate);
      if (deep) return deep;
    }
    return null;
  }

  /** Atributo por nombre local, aceptando prefijos de espacio de nombres. */
  function attr(node, name) {
    if (!isElement(node)) return '';
    const direct = node.attrs[name];
    if (direct != null) return direct;
    for (const key of Object.keys(node.attrs)) {
      if (localName(key) === name) return node.attrs[key];
    }
    return '';
  }

  return {
    parse, textOf, childNodes, find, findDeep, findAll, findWhere, attr,
    isElement, localName, escapeXml, escapeAttr, unescapeXml
  };
});
