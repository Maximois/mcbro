'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { shouldAutoClearPerchanceStorage } = require('../lib/perchance');

describe('Perchance storage policy', () => {
  test('no borra el almacenamiento persistente del panel por defecto', () => {
    assert.equal(shouldAutoClearPerchanceStorage(), false);
  });

  test('solo permite limpiar al arrancar cuando se fuerza explícitamente', () => {
    assert.equal(shouldAutoClearPerchanceStorage({ force: true }), true);
    assert.equal(shouldAutoClearPerchanceStorage({ force: false }), false);
  });
});
