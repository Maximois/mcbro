// perchance-proxy.js
// Proxy local exclusivo para la partición de Perchance (127.0.0.1, puerto
// efímero). El resolver de Chromium es global (app.configureHostResolver /
// DoH estricto): si el DoH elegido no resuelve algún host del ecosistema
// Perchance (SERVFAIL, NXDOMAIN), la pestaña cae con ERR_NAME_NOT_RESOLVED
// sin fallback. Este proxy resuelve por resolver DNS del sistema (getaddrinfo
// de Node, fuera del DoH de Electron) y tunela CONNECT/HTTP/WebSocket, de
// modo que la red del panel no depende del DoH global.

'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const { URL } = require('node:url');

let instance = null; // singleton: { server, port }

function resolveAll(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, family: 0 }, (err, addrs) => {
      if (err) return reject(err);
      const list = (addrs || []).map(a => a.address).filter(Boolean);
      if (!list.length) return reject(new Error('sin direcciones para ' + host));
      // Preferimos IPv4 primero: este equipo no rutea IPv6, y probar cada IP
      // en orden nos da fallback si la primera no conecta (ENETUNREACH, etc.).
      const v4 = list.filter(a => net.isIPv4(a));
      const v6 = list.filter(a => !net.isIPv4(a));
      resolve([...v4, ...v6]);
    });
  });
}

// Abre conexión probando cada dirección(ip:port) hasta que una funcione.
function connectFirst(port, addrs, timeoutMs = 15000) {
  const list = Array.isArray(addrs) ? addrs : [addrs];
  return new Promise((resolve, reject) => {
    let idx = 0;
    const attempt = (lastErr) => {
      if (idx >= list.length) return reject(lastErr || new Error('sin direcciones disponibles'));
      const addr = list[idx++];
      const sock = net.connect({ host: addr, port, timeout: timeoutMs });
      sock.once('connect', () => {
        sock.removeAllListeners('timeout');
        resolve(sock);
      });
      sock.once('timeout', () => { try { sock.destroy(); } catch {} });
      sock.once('error', (err) => attempt(err));
    };
    attempt(null);
  });
}

// req.url viene como "host:puerto" en CONNECT.
function parseConnectTarget(raw, defaultPort) {
  let host = String(raw || '').trim();
  let port = defaultPort;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    const ipv6 = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest.startsWith(':')) port = Number(rest.slice(1)) || defaultPort;
    else if (rest) return null;
    host = ipv6;
  } else {
    const idx = host.lastIndexOf(':');
    if (idx >= 0) {
      const maybePort = Number(host.slice(idx + 1));
      if (Number.isFinite(maybePort) && maybePort > 0) {
        port = maybePort;
        host = host.slice(0, idx);
      }
    }
  }
  if (!host) return null;
  return { host, port };
}

function startLocalProxy() {
  if (instance) return Promise.resolve(instance);
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url, 443);
    if (!target) { clientSocket.destroy(); return; }
    resolveAll(target.host)
      .then((addrs) => connectFirst(target.port, addrs))
      .then((sock) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) sock.write(head);
        clientSocket.pipe(sock);
        sock.pipe(clientSocket);
        sock.on('error', () => { try { clientSocket.destroy(); } catch {} });
        clientSocket.on('error', () => { try { sock.destroy(); } catch {} });
      })
      .catch(() => {
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        clientSocket.destroy();
      });
  });

  server.on('request', (req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const isHttps = u.protocol === 'https:';
    if (u.protocol !== 'http:' && !isHttps) { res.writeHead(400); res.end(); return; }
    const port = Number(u.port || (isHttps ? 443 : 80));
    const mod = isHttps ? https : http;
    resolveAll(u.hostname)
      .then((addrs) => connectFirst(port, addrs))
      .then((sock) => {
        const headers = { ...req.headers };
        headers.host = u.host;
        const opts = {
          host: u.hostname,
          port,
          method: req.method,
          path: u.pathname + u.search,
          headers,
          createConnection: () => sock,
          agent: false,
        };
        if (isHttps) opts.servername = u.hostname;
        const proxyReq = mod.request(opts, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
        req.pipe(proxyReq);
      })
      .catch(() => {
        try { res.writeHead(502); res.end(); } catch {}
      });
  });

  // ws:// (WebSocket sin TLS) también sale por el proxy usando upgrade.
  server.on('upgrade', (req, clientSocket, head) => {
    let u;
    try { u = new URL(req.url); } catch { clientSocket.destroy(); return; }
    const isWss = u.protocol === 'wss:';
    if (u.protocol !== 'ws:' && !isWss) { clientSocket.destroy(); return; }
    const port = Number(u.port || (isWss ? 443 : 80));
    resolveAll(u.hostname)
      .then((addrs) => connectFirst(port, addrs))
      .then((sock) => {
        const lines = [`${req.method} ${u.pathname + u.search} HTTP/1.1`];
        const headers = { ...req.headers };
        headers.host = u.host;
        for (const k of Object.keys(headers)) {
          lines.push(`${k}: ${headers[k]}`);
        }
        sock.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) sock.write(head);
        let buf = Buffer.alloc(0);
        const onData = (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const status = buf.slice(0, idx).toString('latin1');
          try { clientSocket.write(status + '\r\n\r\n'); } catch {}
          const rest = buf.slice(idx + 4);
          if (rest.length) clientSocket.write(rest);
          sock.removeListener('data', onData);
          clientSocket.pipe(sock);
          sock.pipe(clientSocket);
        };
        sock.on('data', onData);
        sock.on('error', () => { try { clientSocket.destroy(); } catch {} });
        clientSocket.on('error', () => { try { sock.destroy(); } catch {} });
      })
      .catch(() => { try { clientSocket.destroy(); } catch {} });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      instance = { server, port: server.address().port };
      resolve(instance);
    });
  });
}

module.exports = { startLocalProxy };