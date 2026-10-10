import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig = {
  reactStrictMode: true,
  // The build type-checks the app, not its tests. Some unit tests import the
  // API's source to pin a shared rule (sale totals, low stock), and Vercel
  // installs only this app's packages, so the API's `@prisma/client` is not
  // there. `npm run typecheck` still checks the tests, where it is.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
};

export default withNextIntl(nextConfig);
