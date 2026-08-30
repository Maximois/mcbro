// Security & Scraping Rules Engine
// modules/ai-assistant/security-rules.js

'use strict';

const SecurityRulesEngine = {
  rules: new Map(),
  detections: [],

  // Reglas por defecto
  defaultRules: [
    {
      id: 'suspicious-subdomain',
      name: 'Subdominio Sospechoso',
      enabled: true,
      check: (domain) => {
        const suspicious = [
          /^(?!www\.).*\.(billing|payment|login|account|verify|confirm|update|security|alert|urgent|act|confirm|signin|logon|auth)/i,
          /^([\w-]*pay[\w-]*|[\w-]*bank[\w-]*|[\w-]*account[\w-]*)\.[\w-]*\.[\w-]*$/i, // Subdominio multilevel con palabras clave
          /^([\w-]*pay[\w-]*|[\w-]*bank[\w-]*)\.(?!yourdomain\.com)/i, // No es el dominio legítimo
        ];
        return suspicious.some(p => p.test(domain));
      },
      severity: 'high',
      message: 'Subdominio potencialmente fraudulento detectado'
    },

    {
      id: 'typosquatting',
      name: 'Typosquatting Domain',
      enabled: true,
      check: (domain) => {
        const knownDomains = ['google.com', 'facebook.com', 'amazon.com', 'github.com', 'stackoverflow.com'];
        const levenshtein = (a, b) => {
          const m = a.length, n = b.length;
          const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
          for (let i = 0; i <= m; i++) dp[i][0] = i;
          for (let j = 0; j <= n; j++) dp[0][j] = j;
          for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
              dp[i][j] = Math.min(
                dp[i-1][j] + 1,
                dp[i][j-1] + 1,
                dp[i-1][j-1] + (a[i-1] !== b[j-1] ? 1 : 0)
              );
            }
          }
          return dp[m][n];
        };
        const baseDomain = domain.split('.').slice(-2).join('.');
        return knownDomains.some(known => {
          const distance = levenshtein(baseDomain, known);
          return distance > 0 && distance <= 2; // 1-2 caracteres de diferencia
        });
      },
      severity: 'critical',
      message: 'Posible typosquatting (dominio similar a sitio conocido)'
    },

    {
      id: 'iframe-injection',
      name: 'Inyección de iframe',
      enabled: true,
      check: (html) => {
        const iframes = (html || '').match(/<iframe[^>]*src=["']([^"']+)["'][^>]*>/gi) || [];
        return iframes.filter(iframe => {
          const src = iframe.match(/src=["']([^"']+)["']/)?.[1] || '';
          // Detectar iframes de origen diferente
          return src && !src.startsWith('about:') && !src.startsWith('blob:') && src.includes('http');
        }).length > 0;
      },
      severity: 'medium',
      message: 'Iframes de origen externo detectados'
    },

    {
      id: 'form-spoofing',
      name: 'Form Spoofing',
      enabled: true,
      check: (html) => {
        const forms = (html || '').match(/<form[^>]*>/gi) || [];
        return forms.some(form => {
          const action = form.match(/action=["']([^"']+)["']/)?.[1] || '';
          // Formulario que envía a dominio diferente
          return action && action.startsWith('http') && !action.includes(window.location.hostname);
        });
      },
      severity: 'high',
      message: 'Formulario que envía a dominio diferente detectado'
    },

    {
      id: 'mixed-content',
      name: 'Contenido Mixto HTTP/HTTPS',
      enabled: true,
      check: (html, protocol) => {
        if (protocol !== 'https:') return false;
        const mixedContent = /(src|href)=["']http:\/\/(?!localhost)/gi.test(html || '');
        return mixedContent;
      },
      severity: 'medium',
      message: 'Página HTTPS cargando contenido HTTP (no seguro)'
    },

    {
      id: 'tracking-pixels',
      name: 'Tracking Pixels',
      enabled: true,
      check: (html) => {
        const tracking = /<(img|pixel)[^>]*src=["']([^"']+tracking|beacon|pixel)[^"']*["'][^>]*>/gi;
        return tracking.test(html || '');
      },
      severity: 'low',
      message: 'Pixels de rastreo detectados'
    }
  ],

  init() {
    this.defaultRules.forEach(rule => {
      this.rules.set(rule.id, rule);
    });
  },

  async analyzeUrl(url) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      const protocol = urlObj.protocol;

      const findings = [];

      for (const [id, rule] of this.rules) {
        if (!rule.enabled) continue;
        try {
          const triggered = rule.check(domain, protocol);
          if (triggered) {
            findings.push({
              ruleId: id,
              name: rule.name,
              severity: rule.severity,
              message: rule.message,
              domain: domain,
              timestamp: Date.now()
            });
          }
        } catch (err) {
          console.error(`Error en regla ${id}:`, err);
        }
      }

      return findings;
    } catch (err) {
      return { error: err.message };
    }
  },

  async analyzeHtml(html, url) {
    try {
      const urlObj = new URL(url);
      const findings = [];

      for (const [id, rule] of this.rules) {
        if (!rule.enabled || !rule.check.length || rule.check.length === 1) continue;
        try {
          const triggered = rule.check(html, urlObj.protocol);
          if (triggered) {
            findings.push({
              ruleId: id,
              name: rule.name,
              severity: rule.severity,
              message: rule.message,
              detectedAt: 'html_scan',
              timestamp: Date.now()
            });
          }
        } catch (err) {
          console.error(`Error en regla ${id}:`, err);
        }
      }

      return findings;
    } catch (err) {
      return { error: err.message };
    }
  },

  addRule(rule) {
    if (!rule.id || !rule.check) throw new Error('Rule debe tener id y check');
    this.rules.set(rule.id, rule);
    return { ok: true, ruleId: rule.id };
  },

  removeRule(ruleId) {
    return { ok: this.rules.delete(ruleId) };
  },

  getRules() {
    return Array.from(this.rules.values()).map(r => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      severity: r.severity
    }));
  },

  toggleRule(ruleId, enabled) {
    const rule = this.rules.get(ruleId);
    if (!rule) return { error: 'Rule not found' };
    rule.enabled = enabled;
    return { ok: true };
  }
};

SecurityRulesEngine.init();
module.exports = SecurityRulesEngine;
