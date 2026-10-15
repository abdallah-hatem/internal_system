/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A screen that is loading shows the shape of what is coming
 * ═══════════════════════════════════════════════════════════════════════
 *  The owner, 2026-10-15: "loading a table is just a loader with Loading
 *  text, it needs to be a table skeleton as said in the skill."
 *
 *  Every list and detail screen showed a spinner and the word "Loading..."
 *  where its rows would be, so the page jumped from a short line to a full
 *  table when the data came. Each now renders a skeleton traced from its own
 *  rows (components/ui/skeleton.tsx), and this proves it the way a person
 *  sees it, at a desktop width and a phone width:
 *
 *  - while the API is held, a skeleton is on screen (`data-testid=skeleton`)
 *    and "Loading..." is not — it is only the 1px line a screen reader reads;
 *  - there are as many skeleton rows as a page of real rows (PAGE_SIZE, 10);
 *  - when the data arrives, the real row that lands where the first skeleton
 *    row was is the same height, within 2px — so nothing below it moves;
 *  - data already on screen stays on screen while it refreshes: typing in a
 *    search, or coming back to a list, never brings the skeleton back.
 *
 *  The API is held with `page.route` rather than slowed by a timer, so the
 *  skeleton is asserted while it is certainly there and the real rows after
 *  they certainly arrived. Screens are reached through the menu like a person
 *  (LEARNINGS 2026-10-11); only the login page is opened by address.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { login, messages, openNav } from './support/ui';

const m = messages('en');
const PAGE_SIZE = 10;
/**
 * The skeleton rows a detail screen or the dashboard holds: the sum of its
 * sections' `repeat(n, …RowSkeleton)` — the tiles, lists and tables each
 * section normally shows. A list screen holds a page, PAGE_SIZE.
 * - Dashboard: figure tiles, the attention list, top products, your cycles and
 *   recent activity (dashboard/page.tsx, components/dashboard/*);
 * - a customer: three rows each in Sales Orders and Payments, two plan rows,
 *   and the statement's lines on this width (customers/[id], customer-statement);
 * - a cycle: the place cards of Where the goods are (four: the fixture is a
 *   UAE-direct cycle, which the list it is opened from knows), three rows each in
 *   Participants, Purchases and Inventory, and the
 *   Shipment panel's two product lines (cycles/[cycleId]/details, ShipmentPanel).
 */
const DASHBOARD_ROWS = 28;
const CUSTOMER_ROWS = 10;
const CYCLE_ROWS = 15;
const stamp = Date.now().toString(36).toUpperCase();
const CUSTOMER = `Skeleton Shop ${stamp}`;

let cycleCode = '';

test.beforeAll(async ({ request }) => {
  // Real rows for every screen below, built the way the business makes them:
  // stock only through a cycle, a purchase order, a leg and a verified
  // receipt; a sale that is confirmed, so it is owed; a payment against it.
  const { headers, mk } = await apiCtx(request);
  const customer = await mk('customers', { displayName: CUSTOMER, type: 'B2B' });
  const { product, cycle } = await stockedProduct(request, headers, mk, `Skeleton ${stamp}`, 20);
  await owedOrder(mk, customer.id, product.id, 1_000);
  await mk('payments', { customerId: customer.id, amount: 400, currency: 'EGP', method: 'CASH' });
  cycleCode = cycle.code;
});

/** Holds every GET to the API until released; logins and saves pass. */
async function gateApi(page: Page) {
  let open: () => void = () => {};
  let gate = Promise.resolve();
  let holding = false;
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    if (holding && req.method() === 'GET' && !/\/auth\//.test(req.url())) await gate;
    await route.continue().catch(() => {});
  });
  return {
    hold() {
      holding = true;
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      holding = false;
      open();
    },
  };
}

/**
 * Through the menu, as a person does: the sidebar on a desktop; on a phone
 * the bottom bar, or More and the drawer for a screen the bar does not hold
 * (spec 74).
 */
async function go(page: Page, label: string) {
  if ((page.viewportSize()?.width ?? 1440) >= 768) return openNav(page, label);
  const bar = page.getByTestId('phone-bar');
  let link = bar.getByRole('link', { name: label, exact: true });
  if ((await link.count()) === 0) {
    await bar.getByRole('button', { name: m.nav.more }).click();
    link = page.locator('aside').getByRole('link', { name: label, exact: true });
  }
  const href = await link.getAttribute('href');
  await link.click();
  if (href) await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { timeout: 15000 });
}

const skeletons = (page: Page) => page.getByTestId('skeleton').filter({ visible: true });
const skeletonRows = (page: Page) => page.getByTestId('skeleton-row').filter({ visible: true });

/** The skeleton is up, "Loading..." is not content, and it has `rows` rows. Returns the first row's box. */
async function expectSkeleton(page: Page, rows: number) {
  await expect(skeletons(page).first()).toBeVisible();
  // Anything carrying the word is the visually hidden status line (1×1px).
  const areas = await page
    .getByRole('main')
    .getByText(m.common.loading, { exact: true })
    .evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    }));
  expect(areas.every((a) => a <= 1), `"${m.common.loading}" is on screen as content`).toBe(true);
  await expect(skeletonRows(page)).toHaveCount(rows);
  const box = await skeletonRows(page).first().boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/**
 * After the data lands: the element now where the first skeleton row was —
 * same top, same width, so a row that moved does not count — and its height.
 * Of the elements that fit (a row and its table body can share a top), the
 * one closest in height. -1 when nothing is there: the layout moved.
 */
