import type { MetadataRoute } from 'next';

/**
 * What makes this installable.
 *
 * The office app is used on a phone more than its desktop layout suggests —
 * approving an order request or answering an import question is a two-minute
 * job somebody does standing in a shop, not at a desk. `display: standalone`
 * removes the browser chrome once it is added to a home screen.
 *
 * The icon is the S&F logo on black (owner, 2026-10-14), so the splash screen is
 * black to match it. The status bar is white, the colour of the top bar it sits
 * over — the same `themeColor` the layout declares.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MotoParts Manager',
    short_name: 'Manager',
    description: 'Cycles, stock, sales and settlements.',
    start_url: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#ffffff',
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
