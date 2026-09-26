'use strict';

// Lógica pura de permisos por sitio y política de cookies, extraída de
// main.js. No importa 'electron' a propósito: así se puede testear con
// `node --test` sin levantar el runtime completo de la app.
//
// El estado de configuración (CFG) se recibe siempre como parámetro
// explícito (nunca como variable de closure) para que cada función sea
// determinística y fácil de probar con fixtures.

function normalizeSiteHost(url) {
  try {
    const value = String(url || '').trim();
    if (!value || value === 'about:blank') return '';
    return new URL(value).hostname.replace(/^\.+/, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeGlobalBlockPattern(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    const host = new URL(withScheme).hostname.replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host || '';
  } catch {
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host || '';
  }
}

function parseGlobalBlockRule(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('*.')) {
    const host = raw.slice(2).replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
    return host ? { host, subdomainOnly: true } : null;
  }
  const host = normalizeGlobalBlockPattern(raw);
  return host ? { host, subdomainOnly: false } : null;
}

function isGlobalBlockMatch(requestHost, documentHost, rule) {
  if (!rule?.host) return false;
  const { host, subdomainOnly } = rule;
  if (subdomainOnly) {
    return requestHost === host || documentHost === host || requestHost.endsWith('.' + host) || documentHost.endsWith('.' + host);
  }
  if (requestHost === host || documentHost === host) return true;
  return requestHost.endsWith('.' + host) || documentHost.endsWith('.' + host);
}

function normalizePermissionMap(value) {
  if (Array.isArray(value)) {
    const map = {};
    for (const item of value) map[item] = 'allow';
    return map;
  }
  if (value && typeof value === 'object') return value;
  return {};
}

function getPermissionRuleForHost(host, permission, cfg) {
  const normalizedHost = String(host || '').trim().replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase();
  if (!normalizedHost || !cfg?.permissions) return null;

  // La UI guarda dominios sin "www"; aplicar la misma regla a sus subdominios.
  const candidates = Object.keys(cfg.permissions)
    .map(rawKey => ({ rawKey, key: String(rawKey).replace(/^\.+/, '').replace(/^www\./i, '').toLowerCase() }))
    .filter(({ key }) => normalizedHost === key || normalizedHost.endsWith('.' + key))
    .sort((a, b) => b.key.length - a.key.length);
  for (const { rawKey } of candidates) {
    const rule = normalizePermissionMap(cfg.permissions[rawKey]);
    if (rule[permission]) return rule[permission];
  }
  return null;
}

const SENSITIVE_AI_KEYS = ['opencodeKey', 'groqKey', 'openaiKey', 'geminiKey'];

function sanitizeAiConfigForPublic(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const sanitized = { ...cfg };
  for (const key of SENSITIVE_AI_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) {
      sanitized[key] = sanitized[key] ? '***' : '';
    }
  }
  return sanitized;
}

function isSitePermissionAllowed(host, cfg) {
  return getPermissionRuleForHost(host, 'site', cfg) === 'allow';
}

function resolvePermissionDecision(host, permissionKey, cfg) {
  const rule = getPermissionRuleForHost(host, permissionKey, cfg);
  if (rule === 'allow') return true;
  if (rule === 'deny' || rule === 'block') return false;
  // Permisos benignos que se otorgan por defecto (como en Chrome):
  //  - clipboard-*: el panel de IA web necesita leer/escribir el portapapeles.
  //  - fullscreen: el botón nativo de pantalla completa HTML5 de los sitios
  //    (YouTube, Facebook, perchance.org, etc.) depende de que este permiso
  //    se conceda; si se deniega, `enter-html-full-screen` nunca se emite y
  //    la ventana jamás entra en fullscreen.
  if (['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write', 'fullscreen'].includes(permissionKey)) return true;
  if (['notifications', 'geolocation', 'camera', 'microphone', 'images', 'audio', 'media'].includes(permissionKey)) return false;
  return false;
}

// Electron entrega los pedidos de camara/microfono bajo un unico tipo
// 'media' (no 'camera' / 'microphone'); para distinguirlos hay que mirar
// details.mediaTypes ('video' | 'audio'). Esta funcion traduce ese pedido
// a las claves granulares que sí guarda la UI (camera / microphone).
function resolveMediaPermissionDecision(host, mediaTypes, cfg) {
  const types = Array.isArray(mediaTypes) && mediaTypes.length ? mediaTypes : ['video', 'audio'];
  return types.every(type => {
    const key = type === 'audio' ? 'microphone' : type === 'video' ? 'camera' : 'media';
    return resolvePermissionDecision(host, key, cfg);
  });
}

function getAllowlistPolicyForHost(host, cfg) {
  const normalized = String(host || '').replace(/^\.+/, '').toLowerCase();
  if (!normalized) return null;
  const list = cfg?.allowlist || {};
  if (list[normalized]) return list[normalized];
  if (list['.' + normalized]) return list['.' + normalized];
  for (const [key, policy] of Object.entries(list)) {
    const k = String(key).replace(/^\.+/, '').toLowerCase();
    if (!k) continue;
    if (normalized === k || normalized.endsWith('.' + k)) return policy;
    if (k.endsWith('.' + normalized)) return policy;
  }
  return null;
}

// Réplica pura de la decisión que toma onHeadersReceived en main.js sobre
// si una cookie de 1ra/3ra parte debe bloquearse o degradarse a sesión.
// No toca headers reales; sirve para testear la política sin un servidor.
function resolveCookieAction({ host, thirdParty, cfg }) {
  const allowPolicy = getAllowlistPolicyForHost(host, cfg);
  const blocked = thirdParty || allowPolicy === 'block';
  if (blocked) return 'block';
  if (allowPolicy === 'session') return 'session';
  if (allowPolicy === 'allow') return 'allow';
  if (allowPolicy === undefined || allowPolicy === null) return 'block';
  return 'block';
}

function isWebContentsFrameAlive(wc) {
  try {
    if (!wc || typeof wc.isDestroyed !== 'function' || wc.isDestroyed()) return false;
    if (!wc.mainFrame || typeof wc.mainFrame.isDestroyed !== 'function') return false;
    return !wc.mainFrame.isDestroyed();
  } catch {
    return false;
  }
}

module.exports = {
  normalizeSiteHost,
  normalizeGlobalBlockPattern,
  parseGlobalBlockRule,
  isGlobalBlockMatch,
  normalizePermissionMap,
  getPermissionRuleForHost,
  isSitePermissionAllowed,
  resolvePermissionDecision,
  resolveMediaPermissionDecision,
  getAllowlistPolicyForHost,
  resolveCookieAction,
  isWebContentsFrameAlive,
  sanitizeAiConfigForPublic,
  SENSITIVE_AI_KEYS
};
