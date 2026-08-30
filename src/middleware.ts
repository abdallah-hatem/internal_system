import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // The service worker and the manifest must NOT be rewritten into a locale.
  // A service worker served from /ar/sw.js has /ar/ as its scope and cannot
  // control the pages it was registered for.
  matcher: ['/((?!api|_next|sw\\.js|manifest\\.webmanifest|icons|.*\\..*).*)'],
};
