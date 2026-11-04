/* CardWise service worker: keeps the app working offline.
   Your data lives in the browser and in your private gist, never in this cache. */
const VERSION = 'et-v17';
const SHELL = ['./', 'index.html', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; /* GitHub API calls go straight to the network */
  /* pages: try the network first so updates arrive, fall back to the saved copy offline */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }
  /* everything else: saved copy first, refresh it in the background */
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
      return hit || net;
    })
  );
});

/* Reminders: show the notification the GitHub job sends, and open the app when it is tapped.
   No large image: Android already shows the app icon on the left, and iPhone always uses the app icon.
   The number on the app icon is how many reminders are waiting; opening the app clears it. */
const setBadge = () => self.registration.getNotifications().then(list => {
  const nav = self.navigator;
  if (!nav.setAppBadge) return;
  return list.length ? nav.setAppBadge(list.length) : nav.clearAppBadge();
}).catch(() => {});
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: e.data ? e.data.text() : 'CardWise' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'CardWise', {
    body: d.body || '', tag: d.tag || undefined, badge: 'icons/badge-96.png', data: { url: d.url || './' }
  }).then(setBadge));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(setBadge().then(() => clients.matchAll({ type: 'window', includeUncontrolled: true })).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : clients.openWindow(url);
  }));
});
self.addEventListener('notificationclose', e => { e.waitUntil(setBadge()); });
