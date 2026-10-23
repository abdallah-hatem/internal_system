/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a table's columns hold still, and its words fit them
 * ═══════════════════════════════════════════════════════════════════════
 *  The owner, 2026-10-15: the columns jumped when the data replaced the
 *  skeleton (a table sized to its content took one set of widths from the
 *  skeleton's bars and another from the real names and amounts), and a header
 *  title wrapped onto two lines in Arabic. Every table in the office now goes
 *  through one component (components/ui/data-table.tsx): fixed layout, one
 *  list of widths for the header, the skeleton and the rows, each column sized
 *  for its title in both languages.
 *
 *  For every list screen with a table, reached through the menu with the API
 *  held, in English and in Arabic at 1440px:
 *
 *  - TC-COL-01 every cell edge of the first skeleton row equals the first real
 *    row's — no column moves when the rows land;
 *  - TC-COL-02 every header title is on one line and its text fits inside its
 *    cell's padding — measured from the text, not from scrollWidth, which
 *    does not see a title running into its own padding;
 *  - TC-COL-03 nothing in a real cell runs outside its cell: a long name wraps
 *    or is cut inside it, money and dates fit; and the table fits its card, so
 *    no column is scrolled out of sight at 1440.
 *
 *  The tables that are not lists (an order's lines, an invoice, a statement,
 *  a cycle's goods and shipment, a settlement, the running costs, a lender's
 *  repayments, a plan's instalments, a product's batches) get TC-COL-02 and
 *  TC-COL-03 the same way (TC-COL-04); the invoice and the statement also fit
 *  A4 on paper with every column shown (TC-COL-05).
 *
 *  The fixtures build every row the way the business does — stock only
 *  through a cycle, a purchase and a verified receipt; a confirmed sale; a
 *  payment — with names long enough that a column that does not wrap or cut
 *  them shows it.
 *
 *  TABLE_SHOTS=1 also saves each list loading and loaded, at 1440, 1024 and
 *  390, in both languages, to .ui-audit/table-columns/ for looking at.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { aCorePartnerUser, apiCtx, daysAgo, owedOrder, stockedProduct } from './support/fixtures';
import { API } from './support/env';
import { login, messages, openCustomer, openNav, openView, type Locale } from './support/ui';
import { PAGE_VIEWS } from '../src/lib/page-views';
import { gateApi, go } from './support/gate';
import { recordCost, soldOutCycle } from './support/running-costs';

const stamp = Date.now().toString(36).toUpperCase();
/** Long enough to need two lines in its column, and to be cut after them. */
const LONG = `Heavy-duty front brake disc assembly for long-range touring motorcycles, left side ${stamp}`;
const SHOP = `Al-Mansoura Motorcycle Spare Parts Trading and Distribution Company ${stamp}`;
const SHOTS = process.env.TABLE_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/table-columns';

let orderNo = '';
let cycleCode = '';
let settledCode = '';

async function build(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const customer = await mk('customers', {
    displayName: SHOP,
    type: 'B2B',
    phone: '+201000000777',
    email: `purchasing.department.mansoura.${stamp.toLowerCase()}@example-trading-company.com`,
  });
  const { product, cycle } = await stockedProduct(request, headers, mk, LONG, 50);
  cycleCode = cycle.code;
  const order = await owedOrder(mk, customer.id, product.id, 123_456);
  orderNo = order.orderNo;
  // Put on the shop's orders, as Record payment does: a contract's plan is what the sale still owes (2026-10-17).
  await mk('payments', { customerId: customer.id, amount: 100_000, currency: 'EGP', method: 'BANK_TRANSFER', reference: `TRANSFER-REF-${stamp}-000123456789`, applyOldestFirst: true });
  await mk('providers', {
    name: `Gulf and Mediterranean International Shipping and Freight Forwarding ${stamp}`,
    contactPerson: 'Mohamed Abdel-Rahman El-Sayed',
    phone: '+971 50 123 4567',
    email: `operations.desk.${stamp.toLowerCase()}@gulf-mediterranean-freight.example.com`,
  });
  // A contract on the order: its plan is what the 23,456 still owed comes to
  // (123,456 less the 100,000 paid above), so it lists on Payments' Contracts.
  await mk(`sales/orders/${order.id}/contract-plan`, {
    instalments: [{ dueOn: daysAgo(-7), amount: 10_000, note: 'First of the agreed weekly instalments' }, { dueOn: daysAgo(-14), amount: 13_456 }],
  });
  // A friend who paid for part of the order, repaid once.
  const lender = await mk('lenders', { name: `Mahmoud Abdel-Aziz El-Shennawy, cousin of the Dubai supplier ${stamp}`, phone: '+971 55 765 4321' });
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const po = (full.data ?? full).purchaseOrders[0];
  const financing = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 300 });
  await mk(`lender-financings/${financing.id}/repayments`, { amountEgp: 120, rateToEgp: 1 });
  // A running cost, so the Partners page shows its table.
  await recordCost(request, headers, { amount: 12_345, category: 'rent' });
  // A sold-out cycle with a partner on it, its settlement worked out, so the
  // settlement's participants show.
  const partner = await aCorePartnerUser(request, headers);
  const sold = await soldOutCycle(request, `Settled ${LONG.slice(0, 40)}`, [[partner.id, 'CORE_PARTNER', 1000]]);
  await mk(`settlements/calculate/${sold.cycle.id}`, {});
  settledCode = sold.cycle.code;
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  await build(request);
});

