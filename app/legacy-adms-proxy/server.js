/**
 * ZKTeco Legacy ADMS HTTP -> HTTPS proxy.
 *
 * Legacy ZKTeco terminals (e.g. the F18) only speak plain HTTP and cannot be
 * pointed at an HTTPS URL, while Cloud Run refuses unencrypted traffic. This
 * bridge runs on the school LAN and forwards device traffic to the app.
 *
 * SECURITY (see SECURITY_AUDIT.md Part 12): this used to be an open relay —
 * it forwarded EVERY path, EVERY method, ANY body size, copying all request
 * headers and the upstream's response headers, to a hardcoded host. Anything
 * that could reach the LAN port (a student phone, a guest laptop, a compromised
 * device) could use it to reach the cloud app from the school's IP, smuggle
 * hop-by-hop headers, or buffer unbounded bodies. Now:
 *   - only GET/POST/HEAD on `/iclock/...` are forwarded; anything else is 404/405;
 *   - the body is capped at 1 MB, matching the app's device limit;
 *   - request and response headers are allowlisted (no cookies, no
 *     x-forwarded-*, no connection/transfer-encoding/upgrade);
 *   - the target comes from ADMS_TARGET_URL and must be HTTPS unless it points
 *     at loopback (so the local test harness can use plain HTTP);
 *   - upstream requests time out instead of hanging forever.
 */

const http = require('http');
const https = require('https');

// Default target: the deployed app. Override with ADMS_TARGET_URL.
const DEFAULT_TARGET = 'https://ais-dev-akkeowfawefwrcoub3t3e3-159837012533.europe-west3.run.app';
const TARGET_URL = process.env.ADMS_TARGET_URL || DEFAULT_TARGET;
const PORT = Number(process.env.PORT || 80);
const MAX_BODY_BYTES = Number(process.env.ADMS_MAX_BODY_BYTES || 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.ADMS_UPSTREAM_TIMEOUT_MS || 15000);

// Only the device protocol paths are proxied.
const ALLOWED_PREFIXES = ['/iclock/'];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD']);

// Device-relevant request headers only.
const REQUEST_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'user-agent',
  'authorization',
  'x-device-sn',
  'x-serial-number',
]);

// Response headers a terminal needs; everything else is dropped.
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-length',
  'retry-after',
  'cache-control',
]);

function resolveTarget() {
  let url;
  try {
    url = new URL(TARGET_URL);
  } catch {
    throw new Error(`ADMS_TARGET_URL is not a valid URL: ${TARGET_URL}`);
  }
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(
      `Refusing to forward device traffic over plain HTTP to ${url.hostname}. ` +
      'Use an https:// target, or http:// only for a loopback test harness.'
    );
  }
  return url;
}

function isAllowedPath(pathname) {
  return ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function pickHeaders(headers, allowlist) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (allowlist.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

const target = resolveTarget();
const agent = target.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : undefined;

function denyTooLarge(req, res) {
  // Answer first, then drop the socket: destroying the request before the
  // response is flushed leaves some clients waiting forever.
  res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
  res.end('Payload too large', () => req.destroy());
}

const server = http.createServer((req, res) => {
  // Never log full query strings: they carry the device serial and secret.
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (!isAllowedPath(pathname)) {
    console.warn(`[${new Date().toISOString()}] blocked ${req.method} ${pathname} (path not proxied)`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    console.warn(`[${new Date().toISOString()}] blocked ${req.method} ${pathname} (method not allowed)`);
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, HEAD' });
    res.end('Method not allowed');
    return;
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) {
    denyTooLarge(req, res);
    return;
  }

  console.log(`[${new Date().toISOString()}] ADMS ${req.method} ${pathname} -> ${target.host}`);

  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname.replace(/\/$/, '') + req.url,
    method: req.method,
    agent,
    headers: {
      ...pickHeaders(req.headers, REQUEST_HEADER_ALLOWLIST),
      // Google Cloud rejects the request unless Host matches the service.
      host: target.host,
    },
  };

  const proxyReq = (target.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, pickHeaders(proxyRes.headers, RESPONSE_HEADER_ALLOWLIST));
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.error('[PROXY ERROR] upstream timeout');
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Gateway timeout');
    }
  });

  proxyReq.on('error', (err) => {
    console.error('[PROXY ERROR] failed to reach cloud server:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    } else {
      res.end();
    }
  });

  // Stream the body, counting bytes: a missing/lying Content-Length must not
  // let a client buffer without limit.
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      console.warn('[PROXY] request body exceeded limit, aborting');
      req.unpipe(proxyReq);
      proxyReq.destroy();
      denyTooLarge(req, res);
    }
  });
  req.pipe(proxyReq, { end: true });
});

// Slow clients must not hold sockets open indefinitely.
server.headersTimeout = 20000;
server.requestTimeout = 30000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('===================================================');
  console.log(' ZKTeco ADMS HTTP -> HTTPS Proxy');
  console.log('===================================================');
  console.log(` Listening on HTTP port : ${PORT}`);
  console.log(` Forwarding             : ${ALLOWED_PREFIXES.join(', ')}`);
  console.log(` To                     : ${target.origin}`);
  console.log(` Body limit             : ${MAX_BODY_BYTES} bytes`);
  console.log('===================================================');
  console.log(' Point the terminal at this machine\'s LAN IP (port 80).');
  console.log(' Override the target with ADMS_TARGET_URL if the app moved.');
});
