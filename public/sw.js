// PreachListen Service Worker v3
// Strategy: Network-first for API/HTML; Cache-first for static assets.
// HTML is intentionally NOT pre-cached to ensure security headers (CSP etc.) are always fresh.
// On each new SW version activation, all open tabs are reloaded to pick up fresh headers.

const CACHE_VERSION = 'preachlisten-v3';

const PRECACHE_ASSETS = [
  '/src/styles/main.css',
  '/src/styles/panes.css',
  '/src/main.js',
  '/src/utils/eventBus.js',
  '/src/utils/virtualScroller.js',
  '/src/utils/chunkBatcher.js',
  '/src/store/db.js',
  '/src/services/tokenService.js',
  '/src/services/speechService.js',
  '/src/services/translationService.js',
  '/src/ui/toolbar.js',
  '/src/ui/controls.js',
  '/src/ui/langPicker.js',
  '/src/ui/transcriptPane.js',
  '/src/ui/translationPane.js',
  '/icons/icon.svg',
  '/manifest.json',
];

// ── Install: pre-cache all static assets ───────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove stale caches, claim clients, then reload them ───────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' })))
  );
});

// ── Fetch: routing strategy ─────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests (POST to /api/translate, etc.)
  if (request.method !== 'GET') return;

  // API calls: network-first, offline fallback with JSON error
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .catch(() => new Response(
          JSON.stringify({ error: 'offline', message: 'App is offline. API unavailable.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // External CDN scripts (Speech SDK, Dexie): network-first, cache fallback
  if (!url.hostname.includes(self.location.hostname)) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(r => r || Response.error()))
    );
    return;
  }

  // HTML documents: always network-first (never cache — security headers must be fresh)
  if (request.headers.get('accept')?.includes('text/html') || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(fetch(request));
    return;
  }

  // Static assets: cache-first, network fallback
  event.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
  );
});
