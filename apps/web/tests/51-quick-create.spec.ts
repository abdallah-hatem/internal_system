/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Creating the missing record without leaving the form
 * ═══════════════════════════════════════════════════════════════════════
 *  Adding a product needed a category that did not exist yet, and the only way
 *  to get one was to abandon the half-filled form, go to Categories, create it,
 *  come back and start again. The same dead end sat behind every picker: the
 *  supplier on a purchase order, the provider on a shipping leg, the customer
 *  on a sale.
 *
 *  A `+` beside the field opens the entity's OWN create form — the same one its
 *  tab shows, defined once in `entity-forms` and rendered in both places. The
 *  first version carried its own cut-down fields, which is a second definition
 *  of a form that already exists: add a field to Customers and the `+` beside a
 *  sale quietly keeps making customers without it. TC-QC-09 is what holds the
 *  two together.
 *
 *  Most of what follows is about the ways this can go wrong rather than the way
 *  it works:
 *
 *  - it sits INSIDE another form, so a stray submit saves the half-filled record
 *  - selecting an id before the picker's list has refreshed shows a blank field
 *  - state left behind means the next record opens on the last one's choice
 *  - a nested `<form>` is invalid markup, so the modal has to portal out
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const plus = (page: Page, entity: string) =>
  page.locator(`[data-quick-create="${entity}"]`);

/**
 * The dialog for one entity.
 *
 * By its own attribute, not by z-index: the stacking order is computed per
 * depth now, so `.z-[60]` no longer exists as a class and a selector reading
 * one would silently match nothing — which in Playwright is a passing
 * `toHaveCount(0)`, not a failure.
 */
const dialogFor = (page: Page, entity: string) =>
  page.locator(`[data-quick-create-dialog="${entity}"]`);

/** Open the quick-create modal and save one, returning the name used. */
async function quickCreate(page: Page, entity: string, label: string) {
  const name = `${label} ${Date.now()}`;
  await plus(page, entity).first().click();
  const dialog = dialogFor(page, entity);
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.locator('input[type="text"]').first().fill(name);
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await expect(dialog).toHaveCount(0, { timeout: 15000 });
  return name;
}

