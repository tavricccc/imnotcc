// Keeps the app shell so it opens instantly and offline; never caches the API or the socket.
const CACHE = 'imnotcc-v3';

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add('/'))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/preview/') || url.pathname === '/ws') return;
  // Pages: network first, the cached shell when offline. Built assets have hashed names: cache first.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { caches.open(CACHE).then((c) => c.put('/', r.clone())); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
  }
});

// Web Push: skipped while the session it is about is open in front of the user.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data?.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const watching = data.url && wins.some((w) => w.focused && w.visibilityState === 'visible' && new URL(w.url).pathname === data.url);
    if (watching) return;
    return self.registration.showNotification(data.title || 'imnotcc', {
      body: data.body || '', tag: data.tag, renotify: !!data.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url || '/' },
    });
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).origin === location.origin);
    // An open app moves to the session itself, without reloading.
    if (win) { win.postMessage({ type: 'open', url: new URL(url).pathname }); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