// ─── Measuring ──────────────────────────────────────────────────────────

/** Header titles that wrap or run past their cell's padding, in every visible table. */
function headerProblems(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const table of document.querySelectorAll('main table, [role="dialog"] table')) {
      if (!(table as HTMLElement).offsetParent) continue;
      for (const th of table.querySelectorAll(':scope > thead th')) {
        const el = th as HTMLElement;
        if (!el.offsetParent || !el.textContent?.trim()) continue;
        // A title only a screen reader hears (an actions column's `sr-only`
        // "Actions") is never drawn, so it cannot wrap or overflow on screen;
        // measured, its text came out wider than the 1px box that holds it.
        const hidden = [...el.querySelectorAll('.sr-only')].map((n) => n.textContent ?? '').join('').trim();
        if (hidden && hidden === el.textContent.trim()) continue;
        const cs = getComputedStyle(el);
        const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const range = document.createRange();
        range.selectNodeContents(el);
        const text = range.getBoundingClientRect().width;
        const lines = Math.round((el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
        if (lines !== 1) out.push(`"${el.textContent}" wraps to ${lines} lines`);
        if (text > content + 0.5) out.push(`"${el.textContent}" is ${Math.ceil(text)}px in a ${content}px cell`);
      }
    }
    return out;
  });
}

/**
 * A table wider than its card at this width: it scrolls sideways, so the
 * columns at its far end are out of sight. At 1440 nothing may.
 */
function scrollProblems(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const table of document.querySelectorAll('main table, [role="dialog"] table')) {
      if (!(table as HTMLElement).offsetParent) continue;
      let box = table.parentElement;
      while (box && getComputedStyle(box).overflowX === 'visible') box = box.parentElement;
      if (box && box.scrollWidth > box.clientWidth + 1) {
        const first = table.querySelector('thead th')?.textContent ?? '';
        out.push(`the table starting "${first}" is ${box.scrollWidth}px in a ${box.clientWidth}px card`);
      }
    }
    return out;
  });
}

/**
 * Anything in a real row drawn outside its cell's padding. Text and boxes
 * inside something that clips (a cut label, a two-line name) are skipped —
 * the clipping box itself is measured.
 */
async function cellProblems(page: Page) {
  // Measured once nothing is moving: an expanded row's chevron turns with a CSS
  // transition, and mid-turn its box is a couple of pixels wider than the cell
  // ("" spills 2px, 2026-10-20), which no reader ever sees at rest.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  return page.evaluate(() => {
    const out: string[] = [];
    const clips = (el: Element) => {
      const o = getComputedStyle(el);
      return o.overflowX !== 'visible' || o.overflowY !== 'visible';
    };
    for (const table of document.querySelectorAll('main table, [role="dialog"] table')) {
      if (!(table as HTMLElement).offsetParent) continue;
      const rows = [...table.querySelectorAll(':scope > tbody > tr')].filter((r) => !r.closest('[data-skeleton]')).slice(0, 10);
      for (const tr of rows) {
        for (const td of tr.querySelectorAll(':scope > td')) {
          const cell = td as HTMLTableCellElement;
          if (!cell.offsetParent || cell.colSpan > 1) continue;
          const r = cell.getBoundingClientRect();
          const cs = getComputedStyle(cell);
          const left = r.left + parseFloat(cs.paddingLeft) - 1;
          const right = r.right - parseFloat(cs.paddingRight) + 1;
          const walk = (node: Node, clipped: boolean) => {
            for (const child of node.childNodes) {
              let box: DOMRect | null = null;
              if (child.nodeType === Node.TEXT_NODE) {
                if (clipped || !child.textContent?.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(child);
                box = range.getBoundingClientRect();
              } else if (child instanceof HTMLElement || child instanceof SVGElement) {
                const b = child.getBoundingClientRect();
                if (!clipped && b.width > 0) box = b;
              }
              if (box && box.width > 0 && (box.left < left || box.right > right)) {
                out.push(`"${(cell.textContent ?? '').trim().slice(0, 40)}" spills ${Math.round(Math.max(left - box.left, box.right - right))}px out of its cell`);
                return;
              }
              if (child instanceof Element) walk(child, clipped || clips(child));
            }
          };
          walk(cell, clips(cell));
        }
      }
    }
    return [...new Set(out)];
  });
}

