'use strict';

const crypto = require('crypto');
const fs = require('fs');

function fingerprintHlsPlaylist(playlistUrl, manifestText) {
  return crypto.createHash('sha256').update(playlistUrl + '\n' + manifestText).digest('hex');
}

function loadHlsResumeState(statePath, partialPath, fingerprint, segmentCount) {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const partialSize = fs.statSync(partialPath).size;
    if (saved.fingerprint !== fingerprint
      || !Number.isInteger(saved.completedSegments)
      || saved.completedSegments < 0 || saved.completedSegments > segmentCount
      || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0
      || partialSize < saved.bytes) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveHlsResumeState(statePath, state) {
  const tempPath = statePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(state));
  try { fs.unlinkSync(statePath); } catch {}
  fs.renameSync(tempPath, statePath);
}

module.exports = { fingerprintHlsPlaylist, loadHlsResumeState, saveHlsResumeState };