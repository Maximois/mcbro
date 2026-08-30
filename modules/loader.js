'use strict';
const fs = require('fs');
const path = require('path');

const modulesDir = __dirname;
const cfg = global.__MC_CFG || {};
const save = global.__MC_SAVE || (() => {});
const emit = global.__MC_EMIT || (() => {});

fs.readdirSync(modulesDir).forEach(dir => {
  if (dir === 'loader.js') return;
  const mainPath = path.join(modulesDir, dir, 'main.js');
  if (fs.existsSync(mainPath)) {
    try {
      const mod = require(mainPath);
      if (typeof mod.setup === 'function') mod.setup({ cfg, saveCfg: save, emit });
    } catch (e) {
      console.error(`[Modules] Error loading ${dir}:`, e.message);
    }
  }
});
