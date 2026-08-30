// Advanced Web Scraping Techniques for AI
// modules/ai-assistant/scraping-tools.js

'use strict';

const ScrapingTools = {
  /**
   * Técnicas avanzadas de scraping para IA
   */

  // 1. DOM Container Isolation - Aislar contenedor específico
  isolateContainer: (selector, html) => {
    if (!selector || !html) return null;

    // Usar DOMParser si está disponible (webview context)
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const element = doc.querySelector(selector);
        if (element) {
          return element.outerHTML;
        }
      } catch {}
    }

    // Fallback: regex simple
    // Buscar atributo data-* o id específico
    const idMatch = selector.match(/#([\w-]+)/);
    const classMatch = selector.match(/\.([\w-]+)/);

    if (idMatch) {
      const regex = new RegExp(`<[^>]*id=["']${idMatch[1]}["'][^>]*>([\\s\\S]*?)<\\/[^>]*>`, 'i');
      const match = html.match(regex);
      if (match) return match[0];
    }

    if (classMatch) {
      const regex = new RegExp(`<[^>]*class=["'][^"']*${classMatch[1]}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]*>`, 'i');
      const match = html.match(regex);
      if (match) return match[0];
    }

    return null;
  },

  // 2. Structure Analysis - Analizar estructura de página
  analyzePageStructure: (html) => {
    const structure = {
      title: '',
      meta: {},
      headings: {},
      lists: 0,
      tables: 0,
      forms: 0,
      scripts: 0,
      styles: 0,
      images: 0,
      links: 0,
      iframes: 0,
      mainContent: null,
      sidebars: [],
      footers: []
    };

    // Title
    structure.title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';

    // Meta tags
    (html.match(/<meta[^>]*>/gi) || []).forEach(tag => {
      const name = tag.match(/name=["']([^"']+)["']/i)?.[1];
      const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
      if (name) structure.meta[name] = content;
    });

    // Headings distribution
    for (let i = 1; i <= 6; i++) {
      const count = (html.match(new RegExp(`<h${i}[^>]*>`, 'gi')) || []).length;
      if (count) structure.headings[`h${i}`] = count;
    }

    // Counts
    structure.lists = (html.match(/<(ul|ol)[^>]*>/gi) || []).length;
    structure.tables = (html.match(/<table[^>]*>/gi) || []).length;
    structure.forms = (html.match(/<form[^>]*>/gi) || []).length;
    structure.scripts = (html.match(/<script[^>]*>/gi) || []).length;
    structure.styles = (html.match(/<style[^>]*>/gi) || []).length;
    structure.images = (html.match(/<img[^>]*>/gi) || []).length;
    structure.links = (html.match(/<a[^>]*href=/gi) || []).length;
    structure.iframes = (html.match(/<iframe[^>]*>/gi) || []).length;

    // Detectar secciones principales
    const mainRegex = /<(main|article|section)[^>]*id=["']([^"']+)["']/gi;
    let match;
    while ((match = mainRegex.exec(html))) {
      structure.mainContent = match[2];
    }

    return structure;
  },

  // 3. Content Extraction Patterns - Patrones comunes de extracción
  extractByPattern: (html, pattern) => {
    const patterns = {
      'articles': {
        selectors: ['article', '[data-article]', '.article', '.post', '.entry'],
        fields: ['title', 'date', 'author', 'content', 'link']
      },
      'products': {
        selectors: ['[data-product]', '.product', '.item', '[itemtype*="Product"]'],
        fields: ['name', 'price', 'rating', 'image', 'url']
      },
      'tables': {
        regex: /<table[^>]*>([\s\S]*?)<\/table>/gi,
        extract: (match) => ({
          rows: (match.match(/<tr[^>]*>/gi) || []).length,
          cols: (match.match(/<td[^>]*>/gi) || []).length
        })
      },
      'videos': {
        patterns: [
          /src=["']([^"']*(?:\.mp4|\.webm|m3u8|mpd)[^"']*)["']/gi,
          /href=["']([^"']*(?:youtube|vimeo|dailymotion)[^"']*)["']/gi
        ]
      },
      'links': {
        regex: /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi,
        extract: (match) => ({ url: match[1], text: match[2] })
      }
    };

    const config = patterns[pattern];
    if (!config) return { error: `Patrón "${pattern}" no conocido` };

    if (config.selectors) {
      return {
        selectors: config.selectors,
        fields: config.fields,
        howTo: `Busca elementos que matcheen uno de estos selectores: ${config.selectors.join(', ')}`
      };
    }

    if (config.regex) {
      const matches = [];
      let m;
      while ((m = config.regex.exec(html))) {
        matches.push(config.extract ? config.extract(m) : m[0]);
      }
      return matches;
    }

    if (config.patterns) {
      const results = [];
      config.patterns.forEach(regex => {
        let m;
        while ((m = regex.exec(html))) {
          results.push(m[1]);
        }
      });
      return results;
    }

    return [];
  },

  // 4. Data Cleaning - Limpiar datos extraídos
  cleanData: (data) => {
    if (typeof data === 'string') {
      return data
        .replace(/\s+/g, ' ')                          // Normalizar espacios
        .replace(/[\r\n\t]/g, '')                      // Remover saltos de línea
        .trim();
    }

    if (Array.isArray(data)) {
      return data.map(item => ScrapingTools.cleanData(item));
    }

    if (typeof data === 'object' && data !== null) {
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, ScrapingTools.cleanData(v)])
      );
    }

    return data;
  },

  // 5. XPath Emulator - Para cuando no puedas usar XPath
  findByXPath: (html, xpath) => {
    // Simplificado: convertir XPath básico a selectores CSS
    const cssSelector = xpath
      .replace(/\/\//g, '')               // Remove //
      .replace(/\//g, ' ')                // Replace / with space (descendant)
      .replace(/@id=['"]([^'"]+)['"]/g, '#$1')  // @id -> #
      .replace(/@class=['"]([^'"]+)['"]/g, '.$1') // @class -> .
      .replace(/text\(\)=['"]([^'"]+)['"]/g, ':contains("$1")')
      .trim();

    return {
      cssEquivalent: cssSelector,
      hint: `Intenta usar este selector CSS equivalente: ${cssSelector}`
    };
  },

  // 6. API Discovery - Encontrar APIs ocultas
  discoverAPIs: (html) => {
    const apis = [];

    // Buscar fetch/XHR calls
    const fetchCalls = html.match(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/gi) || [];
    fetchCalls.forEach(call => {
      const url = call.match(/["'`]([^"'`]+)["'`]/)?.[1];
      if (url) apis.push({ type: 'fetch', url, source: 'JavaScript' });
    });

    // Buscar api endpoints en window.location o data attributes
    const apiEndpoints = html.match(/["'](\/api\/[^"']+)["']/gi) || [];
    apiEndpoints.forEach(ep => {
      apis.push({ type: 'api_endpoint', url: ep.slice(1, -1), source: 'HTML data' });
    });

    // Buscar GraphQL
    if (html.includes('graphql')) {
      apis.push({ type: 'graphql', hint: 'GraphQL endpoint detectado', source: 'HTML analysis' });
    }

    return apis;
  },

  // 7. Performance Metrics - Métricas de carga
  getLoadMetrics: (html) => {
    return {
      htmlSize: (html || '').length,
      inlineScripts: (html.match(/<script[^>]*>(?!src)/gi) || []).length,
      externalScripts: (html.match(/<script[^>]*src=/gi) || []).length,
      inlineStyles: (html.match(/<style[^>]*>/gi) || []).length,
      externalStyles: (html.match(/<link[^>]*rel=["']stylesheet/gi) || []).length,
      images: (html.match(/<img[^>]*>/gi) || []).length,
      lazyLoadImages: (html.match(/<img[^>]*loading=["']lazy["']/gi) || []).length,
      thirdPartyScripts: (html.match(/<script[^>]*src=["'](?:https?:)?\/\/(?!localhost)/gi) || []).length
    };
  },

  // 8. Dynamic Content Hints - Detectar contenido dinámico
  detectDynamicContent: (html) => {
    const hints = [];

    if (/<div[^>]*id=["']app["']/.test(html)) hints.push('React/Vue app detected (#app)');
    if (/<div[^>]*id=["']root["']/.test(html)) hints.push('React app detected (#root)');
    if (/<div[^>]*ng-app/.test(html)) hints.push('AngularJS app detected');
    if (html.includes('__INITIAL_STATE__')) hints.push('Next.js or SSR detected');
    if (html.includes('__NUXT__')) hints.push('Nuxt.js detected');
    if (/data-react-root/.test(html)) hints.push('React 18+ detected');

    if (/window\.__data__\s*=/.test(html)) hints.push('Inline data initialization detected');
    if (/var\s+\w+\s*=\s*\{[\s\S]*?\};?\s*<\/script>/m.test(html)) hints.push('JSON data embedded in HTML');

    return hints;
  }
};

module.exports = ScrapingTools;
