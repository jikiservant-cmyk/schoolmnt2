const CACHE_NAME = 'smartskoolz-pwa-v3';
const STATIC_ASSETS = [
  '/manifest.json',
  '/app-icon.svg',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/apple-touch-icon.png',
  '/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('PWA Pre-cache partial error:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only intercept same-origin GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept or cache HTML documents, authenticated routes, register/kiosk
  // pages, auth endpoints, API routes, or biometric hardware endpoints.
  if (
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.startsWith('/dashboard') ||
    url.pathname.startsWith('/manual-attendance') ||
    url.pathname.startsWith('/mark-attendance') ||
    url.pathname === '/login' ||
    url.pathname.startsWith('/login/') ||
    url.pathname === '/signup' ||
    url.pathname.startsWith('/signup/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/iclock/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return;
  }

  // Strictly public static assets only (icons, fonts, immutable Next static assets, stylesheets)
  if (
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.css')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          const cc = networkResponse.headers.get('cache-control') || '';
          if (networkResponse.ok && networkResponse.type === 'basic' && !cc.includes('no-store')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        });
      })
    );
  }
});
