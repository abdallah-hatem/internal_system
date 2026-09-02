import type { MetadataRoute } from 'next';

/**
 * What makes this installable.
 *
 * The office app is used on a phone more than its desktop layout suggests —
 * approving an order request or answering an import question is a two-minute
 * job somebody does standing in a shop, not at a desk. `display: standalone`
 * removes the browser chrome once it is added to a home screen.
 *
 * `theme_color` is slate rather than the brand blue, matching the icon. The
 * storefront's blue is `#1d4ed8`, which is also this app's `primary-700` — two
 * tiles in the same blue would be genuinely hard to tell apart, and this is
 * the one a customer never sees.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MotoParts Manager',
    short_name: 'Manager',
    description: 'Cycles, stock, sales and settlements.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: '#1e293b',
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
