// Watergaw service worker: instant app shell, offline start, cached radar files.
const VERSION = 'watergaw-1.6.1';
const SHELL = `${VERSION}-shell`;
const RADAR = 'watergaw-radar-files';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/core.js', 'js/places.js', 'js/forecast.js', 'js/decode-worker.js', 'js/nexrad.js', 'js/overlays.js', 'js/palettes.js',
  'js/radar-layer.js', 'js/style.js', 'js/units.js', 'wasm/watergaw_core.wasm', 'data/sites.json',
  'icons/icon.svg', 'icons/icon-192.png',
];
const MAX_RADAR_FILES = 240;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores old files.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RADAR) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_RADAR_FILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Radar files never change once written: cache first. Listings always go to the network.
  if (url.hostname === 'unidata-nexrad-level3.s3.amazonaws.com') {
    if (url.search) return;
    e.respondWith((async () => {
      const cache = await caches.open(RADAR);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { cache.put(req, res.clone()); trim(cache); }
      return res;
    })());
    return;
  }

  // App files: network first (revalidated, so new releases show up right away),
  // falling back to the cached copy when offline.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || new Response('Offline', { status: 503 });
      }
    })());
  }
});

// Tapping an alert brings Watergaw to the front.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
