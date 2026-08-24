const CACHE = 'cajaviva-v1';
const BASE = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASE); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (nombres) {
    return Promise.all(nombres.map(function (n) {
      if (n !== CACHE) return caches.delete(n);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  // la API nunca se cachea: si no hay red, que el front lo maneje
  if (url.pathname.indexOf('/api/') === 0) return;

  // el resto: red primero, cache como respaldo
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r && r.status === 200 && e.request.method === 'GET') {
        const copia = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
      }
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (r) {
        return r || caches.match('/index.html');
      });
    })
  );
});
