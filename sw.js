// Force new cache version every time — increment this to bust cache
const CACHE = 'ee-delivery-v10';
const ASSETS = ['/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control immediately
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Always try network first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Update cache with fresh version
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
