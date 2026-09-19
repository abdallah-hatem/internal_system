import { defineConfig, devices } from '@playwright/test';

/** True when the suite is aimed at a deployed API rather than localhost. */
const REMOTE = Boolean(process.env.API_BASE) && !/localhost|127\.0\.0\.1/.test(process.env.API_BASE!);

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

  // Aimed at the deployed API, every call crosses a network and may wake a
  // cold serverless function; the localhost figures below then fail on latency
  // rather than on behaviour, which is a check people learn to ignore.
  ...(REMOTE ? { timeout: 240_000, expect: { timeout: 60_000 } } : {}),

  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: REMOTE ? 90_000 : 15_000,
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
      // Anything with `production` anywhere in the name, not only at the end.
      // The previous pattern required the file to *end* with
      // `production.spec.ts`, so `60-production-audit` and
      // `62-production-stock-flow` fell through and ran against localhost —
      // where they assert things only true of the deployed system, and one of
      // them was never in the production project at all, so it had only ever
      // run against the wrong target.
      testIgnore: /(storefront\.spec\.ts|production.*\.spec\.ts)$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Against the deployed URLs, and excluded from the default run: it costs
      // a network round trip per assertion and depends on data that lives in
      // production. `npx playwright test --project=production`.
      //
      // It exists because three failures this week were invisible to every
      // other test here — they only happen in a compiled CommonJS bundle on a
      // host with no disk, which is a thing localhost never is.
      name: 'production',
      // Matched by convention rather than by listing each file: the list had
      // already fallen behind by one, and a production test that silently runs
      // nowhere is worse than one that fails.
      testMatch: /production.*\.spec\.ts$/,
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
