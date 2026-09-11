'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  getPermissionRuleForHost,
  isSitePermissionAllowed,
  resolvePermissionDecision,
  resolveMediaPermissionDecision,
  getAllowlistPolicyForHost,
  resolveCookieAction,
  parseGlobalBlockRule,
  isGlobalBlockMatch,
  normalizeSiteHost
} = require('../lib/permissions');

// ── normalizeSiteHost ──────────────────────────────────────────────────
describe('normalizeSiteHost', () => {
  test('extrae el host de una URL normal', () => {
    assert.equal(normalizeSiteHost('https://www.Example.com/path'), 'www.example.com');
  });
  test('devuelve vacío para about:blank o URLs inválidas', () => {
    assert.equal(normalizeSiteHost('about:blank'), '');
    assert.equal(normalizeSiteHost('no-es-una-url'), '');
    assert.equal(normalizeSiteHost(''), '');
  });
});

// ── getPermissionRuleForHost / herencia por subdominio ───────────────────
describe('getPermissionRuleForHost', () => {
  test('aplica la regla del dominio exacto', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('example.com', 'camera', cfg), 'allow');
  });
  test('hereda la regla a subdominios', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('chat.example.com', 'camera', cfg), 'allow');
  });
  test('no aplica la regla de un dominio no relacionado', () => {
    const cfg = { permissions: { 'example.com': { camera: 'allow' } } };
    assert.equal(getPermissionRuleForHost('otherexample.com', 'camera', cfg), null);
  });
  test('sin reglas configuradas devuelve null', () => {
    assert.equal(getPermissionRuleForHost('example.com', 'camera', { permissions: {} }), null);
  });
});

// ── resolvePermissionDecision: deny-by-default ────────────────────────────
describe('resolvePermissionDecision', () => {
  test('permiso explícito "allow" se otorga', () => {
    const cfg = { permissions: { 'example.com': { notifications: 'allow' } } };
    assert.equal(resolvePermissionDecision('example.com', 'notifications', cfg), true);
  });
  test('sin regla, tipos sensibles conocidos se deniegan por defecto', () => {
    const cfg = { permissions: {} };
    for (const key of ['notifications', 'geolocation', 'camera', 'microphone']) {
      assert.equal(resolvePermissionDecision('example.com', key, cfg), false, key);
    }
  });
});

// ── resolveMediaPermissionDecision: el bug de cámara/micrófono ───────────
// Electron entrega getUserMedia como un único tipo 'media', nunca como
// 'camera' ni 'microphone'. Si esta traducción se rompe (p.ej. alguien
// vuelve a comparar 'media' directo contra las claves camera/microphone),
// estos tests fallan.
describe('resolveMediaPermissionDecision (regresión: permiso fantasma de cámara/mic)', () => {
  test('cámara permitida explícitamente habilita un pedido solo-video', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video'], cfg), true);
  });
  test('cámara permitida NO habilita un pedido de solo-audio', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['audio'], cfg), false);
  });
  test('pedido combinado video+audio exige que AMBOS estén permitidos', () => {
    const cfg = { permissions: { 'meet.example.com': { camera: 'allow' } } };
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video', 'audio'], cfg), false);
    cfg.permissions['meet.example.com'].microphone = 'allow';
    assert.equal(resolveMediaPermissionDecision('meet.example.com', ['video', 'audio'], cfg), true);
  });
  test('sin ninguna regla, todo pedido de media se deniega', () => {
    assert.equal(resolveMediaPermissionDecision('example.com', ['video'], { permissions: {} }), false);
  });
});

// ── getAllowlistPolicyForHost / resolveCookieAction: el bug de "block" ────
describe('resolveCookieAction (regresión: cookies "block" que no bloqueaban)', () => {
  test('política "block" en dominio de 1ra parte bloquea la cookie', () => {
    const cfg = { allowlist: { 'tracker.example.com': 'block' } };
    const action = resolveCookieAction({ host: 'tracker.example.com', thirdParty: false, cfg });
    assert.equal(action, 'block');
  });
  test('sin regla y sin ser 3ra parte, la cookie pasa', () => {
    const cfg = { allowlist: {} };
    const action = resolveCookieAction({ host: 'example.com', thirdParty: false, cfg });
    assert.equal(action, 'allow');
  });
  test('3ra parte con aislamiento estricto siempre bloquea', () => {
    const cfg = { allowlist: {} };
    const action = resolveCookieAction({ host: 'ads.example.net', thirdParty: true, cfg });
    assert.equal(action, 'block');
  });
  test('política "session" degrada la cookie en vez de bloquearla', () => {
    const cfg = { allowlist: { 'example.com': 'session' } };
    const action = resolveCookieAction({ host: 'example.com', thirdParty: false, cfg });
    assert.equal(action, 'session');
  });
  test('cookiePolicy global "session" aplica salvo excepción "allow" explícita', () => {
    const cfgSinExcepcion = { allowlist: {}, cookiePolicy: 'session' };
    assert.equal(resolveCookieAction({ host: 'example.com', thirdParty: false, cfg: cfgSinExcepcion }), 'session');

    const cfgConExcepcion = { allowlist: { 'example.com': 'allow' }, cookiePolicy: 'session' };
    assert.equal(resolveCookieAction({ host: 'example.com', thirdParty: false, cfg: cfgConExcepcion }), 'allow');
  });
  test('regla "block" pesa incluso si cookiePolicy global es "allow-all"', () => {
    const cfg = { allowlist: { 'tracker.example.com': 'block' }, cookiePolicy: 'allow-all' };
    assert.equal(resolveCookieAction({ host: 'tracker.example.com', thirdParty: false, cfg }), 'block');
  });
});

describe('isSitePermissionAllowed', () => {
  test('true solo cuando la regla "site" es exactamente "allow"', () => {
    assert.equal(isSitePermissionAllowed('example.com', { permissions: { 'example.com': { site: 'allow' } } }), true);
    assert.equal(isSitePermissionAllowed('example.com', { permissions: { 'example.com': { site: 'deny' } } }), false);
    assert.equal(isSitePermissionAllowed('example.com', { permissions: {} }), false);
  });
});

// ── reglas globales de bloqueo (adblock/tracker) ──────────────────────────
describe('parseGlobalBlockRule / isGlobalBlockMatch', () => {
  test('"*.dominio" genera una regla de subdominio', () => {
    const rule = parseGlobalBlockRule('*.ads.example.com');
    assert.deepEqual(rule, { host: 'ads.example.com', subdomainOnly: true });
    assert.equal(isGlobalBlockMatch('x.ads.example.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('ads.example.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('example.com', '', rule), false);
  });
  test('dominio simple también matchea sus subdominios', () => {
    const rule = parseGlobalBlockRule('tracker.com');
    assert.equal(isGlobalBlockMatch('sub.tracker.com', '', rule), true);
    assert.equal(isGlobalBlockMatch('nottracker.com', '', rule), false);
  });
  test('valor vacío no genera regla', () => {
    assert.equal(parseGlobalBlockRule(''), null);
    assert.equal(parseGlobalBlockRule('   '), null);
  });
});