function realHeightAt(page: Page, box: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(({ x, y, width, height }) => {
    let el = document.elementFromPoint(x + 6, y + 6);
    const found: number[] = [];
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.width - width) < 4 && Math.abs(r.top - y) < 4) found.push(r.height);
      el = el.parentElement;
    }
    found.sort((a, b) => Math.abs(a - height) - Math.abs(b - height));
    return found[0] ?? -1;
  }, box);
}

async function expectSameHeight(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await realHeightAt(page, box)) - box.height), {
      message: `skeleton row ${box.height}px tall; the real row that landed in its place differs (or nothing landed there)`,
    })
    .toBeLessThanOrEqual(2);
}

interface Screen {
  name: string;
  /** Rows a skeleton of this screen holds. */
  rows: number;
  /** From the dashboard, get the held screen on its way. */
  open: (page: Page, gate: Awaited<ReturnType<typeof gateApi>>) => Promise<void>;
}

const viaNav = (label: string): Screen['open'] => async (page, gate) => {
  gate.hold();
  await go(page, label);
};

const SCREENS: Screen[] = [
  { name: 'Products', rows: PAGE_SIZE, open: viaNav(m.nav.products) },
  { name: 'Categories', rows: PAGE_SIZE, open: viaNav(m.nav.categories) },
  { name: 'Inventory', rows: PAGE_SIZE, open: viaNav(m.nav.inventory) },
  { name: 'Sales', rows: PAGE_SIZE, open: viaNav(m.nav.sales) },
  { name: 'Customers', rows: PAGE_SIZE, open: viaNav(m.nav.customers) },
  { name: 'Ledger', rows: PAGE_SIZE, open: viaNav(m.nav.ledger) },
  {
    name: 'a customer',
    rows: CUSTOMER_ROWS,
    open: async (page, gate) => {
      await go(page, m.nav.customers);
      const main = page.getByRole('main');
      await main.getByPlaceholder(m.customers.search).fill(CUSTOMER);
      const link = main.getByRole('link', { name: CUSTOMER, exact: true }).filter({ visible: true }).first();
      await expect(link).toBeVisible();
      gate.hold();
      await link.click();
      await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    },
  },
  {
    name: 'a cycle',
    rows: CYCLE_ROWS,
    open: async (page, gate) => {
      await go(page, m.nav.cycles);
      const main = page.getByRole('main');
      await main.getByPlaceholder(m.cycles.search).fill(cycleCode);
      const desktop = main.locator('tr', { hasText: cycleCode }).getByTestId('cycle-details');
      const target = (await desktop.isVisible()) ? desktop : main.getByText(cycleCode, { exact: true }).filter({ visible: true }).first();
      await expect(target).toBeVisible();
      gate.hold();
      await target.click();
      await expect(page).toHaveURL(/\/cycles\/[^/]+\/details$/);
    },
  },
];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Skeletons at ${viewport.width}px`, () => {
    test.use({ viewport });

    test(`TC-SKEL-01 the Dashboard shows its skeleton, not "Loading", at ${viewport.width}px`, async ({ page }) => {
      const gate = await gateApi(page);
      gate.hold();
      await login(page);
      const box = await expectSkeleton(page, DASHBOARD_ROWS);
      gate.release();
      await expectSameHeight(page, box);
    });

    for (const [i, screen] of SCREENS.entries()) {
      test(`TC-SKEL-${String(i + 2).padStart(2, '0')} ${screen.name} shows a traced skeleton at ${viewport.width}px`, async ({ page }) => {
        const gate = await gateApi(page);
        await login(page);
        await screen.open(page, gate);
        const box = await expectSkeleton(page, screen.rows);
        gate.release();
        await expectSameHeight(page, box);
      });
    }

    test(`TC-SKEL-20 a list already on screen never goes back to skeletons at ${viewport.width}px`, async ({ page }) => {
      const gate = await gateApi(page);
      await login(page);
      gate.hold();
      await go(page, m.nav.products);
      await expectSkeleton(page, PAGE_SIZE);
      gate.release();
      const main = page.getByRole('main');
      await expect(page.getByTestId('skeleton')).toHaveCount(0);

      // Typing in the search while anything it asks for is held.
      gate.hold();
      await main.getByPlaceholder(m.products.search).pressSequentially('Skeleton', { delay: 30 });
      await page.waitForTimeout(800);
      await expect(page.getByTestId('skeleton')).toHaveCount(0);
      await expect(main.getByText(`Skeleton ${stamp} Part`).filter({ visible: true }).first()).toBeVisible();
      gate.release();

      // Away and back: the cached list is shown at once while it refreshes.
      await go(page, m.nav.categories);
      await expect(page.getByTestId('skeleton')).toHaveCount(0);
      gate.hold();
      await go(page, m.nav.products);
      await expect(main.getByPlaceholder(m.products.search)).toBeVisible();
      await page.waitForTimeout(800);
      await expect(page.getByTestId('skeleton')).toHaveCount(0);
      gate.release();
    });
  });
}
