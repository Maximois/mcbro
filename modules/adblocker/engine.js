'use strict';

const T_DOMAIN   = 1;
const T_URL      = 2;
const T_REGEX    = 3;
const T_COSMETIC = 4;

let ruleIdSeq = 0;
function nextId() { return ++ruleIdSeq; }

function parseRule(line) {
  line = line.trim();
  if (!line || line.startsWith('!') || line.startsWith('[')) return null;
  if (line.startsWith('#')) return null;
  const ci = line.indexOf('##');
  if (ci >= 0) {
    return { id: nextId(), type: T_COSMETIC, raw: line, domain: ci > 0 ? line.substring(0, ci) : '', selector: line.substring(ci + 2), exception: line.includes('#@#') };
  }
  let isException = false;
  let rule = line;
  if (rule.startsWith('@@')) { isException = true; rule = rule.substring(2); }
  let opts = {};
  const oi = rule.lastIndexOf('$');
  if (oi > 0) {
    const rawOpts = rule.substring(oi + 1);
    rule = rule.substring(0, oi);
    rawOpts.split(',').forEach(o => { const kv = o.split('='); opts[kv[0]] = kv[1] || true; });
  }
  if (rule.startsWith('/') && rule.endsWith('/') && rule.length > 2) {
    try { const pattern = rule.substring(1, rule.length - 1); return { id: nextId(), type: T_REGEX, raw: line, regex: new RegExp(pattern, 'i'), exception: isException, opts }; } catch { return null; }
  }
  if (rule.startsWith('||')) {
    let d = rule.substring(2);
    const isExactDomain = d.endsWith('^');
    if (isExactDomain) d = d.slice(0, -1);
    const slashIdx = d.indexOf('/');
    const domainPart = slashIdx >= 0 ? d.substring(0, slashIdx) : d;
    const pathPart = slashIdx >= 0 ? d.substring(slashIdx) : '';
    return { id: nextId(), type: T_DOMAIN, raw: line, domain: domainPart, path: pathPart || '/', exactDomain: isExactDomain, exception: isException, opts };
  }
  if (rule.startsWith('http://') || rule.startsWith('https://') || rule.startsWith('*://') || rule.startsWith('//')) {
    let re;
    try {
      const reStr = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      re = new RegExp('^' + reStr + '$', 'i');
    } catch { re = null; }
    return { id: nextId(), type: T_URL, raw: line, pattern: rule, regex: re, exception: isException, opts };
  }
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(rule) && !rule.includes(' ')) {
    return { id: nextId(), type: T_DOMAIN, raw: line, domain: rule, path: '/', exactDomain: false, exception: isException, opts };
  }
  return null;
}

function matchDomain(domain, pattern) {
  if (domain === pattern) return true;
  if (domain.endsWith('.' + pattern)) return true;
  return false;
}

function pathMatch(urlPath, pattern) {
  if (pattern === '/' || pattern === '/*') return true;
  if (pattern.endsWith('*')) return urlPath.startsWith(pattern.slice(0, -1));
  return urlPath === pattern;
}

function checkOpts(opts, details, docDomain) {
  if (!opts || Object.keys(opts).length === 0) return true;
  if (opts.badfilter) return false;
  if (opts.popup && details.type !== 'mainFrame' && details.type !== 'main_frame') return false;
  if (opts.script && details.type !== 'script') return false;
  if (opts.image && details.type !== 'image') return false;
  if (opts.stylesheet && details.type !== 'stylesheet') return false;
  if (opts.object && details.type !== 'object') return false;
  if (opts.xmlhttprequest && details.type !== 'xmlhttprequest') return false;
  if (opts.subdocument && details.type !== 'subdocument') return false;
  if (opts.document && details.type !== 'main_frame') return false;
  if (opts.other && details.type !== 'other') return false;
  if (opts.font && details.type !== 'font') return false;
  if (opts.media && details.type !== 'media') return false;
  if (opts.websocket && details.type !== 'websocket') return false;
  if (opts['third-party']) {
    try {
      const urlDomain = new URL(details.url).hostname;
      const srcDomain = details.documentUrl ? new URL(details.documentUrl).hostname : docDomain;
      if (urlDomain === srcDomain) return false;
    } catch { return true; }
  }
  if (opts.from) {
    const domains = String(opts.from).split('|');
    let matched = false;
    for (const domain of domains) {
      if (domain.startsWith('~')) {
        if (matchDomain(docDomain, domain.substring(1))) return false;
      } else if (matchDomain(docDomain, domain)) {
        matched = true;
      }
    }
    if (!matched) return false;
  }
  if (opts.domain) {
    const domains = opts.domain.split('|');
    let matched = false;
    for (const d of domains) {
      if (d.startsWith('~')) { if (matchDomain(docDomain, d.substring(1))) return false; }
      else { if (matchDomain(docDomain, d)) matched = true; }
    }
    if (!matched) return false;
  }
  return true;
}

