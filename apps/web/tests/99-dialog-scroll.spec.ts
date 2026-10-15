/**
 * A dialog scrolls its body, not its card (owner, 2026-10-15).
 *
 * The New Product dialog scrolled as a whole: its bar ran down the card's
 * rounded right edge and past the bottom corner, a grey platform track, and
 * Cancel and Create scrolled away with the form. Every dialog was written by
 * hand, so each had its own version of that. They now all come from
 * `components/ui/dialog.tsx`, and this holds the rules it promises
 * (building-frontends, "Scrollbars" and "Modals"):
 *
 *  - the body is the only thing that scrolls — the card does not;
 *  - the body is inset from the card's sides (4px or more, in English and in
 *    Arabic, where the bar moves to the left) and its corners sit inside the
 *    card's rounded border, so the bar can never be drawn on it;
 *  - scrolled to the bottom, the title and the primary action are still on
 *    screen;
 *  - the bar is the thin `scrollbar-clean` one, not the platform's;
 *  - the page behind does not move while the dialog scrolls.
 *
 * Each rule is a soft assertion, so one failing run names every rule a dialog
 * breaks rather than only the first.
 *
 * Six dialogs, each reached by clicking as a person does, at a desktop and a
 * phone width, in both languages. Where a short form fits the screen, the test
 * stands in for a long one — a long Arabic note, a dozen lines — by adding
 * height to its body: what is checked is what the dialog does when its
 * content is taller than the screen, and every real form gets there on a
 * small enough phone.
 */
import { test, expect, type ElementHandle, type Locator, type Page } from '@playwright/test';
import { login, messages, type Locale } from './support/ui';
import { go } from './support/gate';

type Opener = {
  name: string;
  /** The screenshot's file name. */
  slug: string;
  /** Opens the dialog from the dashboard and returns its card (role=dialog). */
  open: (page: Page, locale: Locale) => Promise<Locator>;
  /** The button that saves, by its visible name. */
  primary: (locale: Locale) => string;
};

/**
 * `next dev` mounts `<nextjs-portal>` over the bottom-left corner — under
 * Arabic, exactly where "More" sits on the phone bar. Hidden rather than
 * clicked through with `force` (as 99-logout and 54-storefront do).
 */
test.beforeEach(async ({ page }) => {
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

/**
 * The dialog's card: its `role="dialog"` element. Before the shared dialog the
 * page dialogs carried no role, so their card — the rounded box straight
 * inside the fixed layer — is matched too; that is how this spec was shown to
 * fail on the code it replaced, for the reasons it checks rather than for a
 * missing attribute.
 */
const card = (page: Page) => page.locator('[role="dialog"], .fixed.inset-0 > .rounded-2xl').last();
const cardIn = (layer: Locator) => layer.locator(':scope [role="dialog"], :scope > .rounded-2xl').last();

async function clickCreate(page: Page, label: string) {
  await page.getByRole('main').getByRole('button', { name: label }).filter({ visible: true }).first().click();
}

const OPENERS: Opener[] = [
  {
    name: 'new product',
    slug: 'new-product',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.products, locale);
      await clickCreate(page, m.products.create);
      return card(page);
    },
    primary: (l) => messages(l).common.create,
  },
  {
    name: 'quick-create category (nested in new product)',
    slug: 'quick-create-category',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.products, locale);
      await clickCreate(page, m.products.create);
      await page.locator('[data-quick-create="category"]').first().click();
      const inner = cardIn(page.locator('[data-quick-create-dialog="category"]'));
      await expect(inner).toBeVisible();
      return inner;
    },
    primary: (l) => messages(l).common.create,
  },
  {
    name: 'new sale',
    slug: 'new-sale',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.sales, locale);
      await clickCreate(page, m.sales.create);
      return card(page);
    },
    primary: (l) => messages(l).sales.createAndConfirm,
  },
  {
    name: 'record payment',
    slug: 'record-payment',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.payments, locale);
      await clickCreate(page, m.payments.create);
      return cardIn(page.locator('[data-record-payment-dialog]'));
    },
    primary: (l) => messages(l).common.save,
  },
  {
    name: 'ledger entry',
    slug: 'ledger-entry',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.ledger, locale);
      await clickCreate(page, m.ledger.create);
      return cardIn(page.locator('[data-ledger-entry-dialog]'));
    },
    primary: (l) => messages(l).common.save,
  },
  {
    name: 'add lender',
    slug: 'add-lender',
    async open(page, locale) {
      const m = messages(locale);
      await go(page, m.nav.lenders, locale);
      await clickCreate(page, m.lenders.create);
      return card(page);
    },
    primary: (l) => messages(l).common.create,
  },
];

