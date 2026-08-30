'use strict';

const path = require('path');
const fs = require('fs');
const { Engine } = require('./engine');

// ── Filter list sources (uBlock Origin compatible) ─────────
const FILTER_LISTS = [
  {
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    enabled: true
  },
  {
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    enabled: true
  },
  {
    name: 'uBlock Unbreak',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
    enabled: true
  },
  {
    name: 'uBlock Filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    enabled: true
  },
  {
    name: 'Peter Lowe\'s List',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext',
    enabled: false
  },
  {
    name: 'uBO Annoyances',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
    enabled: true
  },
  {
    name: 'Fanboy Annoyance',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    enabled: false
  }
];

// ── List Manager ────────────────────────────────────────────
class ListManager {
  constructor(cacheDir) {
    this.cacheDir = cacheDir || path.join(require('electron').app.getPath('userData'), 'adblock-cache');
    this.engine = new Engine();
    this.loadedLists = [];
    this._updating = false;
  }

  get cachePath() { return this.cacheDir; }

  // Ensure cache directory exists
  _ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  // Get cached file path for a list
  _cacheFile(name) {
    return path.join(this.cacheDir, name.replace(/[^a-zA-Z0-9]/g, '_') + '.txt');
  }

  // Get serialized engine path
  _engineFile() {
    return path.join(this.cacheDir, 'engine.json');
  }

  // Download a filter list with timeout
  async _download(url, timeout = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // Download and cache a single list
  async updateList(listDef) {
    this._ensureDir();
    try {
      const text = await this._download(listDef.url);
      const cacheFile = this._cacheFile(listDef.name);
      fs.writeFileSync(cacheFile, text, 'utf8');
      return { name: listDef.name, ok: true, size: text.length, rules: text.split('\n').filter(l => l.trim() && !l.startsWith('!') && !l.startsWith('[')).length };
    } catch (e) {
      return { name: listDef.name, ok: false, error: e.message };
    }
  }

  // Load a cached list into engine
  _loadCached(name, text) {
    this.engine.load(text);
    this.loadedLists.push(name);
  }

  // Load all cached lists into engine
  loadCached() {
    this._ensureDir();
    this.engine = new Engine();
    this.loadedLists = [];

    // Try loading serialized engine first
    const ef = this._engineFile();
    if (fs.existsSync(ef)) {
      try {
        this.engine = Engine.deserialize(fs.readFileSync(ef, 'utf8'));
        this.loadedLists = ['cached'];
        return { source: 'serialized', ruleCount: this.engine.ruleCount };
      } catch {}
    }

    // Fall back to loading individual cache files
    let totalRules = 0;
    for (const list of FILTER_LISTS) {
      if (!list.enabled) continue;
      const cf = this._cacheFile(list.name);
      if (fs.existsSync(cf)) {
        try {
          const text = fs.readFileSync(cf, 'utf8');
          this._loadCached(list.name, text);
          totalRules += text.split('\n').filter(l => l.trim() && !l.startsWith('!') && !l.startsWith('[')).length;
        } catch {}
      }
    }
    return { source: this.loadedLists.length > 0 ? 'cached' : 'none', ruleCount: this.engine.ruleCount };
  }

  // Update all enabled lists
  async updateAll(onProgress) {
    this._updating = true;
    const results = [];
    let totalDownloaded = 0;

    for (const list of FILTER_LISTS) {
      if (!list.enabled) continue;
      const result = await this.updateList(list);
      results.push(result);
      if (result.ok) totalDownloaded += result.size;
      if (onProgress) onProgress(result);
    }

    // Reload engine from cache
    this.loadCached();

    // Save serialized engine for fast startup
    try {
      this._ensureDir();
      fs.writeFileSync(this._engineFile(), this.engine.serialize(), 'utf8');
    } catch {}

    this._updating = false;
    return { results, totalDownloaded, ruleCount: this.engine.ruleCount };
  }

  // Get info about current state
  getInfo() {
    return {
      loadedLists: this.loadedLists,
      ruleCount: this.engine.ruleCount,
      domainRules: this.engine.domainIndex.size,
      urlRules: this.engine.urlRules.length,
      regexRules: this.engine.regexRules.length,
      cosmeticRules: this.engine.cosmeticRules.length,
      updating: this._updating,
      cacheDir: this.cacheDir
    };
  }
}

module.exports = { ListManager, FILTER_LISTS };
