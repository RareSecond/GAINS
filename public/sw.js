// Only the empty shell and public, versioned assets are cached. API/auth/MCP responses never enter this cache.
const VERSION = '__BUILD_ID__';
const CACHE = `gains-shell-${VERSION}`;
const ASSETS = __ASSETS__;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(['/offline', ...ASSETS]);
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('gains-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request)));
  } else if (event.request.mode === 'navigate' && (url.pathname.startsWith('/sessions/') || url.pathname === '/offline')) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(CACHE)).match('/offline')));
  }
});
