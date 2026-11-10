// Service worker: makes the installed app work offline.
// Every request is answered from the cache straight away when possible and refreshed
// from the network in the background, so updates appear on the next launch.
// Bump VERSION whenever you change the list of files below.
const APP = 'storm-the-shore';
const VERSION = 4;
const CACHE = `${APP}-v${VERSION}`;
const PRECACHE = [
  './',
  './index.html',
  './sim.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  // CC0 sprites and sounds (assets/CREDITS.md)
  './assets/fx/circle2.png',
  './assets/fx/dirt1.png',
  './assets/fx/fire1.png',
  './assets/fx/flare1.png',
  './assets/fx/muzzle2.png',
  './assets/fx/scorch1.png',
  './assets/fx/smoke10.png',
  './assets/fx/smoke4.png',
  './assets/fx/smoke7.png',
  './assets/fx/star6.png',
  './assets/fx/star8.png',
  './assets/fx/star9.png',
  './assets/fx/trace7.png',
  './assets/sfx/bad.ogg',
  './assets/sfx/bigboom.ogg',
  './assets/sfx/boom.ogg',
  './assets/sfx/clank.ogg',
  './assets/sfx/coin.ogg',
  './assets/sfx/glass.ogg',
  './assets/sfx/hit.ogg',
  './assets/sfx/pop.ogg',
  './assets/sfx/powerup.ogg',
  './assets/sfx/rocket.ogg',
  './assets/sfx/shatter.ogg',
  './assets/sfx/shot-heavy.ogg',
  './assets/sfx/shot.ogg',
  './assets/sfx/smash.ogg',
];
// Other hosts whose files should also work offline (for example Google Fonts).
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never mixes old and new files
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  // Only delete this app's old caches: other apps on the same site keep theirs.
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(`${APP}-v`) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin && !RUNTIME_HOSTS.includes(url.hostname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const refresh = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const fresh = await refresh;
    return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
