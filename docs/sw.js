// Outflow service worker: instant app shell, offline start, cached radar files.
const VERSION = 'outflow-1.0.1';
const SHELL = `${VERSION}-shell`;
const RADAR = 'outflow-radar-files';
const ASSETS = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/core.js', 'js/decode-worker.js', 'js/nexrad.js', 'js/overlays.js', 'js/palettes.js',
  'js/radar-layer.js', 'js/style.js', 'js/units.js', 'wasm/outflow_core.wasm', 'data/sites.json',
  'icons/icon.svg', 'icons/icon-192.png',
];
const MAX_RADAR_FILES = 240;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.endsWith('-shell') && k !== SHELL) await caches.delete(k);
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

  // App files: serve from cache, refresh in the background.
  if (url.origin === location.origin) {
    let saved = Promise.resolve();
    const net = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        saved = caches.open(SHELL).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => null);
    e.waitUntil(net.then(() => saved));
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true, cacheName: SHELL });
      return hit || (await net) || new Response('Offline', { status: 503 });
    })());
  }
});
