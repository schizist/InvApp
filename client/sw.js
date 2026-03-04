const CACHE_NAME = 'invapp-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/idb.js'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', ev => {
  ev.respondWith(caches.match(ev.request).then(resp => resp || fetch(ev.request)));
});
