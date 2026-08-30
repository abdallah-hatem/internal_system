/**
 * The service worker.
 *
 * Two jobs, and deliberately not a third.
 *
 * 1. Receive pushes and show them.
 * 2. Open the right page when one is tapped, focusing a tab that is already
 *    open rather than piling up a new one each time.
 *
 * It does NOT cache anything that carries a price or a stock band. A cached
 * "in stock" is a promise the shop acts on, and a cached price is one they
 * quote to a customer. Only the shell is cached, so the app opens offline and
 * says it cannot reach the store — which is honest — rather than opening
 * instantly onto figures from yesterday.
 */

const SHELL = 'shell-v1';
const SHELL_FILES = ['/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never the API. Everything it returns is a price, a stock band or somebody's
  // own order, and none of that may be served from a cache.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline')));
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'MotoParts', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'MotoParts', {
      body: payload.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      // Same tag replaces rather than stacks, so five updates about one request
      // leave one notification and not five.
      tag: payload.tag ?? 'motoparts',
      data: { url: payload.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
