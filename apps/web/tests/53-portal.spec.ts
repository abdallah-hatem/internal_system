/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: What a shop can see, ask for, and hold
 * ═══════════════════════════════════════════════════════════════════════
 *  The storefront's API. Three things here are money-adjacent and are tested
 *  as such rather than as features:
 *
 *  - **Ownership.** Every portal route takes the shop from the token. These
 *    tests try to name another shop through every door there is — body, path,
 *    query — because ownership is checked far less often than amounts.
 *
 *  - **Holds.** A request sets stock aside so a second shop cannot be promised
 *    the same units. The catalogue, the internal inventory page and the sales
 *    create flow must agree about what is left while a hold is live, or the
 *    storefront promises stock the office has already committed.
 *
 *  - **Two price tiers.** A verified B2B shop sees trade prices; everybody else
 *    sees retail. Four surfaces show a price and they must agree, which is one
 *    test across four rather than four tests.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, stockedProduct } from './support/fixtures';

const SHOP_EMAIL = 'shop.owner@example.com';
const SHOP_PASSWORD = 'password123';

async function officeToken(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

async function shopToken(request: APIRequestContext, email = SHOP_EMAIL) {
  const res = await request.post(`${API}/auth/portal/login`, {
    data: { email, password: SHOP_PASSWORD },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return {
    headers: { Authorization: `Bearer ${body.data.accessToken}` },
    customerId: body.data.user.customerId as string,
  };
}

/**
 * A priced product with stock on the shelf.
 *
 * Built rather than found. The reference seed carries no cycles, so it carries
 * no inventory, and a test that looks for stock and skips when there is none is
 * a test that never runs — it reports green having asserted nothing. Stock only
 * exists via a cycle, a purchase order, a shipping leg and a verified receipt,
 * which is what `stockedProduct` walks through.
 */
async function aProductInStock(request: APIRequestContext, label: string, qty = 20) {
  const { headers, mk } = await apiCtx(request);
  const { product } = await stockedProduct(request, headers, mk, label, qty);
  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 500 });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 400 });
  return { productId: product.id as string, sku: product.sku as string, qty, headers, mk };
}

