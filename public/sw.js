const CACHE = 'cajaviva-v2';

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(['/', '/manifest.json', '/icon-192.png']);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ns) {
      return Promise.all(ns.map(function (n) { if (n !== CACHE) return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  // navegacion (abrir la app): red primero, si falla la copia guardada
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (r) {
        const copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put('/', copia); });
        return r;
      }).catch(function () {
        return caches.match('/');
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (guardado) {
      return guardado || fetch(e.request).then(function (r) {
        const copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
        return r;
      });
    })
  );
});