/** Left and right of every cell in the first row matching `selector`, in the n-th visible table of main. */
function edgesOf(page: Page, tableIndex: number, selector: string) {
  return page.evaluate(
    ({ tableIndex, selector }) => {
      const tables = [...document.querySelectorAll('main table, [role="dialog"] table')].filter((t) => (t as HTMLElement).offsetParent);
      const row = tables[tableIndex]?.querySelector(selector);
      return row ? [...row.querySelectorAll(':scope > td')].map((td) => {
        const b = td.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.right)];
      }) : null;
    },
    { tableIndex, selector },
  );
}

/** Which visible table in main holds the skeleton rows. */
function skeletonTableIndex(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main table, [role="dialog"] table')]
      .filter((t) => (t as HTMLElement).offsetParent)
      .findIndex((t) => t.querySelector('tr[data-testid="skeleton-row"]')),
  );
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

// ─── The lists ──────────────────────────────────────────────────────────

type NavKey = keyof ReturnType<typeof messages>['nav'];
const LISTS: { name: string; nav: NavKey; columns: number }[] = [
  { name: 'Products', nav: 'products', columns: 8 },
  // On the shelf, At shops and All since samples (2026-10-18), with the expander and the product.
  // Seven since the always-zero Reserved column went (2026-10-19).
  { name: 'Inventory', nav: 'inventory', columns: 7 },
  { name: 'Sales', nav: 'sales', columns: 8 },
  { name: 'Customers', nav: 'customers', columns: 6 },
  // + By, who recorded the row (owner 2026-10-22).
  { name: 'Ledger', nav: 'ledger', columns: 8 },
  { name: 'Payments', nav: 'payments', columns: 8 },
  { name: 'Purchases', nav: 'purchases', columns: 8 },
  { name: 'Shipments', nav: 'shipments', columns: 9 },
  { name: 'Suppliers', nav: 'suppliers', columns: 5 },
  { name: 'Providers', nav: 'providers', columns: 5 },
  { name: 'Cycles', nav: 'cycles', columns: 8 },
  { name: 'Lenders', nav: 'lenders', columns: 4 },
  { name: 'Audit logs', nav: 'auditLogs', columns: 6 },
  { name: 'Analytics top products', nav: 'analytics', columns: 4 },
];

