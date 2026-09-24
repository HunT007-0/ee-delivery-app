// Service Worker — EE Delivery
// À chaque mise à jour de l'application, changer CACHE (v107 -> v108 ...).
const CACHE = 'ee-delivery-v111';
const SHELL = ['/', '/index.html', '/manifest.json'];
const SYNC_TAG = 'ee-sync-deliveries';
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzzUMBagbel4VnK32cTDOL_iFZVQwSApfiGpeBIfX7HsSfPr472ghMykUqS8kPQmYMo/exec';

// ---------- Installation : met l'application en cache pour le mode hors ligne ----------
// La nouvelle version attend ; c'est la page qui décide du bon moment pour
// l'activer (jamais pendant une livraison en cours).
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(SHELL.map(url =>
      fetch(url, { cache: 'reload' }).then(res => { if (res.ok) return c.put(url, res); }).catch(() => {})
    ))
  ));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---------- Réseau ----------
// Seules les pages et fichiers de l'application sont mis en cache.
// Les appels au serveur (script.google.com) ne sont JAMAIS mis en cache.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, '/index.html'));
  } else {
    e.respondWith(networkFirst(req, null));
  }
});

function networkFirst(req, fallbackUrl) {
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match(req)
      .then(r => r || (fallbackUrl ? caches.match(fallbackUrl).then(f => f || caches.match('/')) : null))
      .then(r => r || new Response('', { status: 504 }));
    // Réseau lent : au bout de 4 s on sert la version en cache
    const timer = setTimeout(() => { if (!done) { done = true; fromCache().then(resolve); } }, 4000);
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      if (!done) { done = true; clearTimeout(timer); fromCache().then(resolve); }
    });
  });
}

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---------- Envoi en arrière-plan (même application fermée) ----------
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) e.waitUntil(syncOutbox());
});

// Base de données partagée avec la page (même nom, même version, même migration)
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ee-delivery', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      const tx = e.target.transaction;
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'submissionId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (db.objectStoreNames.contains('queue')) {
        // Ancienne file (version 1) : on recopie chaque livraison, puis on supprime l'ancienne
        const outbox = tx.objectStore('outbox');
        tx.objectStore('queue').openCursor().onsuccess = ev => {
          const cur = ev.target.result;
          if (cur) {
            const item = cur.value || {};
            if (!item.submissionId) item.submissionId = 'mig_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            outbox.put(item);
            cur.continue();
          } else {
            db.deleteObjectStore('queue');
          }
        };
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function syncOutbox() {
  const db = await openDB();
  const auth = await idb(db, 'meta', 'readonly', s => s.get('auth'));
  if (!auth || !auth.token) return;
  const keys = await idb(db, 'outbox', 'readonly', s => s.getAllKeys());
  let sent = 0, blocked = false;
  for (const key of keys) {
    const item = await idb(db, 'outbox', 'readonly', s => s.get(key));
    if (!item) continue;
    // GPS encore en recherche depuis moins de 45 s : on laisse la page terminer
    if (item.gpsPending && Date.now() - (item.queuedAt || 0) < 45000) continue;
    const body = Object.assign({}, item, { action: 'submit', token: auth.token });
    delete body.gpsPending; delete body.queuedAt; delete body.attempts;
    let data;
    try {
      const res = await fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify(body) });
      data = await res.json();
    } catch (err) {
      throw err; // réseau indisponible : le navigateur réessaiera plus tard
    }
    if (data && data.success) {
      await idb(db, 'outbox', 'readwrite', s => s.delete(key)); // supprimé seulement après confirmation
      sent++;
    } else if (data && data.authError) {
      blocked = true; // code PIN modifié ou profil désactivé : on garde tout
      break;
    }
  }
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'SYNC_DONE', sent, blocked }));
}
