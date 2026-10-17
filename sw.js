// sw.js
const CACHE_NAME = 'sgs-live-v1';
const ASSETS = [
  '/',
  'https://jsdelivr.net',
  'https://cloudflare.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
