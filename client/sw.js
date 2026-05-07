const CACHE_NAME = 'invapp-v7';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/idb.js',
  '/catalog.js',
  '/styles.css',
  '/history.html',
  '/history.js',
  '/orders.html',
  '/orders.js',
  '/vendors.html',
  '/vendors.js',
  '/bars.html',
  '/bars.js',
  '/manifest.json'
];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const path = url.pathname === '' ? '/' : url.pathname;
  const isAppShell = APP_SHELL.includes(path);
  if (!isAppShell && req.mode !== 'navigate') return;

  ev.respondWith(
    caches.match(path).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        if (resp && resp.ok) {
          return caches.open(CACHE_NAME).then(c => {
            c.put(path, resp.clone());
            return resp;
          });
        }
        return resp;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('/index.html');
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
