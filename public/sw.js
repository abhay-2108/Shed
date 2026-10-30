// Shed's service worker: shows push notifications and opens the right session or task when one is tapped.
const SHELL_CACHE = 'shed-shell-v3';
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/theme.css',
  '/app.js',
  '/logo.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(PRECACHE).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch event handler required for PWA installability criteria
self.addEventListener('fetch', event => {
  // Let non-GET or API requests pass directly to the network
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for shell assets
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('/') || caches.match('/index.html');
        }
        return new Response('Network error', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title:'Shed', body:event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Shed', {
    body:data.body || '',
    icon:'/icon-192.png',
    badge:'/icon-192.png',
    tag:data.tag,
    renotify:Boolean(data.tag),
    data:{ url:data.url || '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type:'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
