#!/usr/bin/env node
/**
 * Production launcher for Next.js `"output": "standalone"` builds.
 *
 * 1. Syncs `.next/static` and `public` alongside `.next/standalone/server.js`.
 * 2. Accepts both environment variables (`PORT`, `HOSTNAME`) and Next CLI flags
 *    (`-p` / `--port`, `-H` / `--hostname`) without emitting standalone warnings.
 * 3. Normalizes internal relative redirects (`x-internal-rel-location`) directly
 *    to wire-level relative `Location: /...` headers so host-header poisoning
 *    (`Host: evil.example`) and container wildcard binds (`0.0.0.0:8080`) can
 *    never leak onto redirect responses.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const standaloneDir = path.join(projectRoot, '.next', 'standalone');
const standaloneServer = path.join(standaloneDir, 'server.js');

if (!fs.existsSync(standaloneServer)) {
  console.error(
    `[start-standalone] Missing ${standaloneServer}. Run "npm run build" before "npm start".`
  );
  process.exit(1);
}

// Sync `public` -> `.next/standalone/public` and `.next/static` -> `.next/standalone/.next/static`
const publicSrc = path.join(projectRoot, 'public');
const publicDest = path.join(standaloneDir, 'public');
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDest, { recursive: true, force: true });
}

const staticSrc = path.join(projectRoot, '.next', 'static');
const staticDest = path.join(standaloneDir, '.next', 'static');
if (fs.existsSync(staticSrc)) {
  fs.mkdirSync(path.dirname(staticDest), { recursive: true });
  fs.cpSync(staticSrc, staticDest, { recursive: true, force: true });
}

// Enforce wire-level relative `Location` headers whenever middleware marks a
// redirect with `x-internal-rel-location`, stripping the internal marker header.
const origWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
  let hdrObj =
    typeof statusMessage === 'object' && statusMessage !== null ? statusMessage : headers;

  let internalRel = this.getHeader('x-internal-rel-location');
  if (hdrObj && !Array.isArray(hdrObj)) {
    for (const k of Object.keys(hdrObj)) {
      if (k.toLowerCase() === 'x-internal-rel-location') {
        internalRel = hdrObj[k];
        delete hdrObj[k];
      }
    }
  }
  this.removeHeader('x-internal-rel-location');

  if (typeof internalRel === 'string' && /^\/(?!\/)[^\r\n]*$/.test(internalRel)) {
    if (hdrObj && !Array.isArray(hdrObj)) {
      for (const k of Object.keys(hdrObj)) {
        if (k.toLowerCase() === 'location') {
          delete hdrObj[k];
        }
      }
    }
    this.setHeader('Location', internalRel);
  }

  return origWriteHead.apply(this, arguments);
};

// Parse optional `-p`/`--port` and `-H`/`--hostname` flags for full drop-in compatibility with `next start`
const args = process.argv.slice(2);
let cliPort = null;
let cliHost = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === '-p' || arg === '--port') && args[i + 1]) {
    cliPort = args[++i];
  } else if (arg.startsWith('--port=')) {
    cliPort = arg.slice('--port='.length);
  } else if ((arg === '-H' || arg === '--hostname') && args[i + 1]) {
    cliHost = args[++i];
  } else if (arg.startsWith('--hostname=')) {
    cliHost = arg.slice('--hostname='.length);
  }
}

process.env.PORT = cliPort || process.env.PORT || '3000';
process.env.HOSTNAME = cliHost || process.env.HOSTNAME || '0.0.0.0';
process.chdir(projectRoot);

await import(pathToFileURL(standaloneServer).href);
