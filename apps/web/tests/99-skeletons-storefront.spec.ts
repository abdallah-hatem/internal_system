/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The storefront loading shows the shape of what is coming
 * ═══════════════════════════════════════════════════════════════════════
 *  The office half is 99-skeletons.spec.ts (owner, 2026-10-15: "it needs to
 *  be a table skeleton as said in the skill"). The catalogue and a product
 *  page used to say "جارٍ التحميل…" where the cards and the product would be.
 *  They render a skeleton traced from the real card and page now, and here,
 *  on the phone this app is for and at a desktop width:
 *
 *  - while the API is held, the skeleton is up and the word is not on screen;
 *  - the catalogue's skeleton holds a page of cards (PAGE_SIZE, 24);
 *  - when the data lands, the card (or the product photo) in the first
 *    skeleton's place is the same height, within 2px;
 *  - typing in the search after the cards are up keeps them — dimmed — and
 *    never brings the skeleton back.
 *
 *  The catalogue is sorted by name, so the two products made here start with
 *  "Aaaa" and are the first row. Their names are a real part's length: two
 *  lines in a phone's two columns, one in the wider grid — as the skeleton
 *  card assumes.
 */
import { test, expect, type Page } from '@playwright/test';
import { apiCtx } from './support/fixtures';

const PAGE_SIZE = 24;
const LOADING = 'جارٍ التحميل…';
const stamp = () =>
  Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const run = stamp();
const NAMES = [`Aaaa ${run} rear pad CB150R`, `Aaab ${run} front pad CB150R`];
let firstSku = '';

test.beforeAll(async ({ request }) => {
  const { mk } = await apiCtx(request);
  // A part in a category, as every part in the catalogue is: the card names it above the part.
  const category = await mk('categories', { name: `Skeleton ${run} Brakes` });
  for (const [i, name] of NAMES.entries()) {
    const product = await mk('products', { name, minStock: 0, categoryId: category.id });
    await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 300 + i });
    if (i === 0) firstSku = product.sku;
  }
});

test.beforeEach(async ({ page }) => {
  // The dev overlay sits over the bottom bar on a phone (spec 54).
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important }';
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
});

/** Holds every GET to the API until released. */
async function gateApi(page: Page) {
  let open: () => void = () => {};
  let gate = Promise.resolve();
  let holding = false;
  await page.route(/\/api\/v1\//, async (route) => {
    if (holding && route.request().method() === 'GET') await gate;
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

const skeletonRows = (page: Page) => page.getByTestId('skeleton-row').filter({ visible: true });

async function expectSkeleton(page: Page, rows: number) {
  await expect(page.getByTestId('skeleton').filter({ visible: true }).first()).toBeVisible();
  const areas = await page.getByText(LOADING, { exact: true }).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    }),
  );
  expect(areas.every((a) => a <= 1), `"${LOADING}" is on screen as content`).toBe(true);
  await expect(skeletonRows(page)).toHaveCount(rows);
  return (await skeletonRows(page).first().boundingBox())!;
}

/** What landed where the first skeleton was: same top and width, closest height. */
async function expectSameHeight(page: Page, box: { x: number; y: number; width: number; height: number }) {
  await expect(page.getByTestId('skeleton')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        Math.abs(
          (await page.evaluate(({ x, y, width, height }) => {
            let el = document.elementFromPoint(x + 6, y + 6);
            const found: number[] = [];
            while (el && el !== document.body) {
              const r = el.getBoundingClientRect();
              if (Math.abs(r.width - width) < 4 && Math.abs(r.top - y) < 4) found.push(r.height);
              el = el.parentElement;
            }
            found.sort((a, b) => Math.abs(a - height) - Math.abs(b - height));
            return found[0] ?? -1;
          }, box)) - box.height,
        ),
      { message: `skeleton ${box.height}px tall; what landed in its place differs (or nothing did)` },
    )
    .toBeLessThanOrEqual(2);
}

for (const viewport of [null, { width: 1440, height: 900 }]) {
  const at = viewport ? `${viewport.width}px` : 'a phone';
  test.describe(`Storefront skeletons on ${at}`, () => {
    if (viewport) test.use({ viewport });

    test(`TC-SKEL-STORE-01 the catalogue shows a page of skeleton cards, then cards of the same height, on ${at}`, async ({ page }) => {
      const gate = await gateApi(page);
      gate.hold();
      await page.goto('/ar');
      const box = await expectSkeleton(page, PAGE_SIZE);
      gate.release();
      await expect(page.locator(`[data-sku="${firstSku}"]`)).toBeVisible();
      await expectSameHeight(page, box);
    });

    test(`TC-SKEL-STORE-02 a product page shows its skeleton, then the photo where it was, on ${at}`, async ({ page }) => {
      const gate = await gateApi(page);
      await page.goto('/ar');
      const card = page.locator(`[data-sku="${firstSku}"]`);
      await expect(card).toBeVisible();
      gate.hold();
      await card.click();
      await expect(page).toHaveURL(/\/p\//);
      const box = await expectSkeleton(page, 1);
      gate.release();
      await expect(page.getByRole('heading', { name: NAMES[0] })).toBeVisible();
      await expectSameHeight(page, box);
    });

    test(`TC-SKEL-STORE-03 searching the cards already up keeps them, never the skeleton, on ${at}`, async ({ page }) => {
      const gate = await gateApi(page);
      gate.hold();
      await page.goto('/ar');
      await expectSkeleton(page, PAGE_SIZE);
      gate.release();
      await expect(page.locator(`[data-sku="${firstSku}"]`)).toBeVisible();

      gate.hold();
      await page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود').pressSequentially(run, { delay: 30 });
      // The debounced search has gone out and is held: the old cards stay.
      await page.waitForTimeout(1000);
      await expect(page.getByTestId('skeleton')).toHaveCount(0);
      await expect(page.locator(`[data-sku="${firstSku}"]`)).toBeVisible();
      gate.release();
      await expect(page.locator('[data-sku]')).toHaveCount(2);
    });
  });
}
