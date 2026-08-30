import type { MetadataRoute } from 'next';

/**
 * What makes this installable.
 *
 * `display: standalone` is what removes the browser chrome once a shop adds it
 * to the home screen — and on iOS that installation is also the only way web
 * push works at all. The account screen says so plainly rather than leaving a
 * permission prompt that silently does nothing.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MotoParts',
    short_name: 'MotoParts',
    description: 'Browse parts, ask to buy, and request what we do not stock.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#1d4ed8',
    dir: 'auto',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
