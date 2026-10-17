// sw.js
const CACHE_NAME = 'sgs-live-v2';
const ASSETS = [
  '/',
  'https://jsdelivr.net',
  'https://cloudflare.com'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', e => {
  // Only intercept requests targeting our local server endpoints
  if (e.request.url.startsWith(self.location.origin)) {
    e.respondWith(
      caches.match(e.request).then(res => res || fetch(e.request))
    );
  }
});