const SHOTS = process.env.DIALOG_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/dialogs';
// Playwright's Chromium hides scrollbars by default; a picture of where the bar
// sits needs it drawn.
if (SHOTS) test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 700 },
  { name: 'phone', width: 390, height: 700 },
];

/** True when (x, y) lies inside a box whose corners are rounded by `r`. */
function insideRounded(x: number, y: number, b: { x: number; y: number; width: number; height: number }, r: number) {
  const left = b.x;
  const right = b.x + b.width;
  const top = b.y;
  const bottom = b.y + b.height;
  if (x < left - 0.5 || x > right + 0.5 || y < top - 0.5 || y > bottom + 0.5) return false;
  const cx = x < left + r ? left + r : x > right - r ? right - r : x;
  const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
  return Math.hypot(x - cx, y - cy) <= r + 0.5;
}

for (const locale of ['en', 'ar'] as const) {
  for (const vp of VIEWPORTS) {
    test.describe(`dialogs scroll their body — ${locale}, ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      for (const [i, opener] of OPENERS.entries()) {
        test(`TC-DLG-${String(i + 1).padStart(2, '0')} ${opener.name} (${locale}, ${vp.width}×${vp.height})`, async ({ page }) => {
          await login(page, locale);

          const dialog = await opener.open(page, locale);
          await expect(dialog).toBeVisible({ timeout: 15000 });
          const title = dialog.getByRole('heading', { level: 2 }).first();
          await expect(title).toBeVisible();

          // The page behind: made long enough to scroll, and scrolled a little,
          // so "it did not move" means something.
          const behind = await page.evaluate(() => {
            const main = document.querySelector('main')!;
            const pad = document.createElement('div');
            pad.setAttribute('data-test-pad', '');
            pad.style.height = '3000px';
            main.appendChild(pad);
            main.scrollTop = 120;
            return { main: main.scrollTop, window: window.scrollY };
          });

          // The scroll region: the descendant of the card that scrolls. Found by
          // what scrolls rather than by a class, so the test asks the question
          // the owner asked — not whether some element carries a name.
          const handle = await dialog.evaluateHandle((cardEl) => {
            const scrollers = [cardEl, ...Array.from(cardEl.querySelectorAll<HTMLElement>('*'))].filter((el) => {
              const s = getComputedStyle(el);
              return /(auto|scroll)/.test(s.overflowY) && el.tagName !== 'TEXTAREA';
            });
            return (scrollers[0] as HTMLElement | undefined) ?? null;
          });
          const body = handle.asElement() as ElementHandle<HTMLElement> | null;
          expect(body, 'the dialog has a scroll region').not.toBeNull();

          // DIALOG_SHOTS=1: the dialog as it really is, its own content
          // scrolled halfway, for a person to look at (.ui-audit is git-ignored).
          if (SHOTS) {
            await body!.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
            await page.screenshot({ path: `${SHOT_DIR}/${opener.slug}-${locale}-${vp.width}.png` });
          }

          // Long content: if the form fits the screen, give it more.
          await body!.evaluate((el) => {
            if (el.scrollHeight <= el.clientHeight + 1) {
              const pad = document.createElement('div');
              pad.setAttribute('data-test-pad', '');
              pad.style.height = '1200px';
              el.appendChild(pad);
            }
          });

          const facts = await dialog.evaluate((cardEl, bodyEl) => {
            const b = bodyEl as HTMLElement;
            const c = cardEl as HTMLElement;
            const cs = getComputedStyle(c);
            return {
              bodyOverflows: b.scrollHeight > b.clientHeight + 1,
              bodyIsCard: b === c,
              cardScrolls: /(auto|scroll)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight + 1,
              scrollbarWidth: getComputedStyle(b).scrollbarWidth,
              radius: parseFloat(cs.borderTopLeftRadius) || 0,
            };
          }, body);
          expect(facts.bodyOverflows, 'the content is taller than the dialog').toBe(true);
          expect.soft(facts.bodyIsCard, 'the card itself is not the scroll region').toBe(false);
          expect.soft(facts.cardScrolls, 'the card does not scroll').toBe(false);
          expect.soft(facts.scrollbarWidth, 'scrollbar-clean: a thin bar, not the platform one').toBe('thin');

          // Inset from both sides, whichever side the bar is on (it moves to
          // the left in Arabic), and every corner inside the rounded border.
          const cardBox = (await dialog.boundingBox())!;
          const bodyBox = (await body!.boundingBox())!;
          const startGap = bodyBox.x - cardBox.x;
          const endGap = cardBox.x + cardBox.width - (bodyBox.x + bodyBox.width);
          expect.soft(startGap, 'the scroll region is inset from the left edge').toBeGreaterThanOrEqual(4);
          expect.soft(endGap, 'the scroll region is inset from the right edge').toBeGreaterThanOrEqual(4);
          for (const [x, y] of [
            [bodyBox.x, bodyBox.y],
            [bodyBox.x + bodyBox.width, bodyBox.y],
            [bodyBox.x, bodyBox.y + bodyBox.height],
            [bodyBox.x + bodyBox.width, bodyBox.y + bodyBox.height],
          ]) {
            expect.soft(insideRounded(x, y, cardBox, facts.radius), `scroll region corner (${x}, ${y}) inside the rounded card`).toBe(true);
          }
          // It does not reach the card's top or bottom: the header and footer cap it.
          expect.soft(bodyBox.y - cardBox.y, 'the title sits above the scroll region').toBeGreaterThanOrEqual(facts.radius);
          expect.soft(cardBox.y + cardBox.height - (bodyBox.y + bodyBox.height), 'the actions sit below it').toBeGreaterThanOrEqual(facts.radius);

          // Scroll the body to the end with the wheel, as a person would.
          await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
          for (let n = 0; n < 12; n++) await page.mouse.wheel(0, 600);
          await expect
            .poll(() => body!.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
            .toBeLessThanOrEqual(1);
          // And on past the end, and over the scrim: neither moves the page.
          for (let n = 0; n < 4; n++) await page.mouse.wheel(0, 600);
          await page.mouse.move(2, vp.height - 2);
          for (let n = 0; n < 4; n++) await page.mouse.wheel(0, 600);

          // Title and the primary action: still there, and on screen.
          const primary = dialog.getByRole('button', { name: opener.primary(locale), exact: true }).last();
          for (const [what, el] of [
            ['title', title],
            ['primary action', primary],
          ] as const) {
            await expect.soft(el, `${what} visible after scrolling`).toBeVisible();
            const box = (await el.boundingBox())!;
            expect.soft(box.y, `${what} below the top of the screen`).toBeGreaterThanOrEqual(0);
            expect.soft(box.y + box.height, `${what} above the bottom of the screen`).toBeLessThanOrEqual(vp.height);
            expect.soft(box.x).toBeGreaterThanOrEqual(0);
            expect.soft(box.x + box.width).toBeLessThanOrEqual(vp.width);
            // Inside the dialog, not behind it.
            expect.soft(box.y).toBeGreaterThanOrEqual(cardBox.y);
            expect.soft(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
          }

          const after = await page.evaluate(() => ({
            main: document.querySelector('main')!.scrollTop,
            window: window.scrollY,
          }));
          expect.soft(after, 'the page behind did not scroll').toEqual(behind);
        });
      }
    });
  }
}
