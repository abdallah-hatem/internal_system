import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit and component tests (src/**/*.test.ts[x]). Full flows stay in Playwright (tests/).
// The machine clock is pinned to UTC so a test about "Cairo's today" proves the
// code does not fall back to the browser's local day.
process.env.TZ = 'UTC';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    env: { TZ: 'UTC' },
  },
});
