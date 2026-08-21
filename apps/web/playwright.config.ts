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

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
