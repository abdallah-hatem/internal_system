/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: selling below cost warns, and never refuses (L4)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4, DECIDED 2026-10-11 by the owner: he sold 90 helmets at
 *  1,000 that had landed at 2,616.67 and nothing told him. Every place a
 *  selling price is set now says so — against the FIFO cost of the units the
 *  sale would draw, after the line discount — and the sale still goes through.
 *
 *  Stock is built through a cycle, a purchase order, a leg and a verified
 *  receipt (rule 4): 2 units at 900 received first, then 5 at 1,100 — the
 *  TC-INV-30 shelf. Screens are reached by logging in and clicking (rule 2).
 */
import {
  test,
  expect,
  type Page,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";
import {
  API,
  PASSWORD,
  apiCtx,
  giveStock,
  refusedCallers,
} from "./support/fixtures";
import { login, openNav, type Locale, messages } from "./support/ui";

type Headers = Record<string, string>;

/** Strip the bidi isolates the sentence wraps each amount in. */
const plain = (s: string | null) => (s ?? "").replace(/[⁦-⁩]/g, "");

/** The words a reader sees in `loc`, isolates aside, once they include `text`. */
const says = (loc: Locator, text: string) =>
  expect
    .poll(async () => plain(await loc.textContent()), { timeout: 10000 })
    .toContain(text);
/** ...and exactly `text`, once the latest answer is on screen. */
const saysExactly = (loc: Locator, text: string) =>
  expect
    .poll(async () => plain(await loc.textContent()), { timeout: 10000 })
    .toBe(text);

/** A product with the TC-INV-30 shelf: 2 at 900, then 5 at 1,100. */
async function twoBatchProduct(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const product = await mk("products", {
    name: `${label} ${stamp} Helmet`,
    minStock: 0,
  });
  await giveStock(
    request,
    headers,
    mk,
    product.id,
    `${label} ${stamp} old`,
    2,
    900,
  );
  await giveStock(
    request,
    headers,
    mk,
    product.id,
    `${label} ${stamp} new`,
    5,
    1100,
  );
  return { headers, mk, product, stamp };
}

async function priceCheck(
  request: APIRequestContext,
  headers: Headers,
  data: unknown,
) {
  const res = await request.post(`${API}/sales/price-check`, { headers, data });
  return { status: res.status(), body: await res.json() };
}

async function openSales(page: Page, locale: Locale = "en") {
  const m = messages(locale);
  const bar = page.getByTestId("phone-bar");
  if (await bar.isVisible())
    await bar
      .getByRole("link", { name: m.nav.short.sales, exact: true })
      .click();
  else await openNav(page, m.nav.sales);
  await expect(
    page.getByRole("heading", { name: m.sales.title }),
  ).toBeVisible();
}

async function openNewOrder(page: Page, locale: Locale = "en") {
  await page
    .getByRole("button", { name: messages(locale).sales.create })
    .first()
    .click();
  const form = page.getByTestId("sale-order-form");
  await expect(form).toBeVisible();
  return form;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function choose(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  const search = page.locator("[cmdk-input]").filter({ visible: true });
  if (await search.count()) await search.fill(label);
  await page
    .getByRole("option", { name: new RegExp(escape(label)) })
    .first()
    .click();
}
const combo = (form: Locator, n: number) => form.getByRole("combobox").nth(n);
const line = (form: Locator, n: number) => form.getByTestId("sale-line").nth(n);
const input = (row: Locator, name: string) =>
  row.locator(`[data-field="${name}"]:not([type="hidden"])`);

/** Open an order from the sales list by its number, as a person would. */
async function openOrder(page: Page, orderNo: string) {
  await page
    .getByRole("main")
    .getByPlaceholder(messages("en").sales.search)
    .fill(orderNo);
  await page
    .getByRole("button", {
      name: messages("en").sales.openOrder.replace("{orderNo}", orderNo),
    })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole("heading", { name: orderNo });
  await expect(dialog).toBeVisible();
}

async function allocationsCogs(
  request: APIRequestContext,
  headers: Headers,
  orderId: string,
) {
  const order = (
    await (
      await request.get(`${API}/sales/orders/${orderId}`, { headers })
    ).json()
  ).data;
  return order.items
    .flatMap(
      (i: { allocations?: { cogsEgp: string }[] }) => i.allocations ?? [],
    )
    .reduce((s: number, a: { cogsEgp: string }) => s + Number(a.cogsEgp), 0);
}

test.describe("Selling below cost — the sale form (§4, L4)", () => {
  test("TC-BC-01: 3 at 950 across two batches warns 966.67 / 950.00 / 50.00 on the line and in total; live as price and discount change; Create & confirm still goes through at COGS 2,900", async ({
    page,
    request,
  }) => {
    const { headers, mk, product, stamp } = await twoBatchProduct(
      request,
      "BC01",
    );
    const shop = await mk("customers", {
      displayName: `BC01 Shop ${stamp}`,
      type: "B2B",
    });

    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), shop.displayName);
    await choose(page, combo(form, 3), product.name);
    const row = line(form, 0);
    await input(row, "quantity").fill("3");
    await input(row, "unitPrice").fill("950");

    const warning = row.getByTestId("below-cost-line");
    await expect(warning).toBeVisible();
    await saysExactly(
      warning,
      "Below cost: each costs 966.67 EGP, you’re selling at 950.00 EGP, a loss of 50.00 EGP on this line.",
    );
    await says(form.getByTestId("below-cost-total"), "50.00 EGP");

    // Above the weighted cost (2,900 for the three), though under the newer batch.
    await input(row, "unitPrice").fill("1000");
    await expect(warning).toBeHidden();
    await expect(form.getByTestId("below-cost-total")).toBeHidden();

    // A 200 discount takes the line to 2,800: a loss of 100.
    await input(row, "discount").fill("200");
    await says(warning, "a loss of 100.00 EGP");
    await says(warning, "933.33 EGP");

    await form
      .getByRole("button", { name: messages("en").sales.createAndConfirm })
      .click();
    await expect(form).toBeHidden();

    const orders = (
      await (
        await request.get(
          `${API}/sales/orders?customerId=${shop.id}&limit=10`,
          { headers },
        )
      ).json()
    ).data;
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("CONFIRMED");
    expect(await allocationsCogs(request, headers, orders[0].id)).toBe(2900);
  });

  test("TC-BC-02: a walk-in sale below cost warns the same way and Sell & take payment still sells", async ({
    page,
    request,
  }) => {
    const { headers, product } = await twoBatchProduct(request, "BC02");
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await form.getByTestId("walk-in-switch").click();
    await choose(page, combo(form, 3), product.name);
    const row = line(form, 0);
    await input(row, "quantity").fill("1");
    await input(row, "unitPrice").fill("500");
    await says(row.getByTestId("below-cost-line"), "a loss of 400.00 EGP");

    await form
      .getByRole("button", { name: messages("en").sales.sellAndTakePayment })
      .click();
    await expect(form).toBeHidden();
    const inv = (
      await (
        await request.get(`${API}/inventory?productId=${product.id}`, {
          headers,
        })
      ).json()
    ).data;
    expect(Number(inv[0].availableStock)).toBe(6);
  });

  test("TC-BC-03: exactly at cost and above it say nothing; a line with no stock behind it says nothing", async ({
    request,
  }) => {
    const { headers, mk, product } = await twoBatchProduct(request, "BC03");
    const empty = await mk("products", {
      name: `BC03 Empty ${Date.now()}`,
      minStock: 0,
    });
    const { status, body } = await priceCheck(request, headers, {
      currency: "EGP",
      items: [
        { productId: product.id, quantity: 3, unitPrice: 966.67 }, // 2,900.01 ≥ 2,900
        { productId: empty.id, quantity: 1, unitPrice: 1 },
      ],
    });
    expect(status).toBe(200);
    expect(
      body.data.lines.map((l: { belowCost: boolean; reason?: string }) => [
        l.belowCost,
        l.reason ?? null,
      ]),
    ).toEqual([
      [false, null],
      [false, "NO_STOCK"],
    ]);
    const atCost = await priceCheck(request, headers, {
      currency: "EGP",
      items: [{ productId: product.id, quantity: 2, unitPrice: 900 }],
    });
    expect(atCost.body.data.lines[0]).toMatchObject({
      costed: true,
      belowCost: false,
      lossEgp: "0.00",
    });
  });
});

