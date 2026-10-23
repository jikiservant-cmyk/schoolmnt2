const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * SmartSkoolz Hardened ZKTeco ADMS HTTP-to-HTTPS Reverse Proxy
 *
 * Bridges older ZKTeco biometric terminals that only speak plain HTTP on port 80
 * to the HTTPS SmartSkoolz backend over TLS, while strictly isolating untrusted
 * LAN traffic:
 *
 *   1. Requires explicit `UPSTREAM_URL` env var (`http://` or `https://`); no
 *      hardcoded development or staging cloud domains.
 *   2. Strict route & method allowlist ONLY:
 *        - GET | POST /iclock/cdata
 *        - GET        /iclock/getrequest
 *        - POST       /iclock/devicecmd
 *   3. Strips incoming spoofable forwarding / auth / session headers:
 *        `x-forwarded-for`, `x-real-ip`, `x-device-token`, `authorization`, `cookie`
 *   4. Injects per-serial `X-Device-Token` resolved from `DEVICE_TOKENS_JSON`
 *      (keyed by uppercase device serial `SN`), falling back to `ZKTECO_DEVICE_SECRET`.
 *   5. Enforces a 1 MB request body limit (`413 Payload Too Large`) and a 15 s
 *      upstream timeout (`504 Gateway Timeout`).
 */

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const UPSTREAM_TIMEOUT_MS = 15_000; // 15 seconds

const ALLOWED_ROUTES = new Map([
  ['/iclock/cdata', new Set(['GET', 'POST'])],
  ['/iclock/getrequest', new Set(['GET'])],
  ['/iclock/devicecmd', new Set(['POST'])],
]);

const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'x-device-token',
  'authorization',
  'cookie',
]);

function parseUpstreamUrl(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      'Missing required environment variable UPSTREAM_URL (e.g. UPSTREAM_URL=https://smartskoolz.example.com).'
    );
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid UPSTREAM_URL "${raw}": must be a valid http:// or https:// origin.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported UPSTREAM_URL protocol "${parsed.protocol}": must be http: or https:.`);
  }
  return parsed;
}

function parseDeviceTokensMap(rawJson) {
  const tokenMap = new Map();
  if (!rawJson || !rawJson.trim()) return tokenMap;

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid JSON in DEVICE_TOKENS_JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DEVICE_TOKENS_JSON must be a JSON object mapping serial numbers to tokens.');
  }

  for (const [serial, token] of Object.entries(parsed)) {
    if (typeof token === 'string' && token.trim()) {
      tokenMap.set(serial.trim().toUpperCase(), token.trim());
    }
  }
  return tokenMap;
}

function createAdmsProxyServer(config = {}) {
  const upstreamUrl = parseUpstreamUrl(config.upstreamUrl ?? process.env.UPSTREAM_URL);
  const deviceTokens = parseDeviceTokensMap(config.deviceTokensJson ?? process.env.DEVICE_TOKENS_JSON);
  const fallbackSecret = String(config.fallbackDeviceSecret ?? process.env.ZKTECO_DEVICE_SECRET ?? '').trim();
  const upstreamBasePath = upstreamUrl.pathname === '/' ? '' : upstreamUrl.pathname.replace(/\/+$/, '');
  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  const server = http.createServer((clientReq, clientRes) => {
    let responded = false;
    const sendPlain = (statusCode, text) => {
      if (responded) return;
      responded = true;
      clientRes.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text, 'utf8'),
      });
      clientRes.end(text);
    };

    const rawUrl = clientReq.url || '';
    if (!rawUrl || rawUrl.length > 4096 || /[\u0000-\u001F\\]|\.\./.test(rawUrl)) {
      return sendPlain(400, 'Bad Request');
    }

    let reqUrl;
    try {
      reqUrl = new URL(rawUrl, 'http://proxy.internal');
    } catch {
      return sendPlain(400, 'Bad Request');
    }

    // Strict allowlist check
    const allowedMethods = ALLOWED_ROUTES.get(reqUrl.pathname);
    if (!allowedMethods) {
      return sendPlain(403, 'Forbidden');
    }
    const method = (clientReq.method || 'GET').toUpperCase();
    if (!allowedMethods.has(method)) {
      return sendPlain(405, 'Method Not Allowed');
    }

    // Early Content-Length check against 1 MiB ceiling
    const declaredLength = Number(clientReq.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      clientReq.resume();
      return sendPlain(413, 'Payload Too Large');
    }

    const chunks = [];
    let totalBytes = 0;
    let bodyTooLarge = false;

    clientReq.on('data', (chunk) => {
      if (bodyTooLarge) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        sendPlain(413, 'Payload Too Large');
        clientReq.destroy();
        return;
      }
      chunks.push(chunk);
    });

    clientReq.on('error', () => {
      sendPlain(400, 'Bad Request');
    });

    clientReq.on('end', () => {
      if (bodyTooLarge || responded) return;

      const bodyBuffer = Buffer.concat(chunks, totalBytes);

      // Copy safe headers only; strip forwarding, auth, token, and cookie headers
      const forwardHeaders = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        const lower = k.toLowerCase();
        if (STRIPPED_HEADERS.has(lower) || v === undefined) continue;
        forwardHeaders[lower] = v;
      }

      forwardHeaders['host'] = upstreamUrl.host;
      forwardHeaders['content-length'] = String(bodyBuffer.length);

      // Inject per-serial X-Device-Token from DEVICE_TOKENS_JSON or fallback ZKTECO_DEVICE_SECRET
      const serial = (reqUrl.searchParams.get('SN') || reqUrl.searchParams.get('sn') || '')
        .trim()
        .toUpperCase();
      const tokenForDevice = (serial && deviceTokens.get(serial)) || fallbackSecret;
      if (tokenForDevice) {
        forwardHeaders['x-device-token'] = tokenForDevice;
      }

      const targetOptions = {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: `${upstreamBasePath}${reqUrl.pathname}${reqUrl.search}`,
        method,
        headers: forwardHeaders,
        timeout: UPSTREAM_TIMEOUT_MS,
      };

      let timedOut = false;

      const proxyReq = transport.request(targetOptions, (proxyRes) => {
        if (responded) {
          proxyRes.resume();
          return;
        }
        responded = true;
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });

      proxyReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        timedOut = true;
        proxyReq.destroy(new Error('Upstream timeout'));
      });

      proxyReq.on('error', (err) => {
        console.error(`[ADMS Proxy] Upstream error for ${method} ${reqUrl.pathname}:`, err.message);
        sendPlain(timedOut ? 504 : 502, timedOut ? 'Gateway Timeout' : 'Bad Gateway');
      });

      if (bodyBuffer.length > 0) {
        proxyReq.write(bodyBuffer);
      }
      proxyReq.end();
    });
  });

  return server;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 80);
  const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
  const server = createAdmsProxyServer();
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[ADMS Proxy] Listening on http://${BIND_HOST}:${PORT} -> ${process.env.UPSTREAM_URL}`);
  });
}

module.exports = { createAdmsProxyServer };
