import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',

  // The suite shares one API and one database, so it stays sequential. What
  // globalSetup adds is a known starting point: it snapshots the developer's
  // data, resets to the seeded state, and restores the snapshot afterwards.
  // Without that, tests that pick "the first confirmed order" passed alone and
  // failed in a full run depending on what earlier tests had left behind.
  globalSetup: './tests/support/global-setup.ts',
  globalTeardown: './tests/support/global-teardown.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  // Two apps, one harness. The storefront is a separate origin on 3002, so it
  // needs its own baseURL — but it must NOT get its own config: `globalSetup`
  // snapshots the developer's database, and two Playwright runs against the
  // same database is the one thing `CLAUDE.md` rule 6 exists to stop. A second
  // project shares this file's globalSetup, its single worker and its
  // sequential ordering, so the store is tested with the office rather than
  // beside it.
  projects: [
    {
      name: 'chromium',
      testIgnore: /storefront\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'storefront',
      testMatch: /storefront\.spec\.ts$/,
      // A phone, because that is what this app is. The bottom bar, the sheets
      // and the two-column grid are all sized for one, and a 1280px window
      // tests a layout nobody uses.
      use: { ...devices['Pixel 7'], baseURL: 'http://localhost:3002' },
    },
  ],
});
