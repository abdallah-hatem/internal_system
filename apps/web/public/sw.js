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
    payload = { title: 'S&F System', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'S&F System', {
      body: payload.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      // Same tag replaces rather than stacks, so five updates about one order
      // request leave one notification and not five.
      tag: payload.tag ?? 'motoparts-office',
      data: { url: payload.url ?? '/', locale: payload.locale },
    }),
  );
});

/**
 * The page a tap opens, under a language.
 *
 * Every page of this app lives under `/en/` or `/ar/`, and the API sends paths
 * without one (`/notifications/open?…`, `/settings`) — it cannot know which
 * language the reader has open. A bare path here was a 404. So: the language
 * of a window this app already has open, else the language the push is worded
 * in, else Arabic, the business's own (BUSINESS_LOGIC §10).
 */
const LOCALES = ['en', 'ar'];

function localeOf(href) {
  try {
    const first = new URL(href, self.location.origin).pathname.split('/')[1];
    return LOCALES.includes(first) ? first : null;
  } catch {
    return null;
  }
}

function underLocale(path, locale) {
  if (!path.startsWith('/') || path.startsWith('//')) return `/${locale}`;
  if (localeOf(path)) return path;
  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const path = typeof data.url === 'string' ? data.url : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const open = clients.find((c) => localeOf(c.url));
      const locale =
        (open && localeOf(open.url)) || (LOCALES.includes(data.locale) ? data.locale : 'ar');
      const target = underLocale(path, locale);

      for (const client of clients) {
        if ('focus' in client) {
          try {
            // `navigate` refuses a window this worker does not control; the
            // page then opens in a new window instead.
            await client.navigate(target);
            return client.focus();
          } catch {
            break;
          }
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