test.describe('Quick create', () => {
  test('TC-QC-01: a category can be made from inside the product form', async ({
    page,
  }) => {
    // The case as reported.
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.getByRole('button', { name: /new product|create/i }).first().click();

    const productName = `QC Product ${Date.now()}`;
    await page.locator('input[name="name"]').first().fill(productName);

    const category = await quickCreate(page, 'category', 'QC Cat');

    // The half-filled product is untouched, and the new category is selected.
    await expect(page.locator('input[name="name"]').first()).toHaveValue(productName);
    await expect(page.locator('input[type="hidden"][name="category"]')).not.toHaveValue('');
    await expect(page.getByText(category).first()).toBeVisible();
  });

  test('TC-QC-02: the new record is selectable, not just created', async ({
    page,
    request,
  }) => {
    // Selecting an id before the picker's list has been refetched leaves the
    // field blank — created, and apparently not.
    const { headers } = await apiCtx(request);

    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.getByRole('button', { name: /new product|create/i }).first().click();
    const category = await quickCreate(page, 'category', 'QC Pick');

    const chosen = await page
      .locator('input[type="hidden"][name="category"]')
      .inputValue();
    expect(chosen).toBeTruthy();

    // And that id really is the category just made.
    const listed = await (await request.get(`${API}/categories`, { headers })).json();
    const rows = listed.data?.items ?? listed.data ?? [];
    expect(rows.find((c: any) => c.id === chosen)?.name).toBe(category);
  });

  test('TC-QC-03: the plus button never submits the form it sits in', async ({
    page,
    request,
  }) => {
    // It lives inside another form. A bare <button> defaults to submit, which
    // would save the half-filled product the moment you reached for a category.
    const { headers } = await apiCtx(request);
    const before = await (await request.get(`${API}/products?limit=100`, { headers })).json();
    const countBefore = (before.data?.items ?? before.data ?? []).length;

    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.getByRole('button', { name: /new product|create/i }).first().click();
    await page.locator('input[name="name"]').first().fill(`Untouched ${Date.now()}`);

    await plus(page, 'category').first().click();
    await page.waitForTimeout(800);

    const after = await (await request.get(`${API}/products?limit=100`, { headers })).json();
    expect((after.data?.items ?? after.data ?? []).length).toBe(countBefore);
  });

  test('TC-QC-04: cancelling creates nothing and leaves the form alone', async ({
    page,
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const before = await (await request.get(`${API}/categories`, { headers })).json();
    const countBefore = (before.data?.items ?? before.data ?? []).length;

    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.getByRole('button', { name: /new product|create/i }).first().click();
    const productName = `Cancel ${Date.now()}`;
    await page.locator('input[name="name"]').first().fill(productName);

    await plus(page, 'category').first().click();
    const dialog = dialogFor(page, 'category');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await dialog.locator('input[type="text"]').first().fill('Never saved');
    await dialog.getByRole('button', { name: /^cancel$/i }).click();
    await expect(dialog).toHaveCount(0);

    const after = await (await request.get(`${API}/categories`, { headers })).json();
    expect((after.data?.items ?? after.data ?? []).length).toBe(countBefore);
    await expect(page.locator('input[name="name"]').first()).toHaveValue(productName);
  });

  test('TC-QC-05: an empty required field creates nothing', async ({
    page,
    request,
  }) => {
    // Asserted on the outcome, not the mechanism. The shared form marks its
    // required inputs `required` like every other form in the app, so the
    // browser refuses the submit — an earlier version of this test expected a
    // disabled button, which was true only of the cut-down form it replaced.
    const { headers } = await apiCtx(request);
    const before = await (await request.get(`${API}/categories`, { headers })).json();
    const countBefore = (before.data?.items ?? before.data ?? []).length;

    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.getByRole('button', { name: /new product|create/i }).first().click();

    await plus(page, 'category').first().click();
    const dialog = dialogFor(page, 'category');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Submit with the name empty.
    await dialog.getByRole('button', { name: /^create$/i }).click();
    await page.waitForTimeout(800);

    // Still open, and nothing saved.
    await expect(dialog).toBeVisible();
    const after = await (await request.get(`${API}/categories`, { headers })).json();
    expect((after.data?.items ?? after.data ?? []).length).toBe(countBefore);
  });

  test('TC-QC-06: reopening the form does not inherit the last choice', async ({
    page,
  }) => {
    // The quick-create keeps its own state beside the picker, so it has to be
    // cleared — otherwise the next product opens already categorised.
    await login(page);
    await page.goto(`${BASE}/en/products`);

    await page.getByRole('button', { name: /new product|create/i }).first().click();
    await page.locator('input[name="name"]').first().fill(`First ${Date.now()}`);
    await quickCreate(page, 'category', 'QC Leak');
    await expect(page.locator('input[type="hidden"][name="category"]')).not.toHaveValue('');

    // Close without saving, and open a fresh one.
    await page.getByRole('button', { name: /^cancel$/i }).last().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /new product|create/i }).first().click();

    await expect(page.locator('input[type="hidden"][name="category"]')).toHaveValue('');
  });

  test('TC-QC-07: every picker that can create one offers it', async ({ page }) => {
    // The point of doing this once rather than per page. If a form grows a
    // picker later and skips the button, this is what says so.
    await login(page);

    const cases: [string, RegExp, string][] = [
      ['purchases', /new purchase|create/i, 'supplier'],
      ['payments', /new payment|create|record/i, 'customer'],
      ['shipments', /new shipping leg/i, 'provider'],
      ['sales', /new order|create/i, 'customer'],
      ['products', /new product|create/i, 'category'],
    ];

    const missing: string[] = [];
    for (const [slug, openBtn, entity] of cases) {
      await page.goto(`${BASE}/en/${slug}`);
      await page.getByRole('button', { name: openBtn }).first().click();
      await page.waitForTimeout(700);
      if ((await plus(page, entity).count()) === 0) missing.push(`${slug}/${entity}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    expect(missing).toEqual([]);
  });

  test('TC-QC-09: the plus opens the same form as the entity tab', async ({
    page,
  }) => {
    // The property the whole shared-forms refactor exists for, compared by what
    // is actually rendered rather than by reading the source.
    //
    // The first version of this test checked one entity, the customer, and the
    // suppliers page turned out never to have been migrated at all — it still
    // had its own copy of the form and its own copy of `InputField`, so the tab
    // marked every optional field "(Optional)" and the `+` beside a purchase
    // order marked none of them. Checking one entity proved nothing about the
    // other four. It checks all five.
    //
    // Labels as well as field names: the difference a person actually reported
    // was in the labels, and two forms with matching `name` attributes can
    // still ask for visibly different things.
    //
    // What it cannot catch, by construction: a change to a shared form itself.
    // Removing a field there removes it from both and the two stay identical.
    // That is the design working — one definition leaves no second one to
    // disagree with.
    await login(page);

    const shape = async (scope: any) => ({
      names: await scope
        .locator('input[name], textarea[name], select[name]')
        .evaluateAll((nodes: any[]) =>
          nodes.map((n) => n.getAttribute('name')).filter(Boolean).sort(),
        ),
      labels: await scope
        .locator('label')
        .evaluateAll((nodes: any[]) =>
          nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
        ),
    });

    /** entity, its own tab, and a form elsewhere carrying its `+`. */
    const cases: {
      entity: string;
      tab: string;
      tabOpen: RegExp;
      host: string;
      hostOpen: RegExp;
      prep?: RegExp;
    }[] = [
      { entity: 'customer', tab: 'customers', tabOpen: /new customer|create/i, host: 'payments', hostOpen: /new payment|create|record/i },
      { entity: 'category', tab: 'categories', tabOpen: /new category|create/i, host: 'products', hostOpen: /new product|create/i },
      { entity: 'provider', tab: 'providers', tabOpen: /new (shipping )?provider/i, host: 'shipments', hostOpen: /new shipping leg/i },
      { entity: 'supplier', tab: 'suppliers', tabOpen: /new supplier|create/i, host: 'purchases', hostOpen: /new purchase|create/i },
      { entity: 'product', tab: 'products', tabOpen: /new product|create/i, host: 'purchases', hostOpen: /new purchase|create/i, prep: /add item/i },
    ];

    const differ: string[] = [];

    for (const c of cases) {
      await page.goto(`${BASE}/en/${c.tab}`);
      await page.getByRole('button', { name: c.tabOpen }).first().click();
      await expect(page.locator('form').first()).toBeVisible({ timeout: 10000 });
      const onTab = await shape(page.locator('form').first());
      expect(onTab.names.length, `${c.entity} tab form has no fields`).toBeGreaterThan(0);

      await page.goto(`${BASE}/en/${c.host}`);
      await page.getByRole('button', { name: c.hostOpen }).first().click();
      if (c.prep) await page.getByRole('button', { name: c.prep }).first().click();
      await plus(page, c.entity).first().click();
      const dialog = dialogFor(page, c.entity);
      await expect(dialog).toBeVisible({ timeout: 10000 });
      const onQuick = await shape(dialog.locator('form'));

      if (JSON.stringify(onTab) !== JSON.stringify(onQuick)) {
        differ.push(
          `${c.entity}\n  tab:   ${JSON.stringify(onTab)}\n  quick: ${JSON.stringify(onQuick)}`,
        );
      }
    }

    expect(differ.join('\n')).toBe('');
  });

  test('TC-QC-10: a picker inside the quick-create form can actually be used', async ({
    page,
  }) => {
    // Reported: "on items in wizard when creating a product why cant i select
    // a category". The panel was opening — behind the dialog.
    //
    // Radix portals it to <body>, so it is a SIBLING of the dialog rather than
    // a child, and shadcn ships it at z-50. Against a page modal at z-50 it won
    // on DOM order and looked fine; against the quick-create dialog at z-60 it
    // lost outright. Every picker in every quick-create form was dead, and no
    // test noticed because they all left the pickers on their defaults.
    //
    // Asserted by clicking an option and reading what got selected, not by
    // comparing z-index numbers — the numbers are the current mechanism, the
    // click is the property.
    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.getByRole('button', { name: /new purchase|create/i }).first().click();
    await page.getByRole('button', { name: /add item/i }).first().click();

    await plus(page, 'product').first().click();
    const dialog = dialogFor(page, 'product');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    await dialog.getByRole('combobox').first().click();

    // The panel is outside the dialog in the DOM, so it is looked for on the page.
    const panel = page.locator('[data-slot="popover-content"]');
    await expect(panel).toBeVisible({ timeout: 5000 });

    const option = panel.getByRole('option').first();
    const chosen = (await option.textContent())?.trim();
    await option.click();

    await expect(dialog.locator('input[type="hidden"][name="category"]')).not.toHaveValue('');
    await expect(dialog.getByText(chosen!, { exact: false }).first()).toBeVisible();
  });

  test('TC-QC-11: the form a plus opens is not itself a dead end', async ({
    page,
    request,
  }) => {
    // The other half of the same report: "or even create one". The product form
    // deliberately had no `+` on its category, to avoid stacking modals — which
    // just moved the dead end down a level. Someone adding a product from a
    // purchase line with no categories yet had to abandon the purchase order.
    //
    // Three deep: purchase order → product → category.
    const { headers } = await apiCtx(request);

    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.getByRole('button', { name: /new purchase|create/i }).first().click();
    await page.getByRole('button', { name: /add item/i }).first().click();

    await plus(page, 'product').first().click();
    const productDialog = dialogFor(page, 'product');
    await expect(productDialog).toBeVisible({ timeout: 10000 });

    const productName = `Nested Product ${Date.now()}`;
    await productDialog.locator('input[name="name"]').fill(productName);

    // The `+` inside the product form.
    const categoryName = `Nested Cat ${Date.now()}`;
    await productDialog.locator('[data-quick-create="category"]').click();
    const categoryDialog = dialogFor(page, 'category');
    await expect(categoryDialog).toBeVisible({ timeout: 10000 });
    await categoryDialog.locator('input[name="name"]').fill(categoryName);
    await categoryDialog.getByRole('button', { name: /^create$/i }).click();
    await expect(categoryDialog).toHaveCount(0, { timeout: 15000 });

    // The product form is still there, still filled in, now categorised.
    await expect(productDialog).toBeVisible();
    await expect(productDialog.locator('input[name="name"]')).toHaveValue(productName);
    await expect(productDialog.getByText(categoryName).first()).toBeVisible();

    // And saving the product really carries the category that was just made.
    await productDialog.getByRole('button', { name: /^create$/i }).click();
    await expect(productDialog).toHaveCount(0, { timeout: 15000 });

    const listed = await (await request.get(`${API}/products?limit=200`, { headers })).json();
    const made = (listed.data?.items ?? listed.data ?? []).find(
      (p: any) => p.name === productName,
    );
    expect(made).toBeTruthy();
    const cats = await (await request.get(`${API}/categories`, { headers })).json();
    const cat = (cats.data?.items ?? cats.data ?? []).find((c: any) => c.name === categoryName);
    expect(made.categoryId).toBe(cat.id);
  });

  test('TC-QC-12: the inner form saves only its own record', async ({
    page,
    request,
  }) => {
    // The hazard nesting actually creates, and the reason the dialog portals to
    // <body> rather than rendering where it sits.
    //
    // The `+` lives inside the product form, which lives inside the purchase
    // order's form, so a dialog rendered in place puts a <form> inside a <form>
    // inside a <form>. React builds that through DOM calls, so the browser does
    // not reject it the way the parser would — the inner submit simply bubbles,
    // and pressing Create on the category takes the half-filled purchase order
    // up with it. Ran without the portal, that is what this catches: the
    // purchase order form submits and its modal is torn down mid-edit.
    //
    // The first version of this slot asserted the inner dialog painted on top,
    // which passed whether or not the code did anything: both dialogs are body
    // portals, so mount order alone puts the inner one above. A test that
    // cannot fail is not a test.
    const { headers } = await apiCtx(request);
    const countProducts = async () => {
      const r = await (await request.get(`${API}/products?limit=200`, { headers })).json();
      return (r.data?.items ?? r.data ?? []).length;
    };
    const countOrders = async () => {
      const r = await (await request.get(`${API}/purchase-orders?limit=200`, { headers })).json();
      return (r.data?.items ?? r.data ?? []).length;
    };
    const beforeProducts = await countProducts();
    const beforeOrders = await countOrders();

    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.getByRole('button', { name: /new purchase|create/i }).first().click();
    await page.getByRole('button', { name: /add item/i }).first().click();

    await plus(page, 'product').first().click();
    const productDialog = dialogFor(page, 'product');
    await expect(productDialog).toBeVisible({ timeout: 10000 });
    await productDialog.locator('input[name="name"]').fill(`Must not save ${Date.now()}`);

    await productDialog.locator('[data-quick-create="category"]').click();
    const categoryDialog = dialogFor(page, 'category');
    await expect(categoryDialog).toBeVisible({ timeout: 10000 });
    await categoryDialog.locator('input[name="name"]').fill(`Inner only ${Date.now()}`);
    await categoryDialog.getByRole('button', { name: /^create$/i }).click();
    await expect(categoryDialog).toHaveCount(0, { timeout: 15000 });

    // The category saved. Nothing else did, and both forms above it are still
    // open with what was typed into them.
    expect(await countProducts()).toBe(beforeProducts);
    expect(await countOrders()).toBe(beforeOrders);
    await expect(productDialog).toBeVisible();
  });

  test('TC-QC-08: a customer needs its type, and gets one', async ({
    page,
    request,
  }) => {
    // Not every entity is just a name. A customer cannot exist without a type,
    // so the quick form carries it with a sensible default rather than posting
    // an incomplete record.
    const { headers } = await apiCtx(request);

    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.getByRole('button', { name: /new payment|create|record/i }).first().click();
    const name = await quickCreate(page, 'customer', 'QC Shop');

    const listed = await (await request.get(`${API}/customers?limit=100`, { headers })).json();
    const made = (listed.data?.items ?? listed.data ?? []).find(
      (c: any) => c.displayName === name,
    );
    expect(made).toBeTruthy();
    expect(made.type).toBe('B2B');
  });
});
