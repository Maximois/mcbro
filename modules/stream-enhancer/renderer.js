'use strict';
/* MC Browser — Stream/Media Enhancer Module */
/* Botón IA en items de media y streams */

const StreamEnhancer = {
  init() {
    this.patchMediaItems();
    this.patchStreamItems();
    this.enhanceScanScript();
  },

  patchMediaItems() {
    const origAdd = window.addMediaItem;
    if (!origAdd) return;
    window.addMediaItem = function(entry) {
      origAdd(entry);
      setTimeout(() => StreamEnhancer.addAiButtonToMedia(entry.url), 50);
    };
  },

  patchStreamItems() {
    const origRender = window.renderStreams;
    if (!origRender) return;
    window.renderStreams = function() {
      origRender();
      setTimeout(() => StreamEnhancer.addAiButtonsToStreams(), 50);
    };
    const origAdd = window.addStreamItem;
    if (origAdd) {
      window.addStreamItem = function(item) {
        origAdd(item);
        setTimeout(() => StreamEnhancer.addAiButtonsToStreams(), 50);
      };
    }
  },

  addAiButtonToMedia(url) {
    const items = document.querySelectorAll('.media-item');
    items.forEach(el => {
      const dlBtn = el.querySelector('.btn.warn');
      if (!dlBtn || el.querySelector('.btn.ai-btn')) return;
      const aiBtn = document.createElement('button');
      aiBtn.className = 'btn ghost btn-sm ai-btn';
      aiBtn.textContent = '✦ IA';
      aiBtn.title = 'Preguntar a IA cómo descargar';
      aiBtn.onclick = () => {
        const mediaType = el.querySelector('.media-type-lbl')?.textContent || 'Media';
        AI.askMedia(url, mediaType);
      };
      dlBtn.parentNode.insertBefore(aiBtn, dlBtn.nextSibling);
    });
  },

  addAiButtonsToStreams() {
    const items = document.querySelectorAll('#streams-list .media-item');
    items.forEach(el => {
      const dlBtn = el.querySelector('.btn.warn');
      if (!dlBtn || el.querySelector('.ai-btn')) return;
      const aiBtn = document.createElement('button');
      aiBtn.className = 'btn ghost btn-sm ai-btn';
      aiBtn.textContent = '✦ IA';
      aiBtn.title = 'Analizar con IA';
      aiBtn.onclick = () => {
        const urlEl = el.querySelector('.media-url-lbl');
        const url = urlEl?.title || urlEl?.textContent || '';
        const typeEl = el.querySelector('.media-type-lbl');
        const type = typeEl?.textContent || 'Stream';
        if (typeof AI !== 'undefined' && AI.askMedia) {
          AI.askMedia(url, type);
        } else {
          addSidebarLog('blocked', '[AI] Módulo IA no cargado');
        }
      };
      dlBtn.parentNode.insertBefore(aiBtn, dlBtn.nextSibling);
    });
  },

  enhanceScanScript() {
    const origScan = window.scanStreams;
    if (!origScan) return;
    window.scanStreams = async function() {
      const result = await origScan();
      setTimeout(() => StreamEnhancer.addAiButtonsToStreams(), 100);
      return result;
    };
  }
};

document.addEventListener('DOMContentLoaded', () => StreamEnhancer.init());
