const CACHE_NAME = 'invapp-v2';
const ASSETS = ['/', '/index.html', '/app.js', '/idb.js', '/bars.html', '/bars.js', '/history.html', '/history.js'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  ev.respondWith(caches.match(ev.request).then(resp => resp || fetch(ev.request)));
});
