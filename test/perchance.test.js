'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shouldAutoClearPerchanceStorage } = require('../lib/perchance');
const { shouldBypassAdblockForSession, isPerchanceCompatibilityRequest } = require('../modules/adblocker/main');
const { isAllowedUrl } = require('../perchance/perchance-panel');

describe('Perchance storage policy', () => {
  test('no borra el almacenamiento persistente del panel por defecto', () => {
    assert.equal(shouldAutoClearPerchanceStorage(), false);
  });

  test('solo permite limpiar al arrancar cuando se fuerza explícitamente', () => {
    assert.equal(shouldAutoClearPerchanceStorage({ force: true }), true);
    assert.equal(shouldAutoClearPerchanceStorage({ force: false }), false);
  });

  test('desactiva adblock en la partición de Perchance', () => {
    assert.equal(shouldBypassAdblockForSession({ partition: 'persist:perchance-clean' }), true);
    assert.equal(shouldBypassAdblockForSession({ partition: 'persist:perchance' }), true);
    assert.equal(shouldBypassAdblockForSession({ partition: 'persist:mc' }), false);
  });

  test('el panel de Perchance no tiene allowlist ni excepción especial de compatibilidad', () => {
    assert.equal(isPerchanceCompatibilityRequest('bigger.pics', 'perchance.org'), false);
    assert.equal(isPerchanceCompatibilityRequest('challenges.cloudflare.com', 'perchance.org'), false);
    assert.equal(isAllowedUrl('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/308fa5a79cfee5d9a0d4a1f5f4bba8d8?ray=123'), true);
    assert.equal(isAllowedUrl('https://turnstile.cloudflare.com/0x4AAAAAAA/something'), true);
    assert.equal(isAllowedUrl('https://example.com/blocked'), true);
  });
});
