// Service worker: l'app funziona anche offline.
// VERSION e ASSETS sono rigenerati da tools/build-sw.mjs a ogni pubblicazione.

const VERSION = 'fotogiro-dev';
const ASSETS = [
  './',
  'index.html',
  'bersaglio.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'icons/maskable-512.png',
  'js/app.js',
  'js/board.js',
  'js/carve.js',
  'js/coverage.js',
  'js/demo-worker.js',
  'js/dictionary.js',
  'js/geometry.js',
  'js/markers.js',
  'js/mesh.js',
  'js/scanner.js',
  'js/segment.js',
  'js/sim.js',
  'js/turntable.js',
  'js/viewer.js',
  'js/worker.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' salta la cache HTTP (GitHub Pages la tiene 10 minuti):
  // altrimenti la nuova versione potrebbe salvare i file della vecchia
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/sw.js')) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('index.html'))),
  );
});