for (const locale of ['en', 'ar'] as const) {
  test.describe(`Table columns (${locale}, 1440px)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const [i, list] of LISTS.entries()) {
      const id = String(i + 1).padStart(2, '0');
      test(`TC-COL-01.${id} ${list.name}: no column moves when the rows land, and every title and cell fits (${locale})`, async ({ page }) => {
        const m = messages(locale);
        const gate = await gateApi(page);
        await login(page, locale);
        gate.hold();
        // Purchases, shipments, providers and the audit log are tabs since
        // 2026-10-18: their page from the menu, then the tab.
        const view = Object.values(PAGE_VIEWS).flatMap((v) => v.slice(1) as readonly { slug: string; navKey: string }[]).find((v) => v.navKey === list.nav);
        if (view) await openView(page, view.slug, locale);
        else await openNav(page, m.nav[list.nav] as string);
        await expect(page.locator('main table tr[data-testid="skeleton-row"]').filter({ visible: true }).first()).toBeVisible();
        const index = await skeletonTableIndex(page);
        expect(index).toBeGreaterThanOrEqual(0);
        const before = await edgesOf(page, index, 'tr[data-testid="skeleton-row"]');
        expect(before?.length, 'skeleton cells, one per column').toBe(list.columns);
        const ths = await page.evaluate((i) => [...document.querySelectorAll('main table, [role="dialog"] table')].filter((t) => (t as HTMLElement).offsetParent)[i].querySelectorAll('thead th').length, index);
        expect(ths, 'header cells').toBe(list.columns);
        // Titles are the real ones while loading: they must fit already.
        expect(await headerProblems(page), 'TC-COL-02 while loading').toEqual([]);
        await shot(page, `${list.nav}-${locale}-1440-loading`);

        gate.release();
        await expect(page.locator('main tr[data-testid="skeleton-row"]')).toHaveCount(0);
        await expect
          .poll(() => edgesOf(page, index, ':scope > tbody > tr:not([data-skeleton] tr)'), { message: 'TC-COL-01: the first real row lands in the skeleton\'s columns' })
          .toEqual(before);
        expect(await headerProblems(page), 'TC-COL-02').toEqual([]);
        expect(await cellProblems(page), 'TC-COL-03').toEqual([]);
        expect(await scrollProblems(page), 'TC-COL-03: the whole table in sight at 1440').toEqual([]);
        await shot(page, `${list.nav}-${locale}-1440-loaded`);
      });
    }
  });
}

// ─── The tables that are not lists ──────────────────────────────────────

const DETAILS: { name: string; open: (page: Page, locale: Locale) => Promise<void> }[] = [
  {
    name: "an order's lines",
    open: async (page, locale) => {
      const m = messages(locale);
      await openNav(page, m.nav.sales);
      await page.getByPlaceholder(m.sales.search).fill(orderNo);
      await page.getByTestId('sale-row').filter({ hasText: orderNo }).locator('td').nth(6).click();
      await expect(page.getByRole('heading', { name: orderNo })).toBeVisible();
    },
  },
  {
    name: 'the invoice',
    open: async (page, locale) => {
      const m = messages(locale);
      await openNav(page, m.nav.sales);
      await page.getByPlaceholder(m.sales.search).fill(orderNo);
      await page.getByTestId('sale-row').filter({ hasText: orderNo }).locator('td').nth(6).click();
      await page.getByTestId('order-invoice').click();
      await expect(page.getByTestId('invoice-line').first()).toBeVisible();
    },
  },
  {
    name: "a shop's statement",
    open: async (page, locale) => {
      await openCustomer(page, SHOP, locale);
      await expect(page.getByTestId('statement-row').first()).toBeVisible();
    },
  },
  {
    name: "a purchase order's lines",
    open: async (page, locale) => {
      const m = messages(locale);
      await openView(page, 'purchases', locale);
      await page.getByPlaceholder(m.purchases.search).fill(cycleCode);
      await page.getByRole('main').locator('tr', { hasText: cycleCode }).getByRole('button', { name: m.common.view }).click();
      await expect(page.getByRole('dialog').locator('table')).toBeVisible();
    },
  },
  {
    name: "a product's batches",
    open: async (page, locale) => {
      const m = messages(locale);
      await openNav(page, m.nav.inventory);
      await page.getByPlaceholder(m.inventory.search).fill(stamp);
      await page.getByTestId('inventory-row').first().locator('td').first().click();
      await expect(page.locator('main table table')).toBeVisible();
    },
  },
  {
    name: "a cycle's goods and shipment",
    open: async (page, locale) => {
      const m = messages(locale);
      await openNav(page, m.nav.cycles);
      await page.getByPlaceholder(m.cycles.search).fill(cycleCode);
      await page.getByTestId('cycle-row').filter({ hasText: cycleCode }).locator('td').first().click();
      await expect(page.getByTestId('location-table')).toBeVisible();
      // A finished leg starts folded (2026-10-18): open each, as a person would to see its lines.
      await expect(page.getByTestId('leg-toggle').first()).toBeVisible();
      for (const toggle of await page.locator('[data-testid="leg-toggle"][aria-expanded="false"]').all()) await toggle.click();
      await expect(page.getByTestId('shipment-line').filter({ visible: true }).first()).toBeVisible();
    },
  },
  {
    name: "a settlement's participants",
    open: async (page, locale) => {
      await openView(page, 'settlements', locale);
      const card = page.locator(`[data-testid="settlement-card"][data-cycle="${settledCode}"]`);
      await expect(card.locator('table')).toBeVisible();
    },
  },
  {
    name: 'the running costs',
    open: async (page, locale) => {
      await openNav(page, messages(locale).nav.partners);
      await expect(page.getByTestId('running-costs-partners')).toBeVisible();
    },
  },
  {
    name: "a lender's repayments",
    open: async (page, locale) => {
      const m = messages(locale);
      await openNav(page, m.nav.lenders);
      await page.getByPlaceholder(m.lenders.search).fill(stamp);
      await page.getByTestId('lender-row').first().getByRole('link').first().click();
      await expect(page.getByTestId('repayment-row').first()).toBeVisible();
    },
  },
  {
    name: 'the contracts',
    open: async (page, locale) => {
      // Contracts are the second tab of Payments (2026-10-16; Instalment plans until 2026-10-17).
      await openNav(page, messages(locale).nav.payments);
      await page.getByTestId('tab-contracts').click();
      await expect(page.getByTestId('contract-row').filter({ hasText: orderNo }).first()).toBeVisible();
    },
  },
];

for (const locale of ['en', 'ar'] as const) {
  test.describe(`Detail tables (${locale}, 1440px)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    for (const [i, detail] of DETAILS.entries()) {
      test(`TC-COL-04.${String(i + 1).padStart(2, '0')} ${detail.name}: every title on one line and every cell inside its column (${locale})`, async ({ page }) => {
        await login(page, locale);
        await detail.open(page, locale);
        expect(await headerProblems(page), 'TC-COL-02').toEqual([]);
        expect(await cellProblems(page), 'TC-COL-03').toEqual([]);
        expect(await scrollProblems(page), 'TC-COL-03: the whole table in sight at 1440').toEqual([]);
        await shot(page, `detail-${i + 1}-${locale}-1440`);
      });
    }
  });
}

