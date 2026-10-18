// Service worker: makes the game load instantly and work offline once played.
// The version and precache list below are filled in by build.mjs.

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `spacecadet-shell-${VERSION}`;
const DATA = 'spacecadet-data-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('spacecadet-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const isBigAsset = (url) => /\/data\/|\.(sf2|sf3|dls)$/i.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return; // always live

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('./', res.clone());
        return res;
      } catch {
        return (await caches.match('./')) || (await caches.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  if (isBigAsset(url)) {
    // Game data and sound banks: cache first, keep a copy after first use.
    event.respondWith((async () => {
      const cache = await caches.open(DATA);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && url.pathname.includes('/assets/')) {
      (await caches.open(SHELL)).put(req, res.clone());
    }
    return res;
  })());
});