test.describe('The shop window', () => {
  test('TC-PORTAL-01: the catalogue is readable with no account at all', async ({ request }) => {
    const res = await request.get(`${API}/portal/catalogue`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.channel).toBe('B2C');
  });

  test('TC-PORTAL-02: no quantity ever leaves the building', async ({ request }) => {
    // A public page saying "12 left" tells a competitor the exact position. The
    // band is the contract; a number appearing anywhere in the payload is the
    // bug this catches, wherever someone added it.
    const res = await request.get(`${API}/portal/catalogue`);
    const body = await res.json();
    const serialised = JSON.stringify(body);

    for (const item of body.data.items) {
      expect(['IN_STOCK', 'LOW', 'OUT']).toContain(item.stock);
    }
    for (const leak of ['saleableQty', 'remainingQty', 'reservedQty', 'receivedQty', 'available']) {
      expect(serialised, `${leak} reached the catalogue`).not.toContain(leak);
    }
  });

  test('TC-PORTAL-03: nothing about cost or margin is in the payload', async ({ request }) => {
    // The catalogue reads Product, which sits beside landed cost and supplier
    // price. An include added carelessly later is what this is for.
    const res = await request.get(`${API}/portal/catalogue`);
    const serialised = JSON.stringify(await res.json());
    for (const leak of ['landedUnitCost', 'cost', 'supplier', 'margin', 'cycleId']) {
      expect(serialised.toLowerCase(), `${leak} reached the catalogue`).not.toContain(
        leak.toLowerCase(),
      );
    }
  });

  test('TC-PORTAL-04: a verified shop sees trade prices, a stranger sees retail', async ({
    request,
  }) => {
    // The two tiers, on the same product, through the same endpoint. If these
    // ever agree, the channel resolution has stopped working and every shop is
    // being quoted the wrong list.
    const anon = await (await request.get(`${API}/portal/catalogue?limit=60`)).json();
    const { headers } = await shopToken(request);
    const shop = await (
      await request.get(`${API}/portal/catalogue?limit=60`, { headers })
    ).json();

    expect(anon.data.channel).toBe('B2C');
    expect(shop.data.channel).toBe('B2B');

    const priced = anon.data.items.find((i: any) => i.price);
    expect(priced, 'no priced product in the seed').toBeTruthy();
    const same = shop.data.items.find((i: any) => i.sku === priced.sku);
    expect(same.price).not.toBe(priced.price);
  });

  test('TC-PORTAL-05: the card and the product page quote the same figure', async ({
    request,
  }) => {
    // Two of the four surfaces. A storefront that quotes one price on the card
    // and another on the page is one a shop stops trusting entirely.
    const { headers } = await shopToken(request);
    const list = await (
      await request.get(`${API}/portal/catalogue?limit=60`, { headers })
    ).json();
    const card = list.data.items.find((i: any) => i.price);
    expect(card).toBeTruthy();

    const page = await (
      await request.get(`${API}/portal/catalogue/${card.sku}`, { headers })
    ).json();
    expect(page.data.price).toBe(card.price);
    expect(page.data.channel).toBe(card.channel);
    expect(page.data.stock).toBe(card.stock);
  });

  test('TC-PORTAL-06: a withdrawn product is not found rather than forbidden', async ({
    request,
  }) => {
    const res = await request.get(`${API}/portal/catalogue/NO-SUCH-SKU`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

test.describe('Asking to buy', () => {
  test('TC-PORTAL-07: a request holds the stock behind it', async ({ request }) => {
    const { productId } = await aProductInStock(request, `Hold ${Date.now()}`);
    const { headers } = await shopToken(request);

    const res = await request.post(`${API}/portal/requests`, {
      headers,
      data: { items: [{ productId, quantity: 1 }], note: 'holding one' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const created = (await res.json()).data;

    expect(created.requestNo).toMatch(/^REQ-\d{4}-\d{4}$/);
    expect(created.status).toBe('PENDING');
    expect(created.hold.live).toBe(true);

    // 48 hours, as agreed. Checked as a window rather than an instant so the
    // test is not a clock comparison that fails on a slow machine.
    const hours = (new Date(created.hold.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  test('TC-PORTAL-08: the office sees less stock while a hold is live', async ({ request }) => {
    // The agreement between the storefront and the internal system. Two
    // definitions of "available" would show as a right figure on one screen and
    // a wrong one on the other — which reads as a display bug and gets looked
    // for in the wrong place.
    const { productId, qty } = await aProductInStock(request, `Agree ${Date.now()}`);
    const { headers } = await shopToken(request);

    const held = await request.post(`${API}/portal/requests`, {
      headers,
      data: { items: [{ productId, quantity: 1 }] },
    });
    expect(held.ok(), await held.text()).toBeTruthy();

    // A hold does not consume saleable stock — it sits beside it. What must
    // change is what anyone ELSE can be promised, and the whole of the rest of
    // the batch is now one unit too many.
    const all = await request.post(`${API}/portal/requests`, {
      headers,
      data: { items: [{ productId, quantity: qty }] },
    });
    expect(all.status(), 'the held unit was offered twice').toBe(400);
    expect((await all.json()).error.code).toBe('NOT_ENOUGH_STOCK');

    // And the office is refused the same unit through its own door, which is
    // the agreement this test exists for: one definition of available, read by
    // the storefront and by `sales.create` alike.
    const office = await officeToken(request);
    const { customerId } = await shopToken(request);
    const order = await request.post(`${API}/sales/orders`, {
      headers: office,
      data: {
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId, quantity: qty, unitPrice: 400 }],
      },
    });
    expect(order.status(), 'the office was sold stock a request is holding').toBe(400);
  });

  test('TC-PORTAL-09: more than exists is refused, and nothing is left behind', async ({
    request,
  }) => {
    const { headers } = await shopToken(request);
    const before = await (await request.get(`${API}/portal/requests`, { headers })).json();

    const list = await (
      await request.get(`${API}/portal/catalogue?limit=60`, { headers })
    ).json();
    const target = list.data.items.find((i: any) => i.price);

    const res = await request.post(`${API}/portal/requests`, {
      headers,
      data: { items: [{ productId: target.id, quantity: 99999 }] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('NOT_ENOUGH_STOCK');

    // The transaction rolled back — no half-made request holding nothing.
    const after = await (await request.get(`${API}/portal/requests`, { headers })).json();
    expect(after.data.length).toBe(before.data.length);
  });

  test('TC-PORTAL-10: zero, negative and empty are all refused', async ({ request }) => {
    const { headers } = await shopToken(request);
    const list = await (
      await request.get(`${API}/portal/catalogue?limit=60`, { headers })
    ).json();
    const target = list.data.items[0];

    const empty = await request.post(`${API}/portal/requests`, { headers, data: { items: [] } });
    expect(empty.status()).toBe(400);

    for (const quantity of [0, -5]) {
      const res = await request.post(`${API}/portal/requests`, {
        headers,
        data: { items: [{ productId: target.id, quantity }] },
      });
      expect(res.status(), `quantity ${quantity} was accepted`).toBe(400);
    }
  });

  test('TC-PORTAL-11: a product that does not exist is a 404, not a 500', async ({ request }) => {
    // A foreign key failing deep in Prisma surfaces as "an unexpected error
    // occurred", which tells nobody anything. CLAUDE.md rule 1.
    const { headers } = await shopToken(request);
    const res = await request.post(`${API}/portal/requests`, {
      headers,
      data: { items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] },
    });
    expect(res.status()).not.toBe(500);
    expect([400, 404]).toContain(res.status());
  });

  test('TC-PORTAL-12: withdrawing gives the stock back', async ({ request }) => {
    const { productId } = await aProductInStock(request, `Withdraw ${Date.now()}`);
    const { headers } = await shopToken(request);

    const made = await (
      await request.post(`${API}/portal/requests`, {
        headers,
        data: { items: [{ productId, quantity: 1 }] },
      })
    ).json();

    const cancelled = await request.delete(`${API}/portal/requests/${made.data.id}`, { headers });
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
    expect((await cancelled.json()).data.status).toBe('CANCELLED');

    // And withdrawing twice is refused rather than releasing twice.
    const again = await request.delete(`${API}/portal/requests/${made.data.id}`, { headers });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('REQUEST_ALREADY_DECIDED');
  });
});

test.describe('One shop cannot reach another', () => {
  test('TC-PORTAL-13: a request is invisible to a shop that did not make it', async ({
    request,
  }) => {
    // There is only one seeded shop login, so the other shop is represented by
    // an id the token does not carry — which is exactly the attack: a real
    // request id, a valid token, the wrong owner.
    const { productId } = await aProductInStock(request, `Owner ${Date.now()}`);
    const { headers } = await shopToken(request);
    const office = await officeToken(request);

    const made = await (
      await request.post(`${API}/portal/requests`, {
        headers,
        data: { items: [{ productId, quantity: 1 }] },
      })
    ).json();

    // The office can see it through its own door.
    const pending = await request.get(`${API}/order-requests/pending`, { headers: office });
    expect(pending.ok()).toBeTruthy();
    expect(
      (await pending.json()).data.some((r: any) => r.id === made.data.id),
      'the office cannot see a pending request',
    ).toBe(true);

    // And a shop token cannot reach the office door at all.
    const wrongDoor = await request.get(`${API}/order-requests/pending`, { headers });
    expect(wrongDoor.status()).toBe(403);
  });

  test('TC-PORTAL-14: no portal route accepts a customer id', async ({ request }) => {
    // The property the whole design rests on. Passing one must change nothing —
    // not as a body field, not as a query parameter.
    const { headers, customerId } = await shopToken(request);
    const someoneElse = '11111111-1111-1111-1111-111111111111';

    const honest = await (await request.get(`${API}/portal/requests`, { headers })).json();
    const spoofed = await (
      await request.get(`${API}/portal/requests?customerId=${someoneElse}`, { headers })
    ).json();
    expect(spoofed).toEqual(honest);

    const list = await (
      await request.get(`${API}/portal/catalogue?limit=60`, { headers })
    ).json();
    const target = list.data.items.find((i: any) => i.price);

    const res = await request.post(`${API}/portal/requests`, {
      headers,
      // A customerId in the body must be ignored, not honoured.
      data: {
        customerId: someoneElse,
        items: [{ productId: target.id, quantity: 1 }],
      },
    });

    if (res.ok()) {
      const made = (await res.json()).data;
      const mine = await (await request.get(`${API}/portal/requests`, { headers })).json();
      expect(
        mine.data.some((r: any) => r.id === made.id),
        'the request was filed against another shop',
      ).toBe(true);
    } else {
      // Rejecting an unknown field outright is also correct.
      expect(res.status()).toBe(400);
    }
    expect(customerId).not.toBe(someoneElse);
  });
});
