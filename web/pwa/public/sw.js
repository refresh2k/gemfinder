// Minimal shell cache: app chrome works offline after first load.
// Scan and report endpoints always go to the network.
const CACHE = 'gem-shell-v12';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const path = new URL(event.request.url).pathname;
  if (path.startsWith('/scan') || path === '/demo/report') return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok && res.type === 'basic') cache.put(event.request, res.clone());
      return res;
    }),
  );
});
