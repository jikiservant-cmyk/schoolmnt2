// SmartSkoolz PWA service worker.
//
// SECURITY (see SECURITY_AUDIT.md Part 12):
//  - This used to precache '/' and '/dashboard' and to cache EVERY successful
//    HTML navigation response. Those pages are server-rendered with student and
//    guardian data, so on a shared machine (a school office PC or gate kiosk)
//    the previous user's data stayed in Cache Storage after logout and could be
//    read offline at /dashboard. Cache Storage also ignores the
//    `Cache-Control: no-store` header the app sets on authenticated routes, so
//    the app could not prevent it on its own.
//  - Now: ONLY public static assets are cached. HTML navigations are never
//    stored, and every cache is purged whenever the browser navigates to
//    /login or /signup (which includes the redirect that follows logout).
//  - Still offline-tolerant: an offline navigation gets a data-free shell.

const CACHE_NAME = 'smartskoolz-static-v3';

// Public, unauthenticated assets only. Never add '/' or '/dashboard'.
const STATIC_ASSETS = [
  '/manifest.json',
  '/app-icon.svg',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/icon-maskable.png',
  '/apple-touch-icon.png',
  '/favicon.png',
];

// Cacheable by extension: static build output the browser can serve offline.
const STATIC_EXTENSIONS = ['.png', '.svg', '.ico', '.woff2', '.woff', '.css', '.js'];

// Routes that mean "nobody is signed in (yet)". Seeing one purges everything.
const SIGNED_OUT_PATHS = ['/login', '/signup'];

const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0">
<div style="text-align:center"><h1 style="font-size:1.25rem;margin:0 0 .5rem">You are offline</h1>
<p style="margin:0;opacity:.8">Reconnect to load your dashboard. No cached school data is shown.</p></div>
</body></html>`;

async function purgeAllCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => undefined))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Deleting any cache that is not the current static one drops the
  // authenticated HTML stored by older versions of this worker.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Allow the app to purge on demand (e.g. a future explicit logout hook).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PURGE_CACHES') {
    event.waitUntil(purgeAllCaches());
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch auth/API/device traffic.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/iclock/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return;
  }

  const isNavigation = request.mode === 'navigate';
  const isStaticAsset = STATIC_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));

  // Reaching a signed-out page means the current session ended: drop anything
  // a previous user may have left behind on this device.
  if (isNavigation && SIGNED_OUT_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) {
    event.waitUntil(purgeAllCaches());
  }

  if (isStaticAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // HTML navigations and everything else: network only — never written to a
  // cache, so server-rendered student data cannot outlive the session.
  if (isNavigation) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
      )
    );
  }
});