// ─── On paper ───────────────────────────────────────────────────────────

/**
 * The invoice and the statement print on A4 (globals.css: 12mm margins, so
 * 186mm — 703px — across). A fixed-width table wider than that would be cut
 * at the paper's edge, so on paper every column must be shown and the table
 * must fit: TC-COL-05.
 */
const PAPER = [
  {
    name: 'the invoice',
    table: 'invoice-lines',
    open: (page: Page, locale: Locale) => DETAILS[1].open(page, locale),
  },
  {
    name: "a shop's statement",
    table: 'statement-table',
    open: (page: Page, locale: Locale) => DETAILS[2].open(page, locale),
  },
];

for (const locale of ['en', 'ar'] as const) {
  for (const doc of PAPER) {
    test(`TC-COL-05 ${doc.name} fits A4 with every column, on paper (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, locale);
      await doc.open(page, locale);
      await page.emulateMedia({ media: 'print' });
      await page.setViewportSize({ width: 703, height: 1000 });
      const fit = await page.getByTestId(doc.table).evaluate((t) => {
        let box = t.parentElement!;
        while (getComputedStyle(box).overflowX === 'visible' && box.parentElement) box = box.parentElement;
        const off = [...t.querySelectorAll('thead th')].filter((th) => getComputedStyle(th).display === 'none');
        return {
          // A screen-only column (the statement's Profit, owner 2026-10-23) is
          // meant to stay off paper; every other one prints.
          hidden: off.filter((th) => !th.className.includes('print:hidden')).length,
          screenOnly: off.map((th) => th.textContent?.trim()),
          width: Math.round(t.getBoundingClientRect().width),
          room: box.clientWidth,
          scroll: box.scrollWidth,
        };
      });
      expect(fit.hidden, 'every column printed').toBe(0);
      if (doc.table === 'statement-table') {
        // The shop may get the paper: its Profit never prints.
        expect(fit.screenOnly).toEqual([messages(locale).customers.statement.profit]);
      }
      expect(fit.scroll, `table ${fit.width}px on ${fit.room}px of paper`).toBeLessThanOrEqual(fit.room + 1);
      expect(await cellProblems(page), 'TC-COL-03 on paper').toEqual([]);
      await shot(page, `print-${doc.table}-${locale}`);
    });
  }
}

// ─── Screenshots at the other widths, for looking at ────────────────────

if (SHOTS) {
  for (const width of [1024, 390]) {
    for (const locale of ['en', 'ar'] as const) {
      test(`TC-COL-90 screenshots at ${width}px (${locale})`, async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width, height: 900 });
        // next dev's badge sits over the phone bar's corner (spec 54).
        await page.addInitScript(() => {
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = 'nextjs-portal { display: none !important }';
            document.head.appendChild(style);
          });
        });
        const m = messages(locale);
        const gate = await gateApi(page);
        await login(page, locale);
        for (const list of LISTS) {
          // A fresh load, so no list arrives from another screen's cache.
          await page.goto(`${page.url().replace(/\/[^/]+$/, '')}/dashboard`);
          await expect(page.getByTestId('skeleton')).toHaveCount(0, { timeout: 15000 });
          gate.hold();
          await go(page, m.nav[list.nav] as string, locale);
          await expect(page.getByTestId('skeleton').filter({ visible: true }).first()).toBeVisible();
          await page.waitForTimeout(300);
          await shot(page, `${list.nav}-${locale}-${width}-loading`);
          gate.release();
          await expect(page.getByTestId('skeleton')).toHaveCount(0);
          await shot(page, `${list.nav}-${locale}-${width}-loaded`);
        }
        if (width === 1024) {
          expect(await headerProblems(page), 'TC-COL-02 at 1024').toEqual([]);
        }
      });
    }
  }
}
