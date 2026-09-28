'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  fingerprintHlsPlaylist,
  loadHlsResumeState,
  saveHlsResumeState
} = require('../lib/hls-resume');

describe('HLS VOD resume checkpoints', () => {
  test('reuses a checkpoint only for the same playlist and intact partial file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-hls-resume-'));
    try {
      const statePath = path.join(dir, 'video.resume.json');
      const partialPath = path.join(dir, 'video.part.ts');
      const fingerprint = fingerprintHlsPlaylist('https://cdn.test/master.m3u8', '#EXTM3U\n#EXT-X-ENDLIST');
      fs.writeFileSync(partialPath, Buffer.alloc(32));
      const checkpoint = { fingerprint, completedSegments: 4, bytes: 24, initIncluded: true };
      saveHlsResumeState(statePath, checkpoint);

      assert.deepEqual(loadHlsResumeState(statePath, partialPath, fingerprint, 10), checkpoint);
      assert.equal(loadHlsResumeState(statePath, partialPath, 'different-playlist', 10), null);
      assert.equal(loadHlsResumeState(statePath, partialPath, fingerprint, 3), null);
      fs.truncateSync(partialPath, 12);
      assert.equal(loadHlsResumeState(statePath, partialPath, fingerprint, 10), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('playlist fingerprint changes when its URL or contents change', () => {
    const url = 'https://cdn.test/video.m3u8';
    const manifest = '#EXTM3U\n#EXT-X-ENDLIST';
    const fingerprint = fingerprintHlsPlaylist(url, manifest);
    assert.equal(fingerprintHlsPlaylist(url, manifest), fingerprint);
    assert.notEqual(fingerprintHlsPlaylist(url + '?token=new', manifest), fingerprint);
    assert.notEqual(fingerprintHlsPlaylist(url, manifest + '\n# changed'), fingerprint);
  });
});