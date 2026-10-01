'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function handleHistoryMouseEvent(event) {
  if (!event.isTrusted || (event.button !== 3 && event.button !== 4)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === 'mousedown') {
    ipcRenderer.sendToHost('mc-history-nav', event.button === 3 ? 'back' : 'forward');
  }
}

for (const eventType of ['mousedown', 'mouseup', 'auxclick', 'click']) {
  window.addEventListener(eventType, handleHistoryMouseEvent, true);
}

contextBridge.exposeInMainWorld('__mcSelectionBridge', {
  send: (text) => {
    const value = String(text || '').trim();
    if (value.length >= 5 && value.length <= 500) {
      ipcRenderer.sendToHost('mc-selection', value);
    }
  },
  setHlsReferer: (token, referer) => ipcRenderer.invoke('streams:hls-player-referer', { token, referer }),
  setHlsEntryReferer: (token, url, referer) => ipcRenderer.invoke('streams:entry-referer', { token, url, referer })
});
