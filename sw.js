const TARGET = 'https://uqrqmmw.github.io/matha/';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('matha-v')).map((name) => caches.delete(name)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map((client) => client.navigate(TARGET)));
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(Response.redirect(TARGET, 302));
});
