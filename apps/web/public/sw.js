/**
 * The service worker for the office app.
 *
 * Push only. The storefront's worker caches its shell so the catalogue opens
 * offline; this one caches nothing at all, and that is the point — every
 * screen here is a balance, a landed cost or a settlement figure. A cached
 * page showing yesterday's numbers is worse than a page that will not load,
 * because nothing on screen would say which it was.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'MotoParts Manager', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'MotoParts Manager', {
      body: payload.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      // Same tag replaces rather than stacks, so five updates about one order
      // request leave one notification and not five.
      tag: payload.tag ?? 'motoparts-office',
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
