// Service Worker v11 - Background sync + auto-update
const CACHE = 'ee-delivery-v11';
const ASSETS = ['/index.html', '/manifest.json'];
const SYNC_TAG = 'ee-sync-deliveries';

// Install - cache assets immediately
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
});

// Activate - clean old caches, take control immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Background sync - upload queued deliveries even when app is closed
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(syncDeliveries());
  }
});

async function syncDeliveries() {
  try {
    // Get queue from IndexedDB (more reliable than localStorage for SW)
    const queue = await getQueue();
    if (!queue.length) return;
    
    const remaining = [];
    for (const item of queue) {
      try {
        const res = await fetch('https://script.google.com/macros/s/AKfycbzzUMBagbel4VnK32cTDOL_iFZVQwSApfiGpeBIfX7HsSfPr472ghMykUqS8kPQmYMo/exec', {
          method: 'POST',
          body: JSON.stringify(item)
        });
        const data = await res.json();
        if (!data.success && !data.duplicate) remaining.push(item);
      } catch(e) {
        remaining.push(item);
      }
    }
    await saveQueue(remaining);
    
    // Notify open clients
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'SYNC_DONE', remaining: remaining.length }));
  } catch(e) {
    console.error('SW sync error:', e);
  }
}

// IndexedDB helpers for reliable offline storage
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ee-delivery', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('queue', { autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e);
  });
}

async function getQueue() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readonly');
      const req = tx.objectStore('queue').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch(e) { return []; }
}

async function saveQueue(items) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite');
      const store = tx.objectStore('queue');
      store.clear();
      items.forEach(item => store.add(item));
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch(e) {}
}

// Listen for messages from app
self.addEventListener('message', e => {
  if (e.data.type === 'QUEUE_DELIVERY') {
    // Store in IndexedDB and register sync
    openDB().then(db => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add(e.data.payload);
      tx.oncomplete = () => {
        // Register background sync
        self.registration.sync.register(SYNC_TAG).catch(() => {});
      };
    });
  }
  if (e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
