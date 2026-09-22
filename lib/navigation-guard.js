'use strict';

const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.kr', 'com.br', 'com.cn', 'com.mx', 'co.in'
]);

const COMMON_HOST_PREFIXES = new Set(['www', 'm', 'mobile', 'vww', 'vpn', 'cdn', 'assets', 'static']);

function normalizeHostname(host) {
  return String(host || '').toLowerCase().replace(/^\.+/, '').replace(/\.$/, '').trim();
}

function baseNavigationDomain(host) {
  const normalized = normalizeHostname(host);
  if (!normalized) return '';
  const labels = normalized.split('.').filter(Boolean);
  if (!labels.length) return '';
  if (labels.length <= 2) return labels.join('.');

  const suffix = labels.slice(-2).join('.');
  const trimmed = labels.slice(-(MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? 3 : 2));
  return trimmed.join('.');
}

function siteRootIdentity(host) {
  const normalized = normalizeHostname(host);
  if (!normalized) return '';

  let labels = normalized.split('.').filter(Boolean);
  if (!labels.length) return '';

  while (labels.length > 1 && COMMON_HOST_PREFIXES.has(labels[0])) {
    labels = labels.slice(1);
  }

  if (labels.length >= 2) {
    const lastTwo = labels.slice(-2).join('.');
    if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
      labels = labels.slice(0, -2);
    } else {
      labels = labels.slice(0, -1);
    }
  }

  while (labels.length > 1 && COMMON_HOST_PREFIXES.has(labels[0])) {
    labels = labels.slice(1);
  }

  if (!labels.length) return normalized;
  const root = labels[labels.length - 1].replace(/\d+$/, '');
  return root || labels[0];
}

function isSameNavigationSite(sourceUrl, targetUrl) {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);
    if (!/^https?:$/.test(source.protocol) || !/^https?:$/.test(target.protocol)) return true;

    const sameBaseDomain = baseNavigationDomain(source.hostname) === baseNavigationDomain(target.hostname);
    if (sameBaseDomain) return true;

    const sourceRoot = siteRootIdentity(source.hostname);
    const targetRoot = siteRootIdentity(target.hostname);
    const sourceIsRoot = source.hostname === baseNavigationDomain(source.hostname);
    const targetIsRoot = target.hostname === baseNavigationDomain(target.hostname);
    if (sourceIsRoot && targetIsRoot && sourceRoot && targetRoot && sourceRoot === targetRoot) return true;

    return false;
  } catch {
    return true;
  }
}

function createExplicitNavTracker(keepMs = 2500) {
  const state = new Map();

  function mark(wcId) {
    const current = state.get(wcId);
    if (current?.timer) clearTimeout(current.timer);
    state.set(wcId, { timer: null });
    return true;
  }

  function keepAlive(wcId) {
    const current = state.get(wcId);
    if (!current) return false;
    if (current.timer) clearTimeout(current.timer);
    current.timer = setTimeout(() => state.delete(wcId), keepMs);
    return true;
  }

  function clear(wcId) {
    const current = state.get(wcId);
    if (current?.timer) clearTimeout(current.timer);
    state.delete(wcId);
  }

  function has(wcId) {
    return state.has(wcId);
  }

  return { state, mark, keepAlive, clear, has };
}

function allowNavigationTransition(sourceUrl, targetUrl, options = {}) {
  const explicitNavigation = !!options.explicitNavigation;
  const isAllowedRedirectHost = !!options.isAllowedRedirectHost;
  const sameSiteAllowed = options.sameSiteAllowed !== false;
  if (!sourceUrl && !targetUrl) return true;
  try {
    const targetHost = new URL(targetUrl).hostname;
    if (isAllowedRedirectHost || explicitNavigation) return true;
    if (sameSiteAllowed && isSameNavigationSite(sourceUrl, targetUrl)) return true;
    return false;
  } catch {
    return true;
  }
}

module.exports = {
  MULTI_LABEL_PUBLIC_SUFFIXES,
  normalizeHostname,
  baseNavigationDomain,
  siteRootIdentity,
  isSameNavigationSite,
  createExplicitNavTracker,
  allowNavigationTransition
};
