'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mcSelectionBridge', {
  send: (text) => {
    const value = String(text || '').trim();
    if (value.length >= 5 && value.length <= 500) {
      ipcRenderer.sendToHost('mc-selection', value);
    }
  }
});