class Engine {
  constructor() {
    this.rules = [];
    this.domainIndex = new Map();
    this.urlRules = [];
    this.regexRules = [];
    this.cosmeticRules = [];
    this.ruleCount = 0;
    this._cache = new Map();
    this._cacheMax = 5000;
  }

  _indexDomainRule(rule) {
    const key = rule.domain.toLowerCase();
    let arr = this.domainIndex.get(key);
    if (!arr) { arr = []; this.domainIndex.set(key, arr); }
    arr.push(rule);
  }

  _indexUrlRule(rule) {
    this.urlRules.push(rule);
  }

  load(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      const rule = parseRule(line);
      if (!rule) continue;
      this.rules.push(rule);
      this.ruleCount++;
      switch (rule.type) {
        case T_DOMAIN: this._indexDomainRule(rule); break;
        case T_URL: this._indexUrlRule(rule); break;
        case T_REGEX: this.regexRules.push(rule); break;
        case T_COSMETIC: this.cosmeticRules.push(rule); break;
      }
    }
  }

  loadLines(lines) {
    for (const line of lines) {
      const rule = parseRule(line);
      if (!rule) continue;
      this.rules.push(rule);
      this.ruleCount++;
      switch (rule.type) {
        case T_DOMAIN: this._indexDomainRule(rule); break;
        case T_URL: this._indexUrlRule(rule); break;
        case T_REGEX: this.regexRules.push(rule); break;
        case T_COSMETIC: this.cosmeticRules.push(rule); break;
      }
    }
  }

  match(details) {
    if (!details || !details.url) return { match: false };
    const cacheKey = details.url + '|' + (details.type || '') + '|' + (details.documentUrl || '');
    const cached = this._cache.get(cacheKey);
    if (cached !== undefined) {
      if (cached === null) return { match: false };
      return { match: true, rule: cached };
    }
    let url, hostname, pathname;
    try {
      url = new URL(details.url);
      hostname = url.hostname.toLowerCase();
      pathname = url.pathname + url.search;
    } catch { return { match: false }; }
    const docDomain = details.documentUrl ? (() => { try { return new URL(details.documentUrl).hostname.toLowerCase(); } catch { return ''; } })() : '';
    let matchedBlock = null;

    // 1. Check domain rules via index (O(1) per unique domain)
    const labels = hostname.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const sub = labels.slice(i).join('.');
      const arr = this.domainIndex.get(sub);
      if (!arr) continue;
      for (const rule of arr) {
        if (!pathMatch(pathname, rule.path)) continue;
        if (!checkOpts(rule.opts, details, docDomain)) continue;
        if (rule.exception) { this._cacheResult(cacheKey, null); return { match: false, exception: rule }; }
        if (!matchedBlock) matchedBlock = rule;
      }
    }

    // 2. Check URL rules (pre-compiled regex)
    for (const rule of this.urlRules) {
      if (!rule.regex || !rule.regex.test(details.url)) continue;
      if (!checkOpts(rule.opts, details, docDomain)) continue;
      if (rule.exception) { this._cacheResult(cacheKey, null); return { match: false, exception: rule }; }
      if (!matchedBlock) matchedBlock = rule;
    }

    // 3. Check regex rules
    for (const rule of this.regexRules) {
      if (!rule.regex.test(details.url)) continue;
      if (!checkOpts(rule.opts, details, docDomain)) continue;
      if (rule.exception) { this._cacheResult(cacheKey, null); return { match: false, exception: rule }; }
      if (!matchedBlock) matchedBlock = rule;
    }

    if (matchedBlock) { this._cacheResult(cacheKey, matchedBlock); return { match: true, rule: matchedBlock }; }
    this._cacheResult(cacheKey, null);
    return { match: false };
  }

  _cacheResult(key, rule) {
    if (this._cache.size >= this._cacheMax) {
      const first = this._cache.keys().next().value;
      if (first !== undefined) this._cache.delete(first);
    }
    this._cache.set(key, rule);
  }

  clearCache() {
    this._cache.clear();
  }

  getCosmetics(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      const styles = [];
      for (const rule of this.cosmeticRules) {
        if (!rule.domain || matchDomain(hostname, rule.domain)) {
          if (!rule.exception) styles.push(rule.selector);
        }
      }
      return styles;
    } catch { return []; }
  }

  serialize() { return JSON.stringify({ rules: this.rules, ruleCount: this.ruleCount }); }

  static deserialize(json) {
    const data = JSON.parse(json);
    const engine = new Engine();
    const serializedRules = data.rules || [];
    for (const serializedRule of serializedRules) {
      const rule = parseRule(serializedRule.raw || '');
      if (!rule) continue;
      engine.rules.push(rule);
      engine.ruleCount++;
      switch (rule.type) {
        case T_DOMAIN: engine._indexDomainRule(rule); break;
        case T_URL: engine._indexUrlRule(rule); break;
        case T_REGEX: engine.regexRules.push(rule); break;
        case T_COSMETIC: engine.cosmeticRules.push(rule); break;
      }
    }
    return engine;
  }
}

module.exports = { Engine, parseRule, T_DOMAIN, T_URL, T_REGEX, T_COSMETIC };
