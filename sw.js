// Stale-while-revalidate Service Worker
// - Serves cached responses immediately
// - Revalidates in background and updates cache
// - Notifies clients ('SW_UPDATED') once when key assets refresh

const CACHE_NAME = 'card-payments-swr-v4';
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './app.js',
  // Optional: cached if present
  './styles.css',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/apple/apple-touch-icon.png'
];
const NOTIFY_ON_UPDATE = new Set([
  new URL('./app.js', self.location).href,
  new URL('./index.html', self.location).href,
  new URL('./styles.css', self.location).href
]);
let notifiedOnce = false;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Tolerate missing assets so install doesn't fail
    await Promise.all(
      PRECACHE_ASSETS.map(async (url) => {
        try { await cache.add(url); } catch (_) { /* ignore */ }
      })
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cachedPromise = cache.match(req);
  const networkPromise = fetch(req)
    .then(async (resp) => {
      if (resp && resp.ok) {
        const prev = await cache.match(req);
        await cache.put(req, resp.clone());
        await maybeNotifyUpdated(new URL(req.url).href, prev, resp);
      }
      return resp;
    })
    .catch(() => null);
  const cached = await cachedPromise;
  return cached || (await networkPromise) || Response.error();
}

async function maybeNotifyUpdated(url, prev, resp) {
  if (notifiedOnce) return;
  if (!NOTIFY_ON_UPDATE.has(url)) return;
  // If there was a previous cached response and headers indicate no change, do not notify
  try {
    if (prev) {
      const etagNew = resp.headers.get('ETag');
      const etagOld = prev.headers.get('ETag');
      const lmNew = resp.headers.get('Last-Modified');
      const lmOld = prev.headers.get('Last-Modified');
      const clenNew = resp.headers.get('Content-Length');
      const clenOld = prev.headers.get('Content-Length');
      const same = (etagNew && etagNew === etagOld) || (lmNew && lmNew === lmOld) || (clenNew && clenNew === clenOld);
      if (same) return;
    }
  } catch {}
  notifiedOnce = true;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage('SW_UPDATED'));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(
    fetch(req).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      return cached || Response.error();
    })
  );
});