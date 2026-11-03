/**
 * ═══════════════════════════════════════════════════════════════════════
 *  Visual regression: the main office screens, pixel for pixel
 * ═══════════════════════════════════════════════════════════════════════
 *  UI review used to mean an agent opening every screenshot in `.ui-audit`
 *  (2,500+ of them) and looking for what changed. This spec does the
 *  repeated part: each screen is compared with a committed baseline, so only
 *  the screens whose pixels moved need a person's — or an agent's — eye.
 *
 *  Opt-in (`VISUAL=1`, see playwright.config.ts) because the baselines are
 *  per-OS: fonts and anti-aliasing differ, so `*-chromium-darwin.png` says
 *  nothing about a Linux run. In an agent environment (CLAUDE.md rule 6):
 *
 *    AGENT_CLOCK=2026-11-01T08:00:00Z scripts/agent-servers.sh <name> start
 *    npm run test:visual            (with that environment's exports)
 *
 *  After a deliberate UI change, look at the diff in the HTML report and
 *  accept it with `npm run test:visual:update`.
 *
 *  Deterministic by construction:
 *  - the data is what globalSetup reseeds the run's database to — the demo
 *    level (two cycles, two orders, payments), because the reference level
 *    of `db:reset` has no cycle or order to show — and this spec writes
 *    nothing, so every test sees the same rows;
 *  - the browser clock is frozen, so "today", date-range defaults and
 *    relative times are the same on every run;
 *  - animations, transitions and the caret are off, the dev overlay is
 *    hidden, and the screenshot waits until no skeleton is left;
 *  - the seed stamps some rows with the moment it ran (an order's date, a
 *    receipt's check-in, an FX rate's effective-from — anything defaulted to
 *    now()). Those are pinned to SEEDED_AT before the first screen, so a
 *    baseline taken today still matches a run next week;
 *  - the API's clock starts at FROZEN_NOW too (AGENT_CLOCK, see
 *    scripts/lib/fixed-clock.cjs) — the dashboard's This month is worked out
 *    on the server — and the spec refuses to run against one that does not;
 *  - one timezone, one Intl locale, one viewport for every run.
 *
 *  The app is light-only (globals.css: no dark theme is wired to anything),
 *  so there is no dark variant to capture.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { login, messages, BASE, type Locale } from './support/ui';
import { psqlQuery } from './support/database';
import { API } from './support/env';
import { EMAIL, PASSWORD } from './support/fixtures';

/** The moment every run believes it is. A Sunday morning, Cairo time. */
const FROZEN_NOW = new Date('2026-11-01T08:00:00Z');
/** What the seed's "now" becomes: an hour before FROZEN_NOW, so it is "today" and already past. */
const SEEDED_AT = '2026-11-01 07:00:00+00';

const LOCALES: Locale[] = ['en', 'ar'];

/** Per-pixel colour tolerance (YIQ, 0–1). See snap(). */
const PIXEL_THRESHOLD = 0.01;

/**
 * The office is a sidebar and a scrolling `main`, so `fullPage` sees only the
 * window. A tall window shows each screen's whole first page instead.
 */
test.use({
  viewport: { width: 1280, height: 2000 },
  timezoneId: 'Africa/Cairo',
  locale: 'en-US',
});

/**
 * Pin every timestamp the seed took from the clock. globalSetup reseeded this
 * database moments ago, so "near now" is exactly those rows; every date the
 * seed writes on purpose (July and August 2026) is far outside the window and
 * left alone. The database is the run's own and is restored after it.
 */
