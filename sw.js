/* ASÜ-Timer – Service Worker: App läuft vollständig offline.
   Bei jeder Änderung VERSION erhöhen (und APP_VERSION in js/core.js). */
const VERSION = '1.0.0';
const CACHE = 'asue-timer-' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './js/core.js', './js/app.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('asue-timer-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Update erst auf Knopfdruck in der App aktivieren – nie mitten im Einsatz automatisch */
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

/* Cache zuerst: die App startet immer sofort, auch ohne Netz */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
});

/* Tipp auf eine Alarm-Benachrichtigung holt die App nach vorn */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