test.describe("Selling below cost — the confirm step, approval and price list (§4, §12)", () => {
  test("TC-BC-04: a draft below cost is warned about above Confirm, and Confirm still confirms", async ({
    page,
    request,
  }) => {
    const { headers, mk, product, stamp } = await twoBatchProduct(
      request,
      "BC04",
    );
    const shop = await mk("customers", {
      displayName: `BC04 Shop ${stamp}`,
      type: "B2B",
    });
    const draft = await mk("sales/orders", {
      customerId: shop.id,
      channel: "B2B",
      currency: "EGP",
      items: [
        { productId: product.id, quantity: 3, unitPrice: 950, discount: 0 },
      ],
    });

    await login(page);
    await openSales(page);
    await openOrder(page, draft.orderNo);
    const summary = page.getByTestId("below-cost-summary");
    await expect(summary).toBeVisible();
    await saysExactly(
      summary.getByTestId("below-cost-summary-line"),
      `${product.name}: each costs 966.67 EGP, selling at 950.00 EGP, a loss of 50.00 EGP.`,
    );
    await says(summary, messages("en").priceCheck.confirmHint);

    await page
      .getByRole("button", { name: messages("en").sales.confirm, exact: true })
      .click();
    await expect(summary).toBeHidden();
    const after = (
      await (
        await request.get(`${API}/sales/orders/${draft.id}`, { headers })
      ).json()
    ).data;
    expect(after.status).toBe("CONFIRMED");
  });

  test("TC-BC-05: the second visit — a draft at 1,000 is fine while the 900 batch is there; once another sale takes it, reopening shows 1,100 and a loss of 100", async ({
    page,
    request,
  }) => {
    const { headers, mk, product, stamp } = await twoBatchProduct(
      request,
      "BC05",
    );
    const shop = await mk("customers", {
      displayName: `BC05 Shop ${stamp}`,
      type: "B2B",
    });
    const draft = await mk("sales/orders", {
      customerId: shop.id,
      channel: "B2B",
      currency: "EGP",
      items: [
        { productId: product.id, quantity: 1, unitPrice: 1000, discount: 0 },
      ],
    });

    await login(page);
    await openSales(page);
    // The check is answered; nothing should appear.
    const checked = page.waitForResponse((r) =>
      r.url().endsWith("/sales/price-check"),
    );
    await openOrder(page, draft.orderNo);
    await expect(
      page.getByRole("button", {
        name: messages("en").sales.confirm,
        exact: true,
      }),
    ).toBeVisible();
    await checked;
    await expect(page.getByTestId("below-cost-summary")).toHaveCount(0);
    await page
      .getByRole("button", { name: messages("en").common.close })
      .click();

    // Another sale takes the two cheap units.
    await mk("sales/orders", {
      customerId: shop.id,
      channel: "B2B",
      currency: "EGP",
      confirm: true,
      items: [
        { productId: product.id, quantity: 2, unitPrice: 2000, discount: 0 },
      ],
    });

    await openSales(page);
    await openOrder(page, draft.orderNo);
    const summary = page.getByTestId("below-cost-summary");
    await expect(summary).toBeVisible();
    await says(summary, "1,100.00 EGP");
    await says(summary, "a loss of 100.00 EGP");
  });

  test("TC-BC-06: approving a shop request priced below cost warns per line and in total; Approve still raises the order", async ({
    page,
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = `${Date.now()}`;
    const product = await mk("products", {
      name: `BC06 ${stamp} Visor`,
      minStock: 0,
    });
    await giveStock(request, headers, mk, product.id, `BC06 ${stamp}`, 10, 500);
    await mk(`products/${product.id}/prices`, {
      channel: "B2B",
      currency: "EGP",
      amount: 400,
    });
    await mk(`products/${product.id}/prices`, {
      channel: "B2C",
      currency: "EGP",
      amount: 450,
    });

    const shopLogin = await request.post(`${API}/auth/portal/login`, {
      data: { email: "shop.owner@example.com", password: PASSWORD },
    });
    const shopHeaders = {
      Authorization: `Bearer ${(await shopLogin.json()).data.accessToken}`,
    };
    const made = await request.post(`${API}/portal/requests`, {
      headers: shopHeaders,
      data: { items: [{ productId: product.id, quantity: 2 }] },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    const req = (await made.json()).data;

    await login(page);
    await openNav(page, messages("en").nav.orderRequests);
    const card = page
      .getByTestId("order-request-card")
      .filter({ hasText: req.requestNo });
    await expect(card).toBeVisible();
    const unit = Number(req.items?.[0]?.unitPrice ?? 400);
    const loss = (2 * (500 - unit)).toFixed(2);
    await says(card.getByTestId("below-cost-line"), `each costs 500.00 EGP`);
    await says(card.getByTestId("below-cost-line"), `a loss of ${loss} EGP`);
    await says(card.getByTestId("below-cost-total"), `${loss} EGP`);

    await card
      .getByRole("button", { name: messages("en").orderRequests.approve })
      .click();
    await expect(card).toBeHidden({ timeout: 15000 });
    const orders = (
      await (
        await request.get(`${API}/sales/orders?limit=20`, { headers })
      ).json()
    ).data;
    expect(
      orders.some((o: { items: { productId: string }[] }) =>
        o.items.some((i) => i.productId === product.id),
      ),
    ).toBe(true);
  });

  test("TC-BC-07: setting a price below the oldest batch warns; above it does not; Save still saves", async ({
    page,
    request,
  }) => {
    const { headers, product } = await twoBatchProduct(request, "BC07");
    await login(page);
    await openNav(page, messages("en").nav.products);
    const main = page.getByRole("main");
    await main
      .getByPlaceholder(messages("en").products.search)
      .fill(product.name);
    await main
      .getByRole("link", { name: product.name, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);

    const priceInputs = main.locator('input[inputmode="decimal"]');
    const b2b = priceInputs.first();
    await b2b.fill("850");
    const warning = main.getByTestId("below-cost-price").first();
    await expect(warning).toBeVisible();
    await saysExactly(
      warning,
      "Below cost: the oldest stock on the shelf cost 900.00 EGP each, so every unit sold at this price loses 50.00 EGP.",
    );
    await b2b.fill("950");
    await expect(warning).toBeHidden();
    await b2b.fill("800");
    await expect(warning).toBeVisible();
    await main.getByTestId("set-price-action").first().click();
    await expect
      .poll(async () => {
        const p = (
          await (
            await request.get(`${API}/products/${product.id}`, { headers })
          ).json()
        ).data;
        return Number(
          p.prices.find(
            (x: { channel: string; effectiveTo: string | null }) =>
              x.channel === "B2B" && !x.effectiveTo,
          )?.amount,
        );
      })
      .toBe(800);
  });
});

test.describe("Selling below cost — the endpoint (§4, rules 1 and 12)", () => {
  test("TC-BC-08: an investor and a shop are refused with a code; admin support may ask", async ({
    request,
  }) => {
    const { headers, product } = await twoBatchProduct(request, "BC08");
    const body = {
      currency: "EGP",
      items: [{ productId: product.id, quantity: 1, unitPrice: 1 }],
    };
    for (const caller of await refusedCallers(request, "BC08")) {
      const r = await priceCheck(request, caller.headers, body);
      expect(r.status, caller.who).toBe(403);
      expect(r.body.error.code, caller.who).toBe(caller.code);
    }
    const stamp = `${Date.now()}`;
    const email = `bc08-support-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, {
      headers,
      data: {
        email,
        password: PASSWORD,
        displayName: `BC08 ${stamp}`,
        role: "ADMIN_SUPPORT",
      },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    const signed = await request.post(`${API}/auth/login`, {
      data: { email, password: PASSWORD },
    });
    const support = {
      Authorization: `Bearer ${(await signed.json()).data.accessToken}`,
    };
    const ok = await priceCheck(request, support, body);
    expect(ok.status).toBe(200);
    expect(ok.body.data.lines[0]).toMatchObject({
      belowCost: true,
      lossEgp: "899.00",
    });
  });

  test("TC-BC-09: nonsense is a 400 or an uncosted line, never a 500; a USD sale is not compared; checking writes nothing", async ({
    request,
  }) => {
    const { headers, product } = await twoBatchProduct(request, "BC09");
    expect((await priceCheck(request, headers, {})).status).toBe(400);
    expect(
      (await priceCheck(request, headers, { items: "x" })).body.error.code,
    ).toBe("VALIDATION_FAILED");
    const odd = await priceCheck(request, headers, {
      items: [
        { productId: "not-a-uuid", quantity: 1, unitPrice: 1 },
        {
          productId: "99999999-9999-4999-8999-999999999999",
          quantity: 1,
          unitPrice: 1,
        },
        { productId: product.id, quantity: -2, unitPrice: 1 },
      ],
    });
    expect(odd.status).toBe(200);
    expect(
      odd.body.data.lines.map((l: { reason: string }) => l.reason),
    ).toEqual(["INCOMPLETE", "NO_STOCK", "INCOMPLETE"]);
    const usd = await priceCheck(request, headers, {
      currency: "USD",
      items: [{ productId: product.id, quantity: 1, unitPrice: 1 }],
    });
    expect(usd.body.data).toMatchObject({
      compared: false,
      totalLossEgp: "0.00",
    });

    const before = (
      await (
        await request.get(`${API}/inventory?productId=${product.id}`, {
          headers,
        })
      ).json()
    ).data;
    await priceCheck(request, headers, {
      items: [{ productId: product.id, quantity: 7, unitPrice: 1 }],
    });
    const after = (
      await (
        await request.get(`${API}/inventory?productId=${product.id}`, {
          headers,
        })
      ).json()
    ).data;
    expect(after[0].availableStock).toBe(before[0].availableStock);
  });
});