test.beforeAll(async ({ request }) => {
  // The API works some figures out from its own clock (the dashboard's This
  // month), so it has to be started at FROZEN_NOW too:
  // `AGENT_CLOCK=2026-11-01T08:00:00Z scripts/agent-servers.sh <name> start`.
  // Read from a sign-in token's issued-at, which the app stamps from its own
  // clock. (Not the Date header: Node's http layer keeps the real one.)
  const res = await request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  const body = await res.json();
  const token: string = (body.data ?? body).accessToken;
  const { iat } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const serverNow = iat * 1000;
  const ahead = serverNow - FROZEN_NOW.getTime();
  expect(
    ahead >= -1000 && ahead < 12 * 3600_000,
    `The API's clock reads ${new Date(serverNow).toISOString()}. Start it at ${FROZEN_NOW.toISOString()} ` +
      `(AGENT_CLOCK=${FROZEN_NOW.toISOString()} scripts/agent-servers.sh <name> start) and restart it every 12 hours.`,
  ).toBe(true);

  // Each column's near-now values become SEEDED_AT plus their rank in
  // milliseconds, not SEEDED_AT itself, so the seed's order survives. Rows the
  // seed wrote in the same millisecond (a createMany) are ranked by their
  // content with every uuid taken out: the app breaks such ties by id, ids
  // are random on each reseed, and "On this cycle: Fares and Abdallah" read
  // "Abdallah and Fares" on the next run (measured).
  psqlQuery(`
    DO $$
    DECLARE c record; win text;
    BEGIN
      FOR c IN
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
          AND data_type IN ('timestamp without time zone', 'timestamp with time zone', 'date')
      LOOP
        -- A day either side: the app writes a date column as Cairo's day, and
        -- current_date is the database's (UTC). Seeded at 00:30 in Cairo, a
        -- payment read Nov 3 against a current_date of Nov 2 and kept its real
        -- date, so This month's Collected dropped to 0 (CI run 41538122534).
        IF c.data_type = 'date' THEN
          EXECUTE format('UPDATE %I SET %I = %L::date WHERE %I BETWEEN current_date - 1 AND current_date + 1', c.table_name, c.column_name, '${SEEDED_AT}', c.column_name);
          CONTINUE;
        END IF;
        -- Prisma's DateTime is UTC wall time without a zone.
        win := CASE WHEN c.data_type = 'timestamp with time zone' THEN 'now()' ELSE '(now() AT TIME ZONE ''UTC'')' END;
        EXECUTE format(
          'UPDATE %1$I t SET %2$I = (%3$L::timestamptz %4$s) + r.n * interval ''1 millisecond''
             FROM (SELECT ctid AS id, row_number() OVER (ORDER BY %2$I, regexp_replace(to_jsonb(x)::text, ''[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'', '''', ''g'')) AS n FROM %1$I x
                   WHERE %2$I BETWEEN %5$s - interval ''6 hours'' AND %5$s + interval ''1 hour'') r
            WHERE t.ctid = r.id',
          c.table_name, c.column_name, '${SEEDED_AT}',
          CASE WHEN c.data_type = 'timestamp with time zone' THEN '' ELSE 'AT TIME ZONE ''UTC''' END, win);
      END LOOP;
    END $$;
  `);
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.addInitScript(() => {
    const style = () => {
      const s = document.createElement('style');
      s.textContent = [
        'nextjs-portal { display: none !important }',
        '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important }',
      ].join('\n');
      document.head.appendChild(s);
    };
    if (document.head) style();
    else document.addEventListener('DOMContentLoaded', style);
  });
});

/** Nothing loading, nothing pulsing, every font in. */
async function settled(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function snap(page: Page, name: string, opts: { mask?: Locator[]; target?: Locator } = {}) {
  await settled(page);
  // Playwright's default per-pixel threshold (0.2 in YIQ) let the primary
  // blue move from #2563eb to #1d4ed8 across every button without a single
  // failing pixel (measured). Same machine, same fonts: nothing legitimate
  // differs, so the comparison is near-exact.
  const options = { mask: opts.mask ?? [], threshold: PIXEL_THRESHOLD };
  if (opts.target) await expect(opts.target).toHaveScreenshot(`${name}.png`, options);
  else await expect(page).toHaveScreenshot(`${name}.png`, options);
}

for (const locale of LOCALES) {
  const m = messages(locale);

  test.describe(`office · ${locale}`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, locale);
    });

    test(`dashboard · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/dashboard`);
      await snap(page, `dashboard-${locale}`);
    });

    test(`analytics · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/analytics`);
      await snap(page, `analytics-${locale}`);
    });

    test(`sales list · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/sales?status=ALL`);
      await snap(page, `sales-${locale}`);
    });

    test(`sale detail dialog · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/sales?status=ALL`);
      await settled(page);
      await page.getByRole('main').getByRole('button', { name: m.common.view }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await snap(page, `sale-detail-${locale}`, { target: dialog });
    });

    test(`products · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/products`);
      await snap(page, `products-${locale}`);
    });

    test(`customers · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/customers`);
      await snap(page, `customers-${locale}`);
    });

    test(`cycles list · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/cycles`);
      await snap(page, `cycles-${locale}`);
    });

    test(`cycle detail · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/cycles`);
      await settled(page);
      await page.getByRole('main').getByRole('row').nth(1).click();
      await expect(page).toHaveURL(/\/cycles\/[^/?]+/);
      await snap(page, `cycle-detail-${locale}`);
    });

    test(`payments · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/payments`);
      await snap(page, `payments-${locale}`);
    });

    test(`ledger · ${locale}`, async ({ page }) => {
      await page.goto(`${BASE}/${locale}/ledger`);
      await snap(page, `ledger-${locale}`);
    });
  });
}
