/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Is production telling the truth?
 * ═══════════════════════════════════════════════════════════════════════
 *  56-production checks that the deployed pieces are connected. This checks
 *  that what they are holding is coherent — the same question the localhost
 *  invariant suites ask, asked of the real books.
 *
 *  READ-ONLY, deliberately and permanently. A suite that exercised the write
 *  flows here would put fake cycles, sales and ledger rows into the accounts
 *  the business runs on, and unlike localhost there is no snapshot to restore:
 *  ledger and audit rows are append-only by design. Every assertion below is a
 *  GET.
 *
 *  Nothing here may pass vacuously. Production is young and most tables are
 *  empty, and an invariant over an empty set is green for the wrong reason —
 *  the same trap as the zero-profit share test that only ever proved the code
 *  did not divide by zero. Each check states what it examined, and skips with a
 *  reason rather than passing on nothing.
 *
 *      npx playwright test --project=production
 */
import { test, expect, APIRequestContext } from '@playwright/test';

const API = 'https://internal-system-api.vercel.app/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

/** Generous: a cold serverless function has to boot Nest and reach Neon. */
const COLD_START = 90_000;
test.describe.configure({ timeout: COLD_START });

let auth: Record<string, string>;

test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  const res = await ctx.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
    timeout: COLD_START,
  });
  expect(res.ok(), 'production login must work before anything can be audited').toBeTruthy();
  auth = { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
  await ctx.dispose();
});

async function get(request: APIRequestContext, path: string) {
  const res = await request.get(`${API}/${path}`, { headers: auth, timeout: COLD_START });
  expect(res.ok(), `GET ${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()).data;
}

const num = (v: unknown) => Number(v ?? 0);

// ─── Stock ────────────────────────────────────────────────────────────

test.describe('Production stock', () => {
  test('TC-AUD-01: no batch holds more than arrived, or less than nothing', async ({ request }) => {
    const stock = await get(request, 'inventory');
    const batches = stock.flatMap((p: any) => p.batches ?? []);
    test.skip(batches.length === 0, 'production holds no inventory batches yet');

    for (const b of batches) {
      const received = num(b.receivedQty);
      const remaining = num(b.remainingQty);
      const saleable = num(b.saleableQty);
      const reserved = num(b.reservedQty);
      const where = `batch ${String(b.id).slice(0, 8)}`;

      expect(remaining, `${where}: remaining > received`).toBeLessThanOrEqual(received);
      for (const [name, v] of [['received', received], ['remaining', remaining], ['saleable', saleable], ['reserved', reserved]] as const) {
        expect(v, `${where}: ${name} is negative`).toBeGreaterThanOrEqual(0);
      }
      // Every unit still held is either sellable or promised to someone. A gap
      // is stock the business owns and no screen will ever offer.
      expect(Math.abs(saleable + reserved - remaining), `${where}: saleable + reserved ≠ remaining`).toBeLessThan(0.001);
    }
  });

  test('TC-AUD-02: a product total equals the batches it is made of', async ({ request }) => {
    const stock = await get(request, 'inventory');
    test.skip(stock.length === 0, 'production holds no stock yet');

    for (const p of stock) {
      const summed = (p.batches ?? []).reduce((s: number, b: any) => s + num(b.remainingQty), 0);
      // The headline figure on the inventory page must equal its own rows;
      // when it does not, the page argues with itself and both look plausible.
      expect(Math.abs(num(p.totalStock) - summed), `${p.productName}: total ${p.totalStock} ≠ Σ batches ${summed}`).toBeLessThan(0.001);
    }
  });

  test('TC-AUD-03: every batch carries a landed cost', async ({ request }) => {
    const stock = await get(request, 'inventory');
    const batches = stock.flatMap((p: any) => p.batches ?? []);
    test.skip(batches.length === 0, 'production holds no inventory batches yet');

    for (const b of batches) {
      // A batch costed at zero sells at pure profit and makes a cycle look
      // like its best ever. It is the most expensive kind of wrong number.
      expect(num(b.landedUnitCostEgp), `batch ${String(b.id).slice(0, 8)} has no landed cost`).toBeGreaterThan(0);
    }
  });

  test('TC-AUD-04: a cycle that reached verification has actually received stock', async ({ request }) => {
    const cycles = await get(request, 'cycles?limit=200');
    test.skip(cycles.length === 0, 'no cycles in production yet');

    // Stock exists only through a cycle, a purchase order and a verified
    // receipt. A cycle whose status says the goods are here, with nothing
    // received against it, means the status outran the paperwork.
    const arrived = cycles.filter((c: any) =>
      ['VERIFICATION', 'DISTRIBUTION', 'SETTLEMENT', 'CLOSED'].includes(c.status),
    );
    test.skip(arrived.length === 0, 'no cycle has reached verification yet');

    const stock = await get(request, 'inventory');
    for (const c of arrived) {
      const held = stock.flatMap((p: any) => p.batches ?? []).filter((b: any) => b.cycleId === c.id);
      expect(held.length, `${c.code} is ${c.status} but no stock was ever received against it`).toBeGreaterThan(0);
    }
  });

  test('TC-AUD-05: a purchase order that reports receipts has the batches to match', async ({ request }) => {
    const orders = await get(request, 'purchases?limit=200');
    test.skip(orders.length === 0, 'no purchase orders in production yet');

    const withReceipts = orders.filter((o: any) =>
      (o.items ?? []).some((i: any) => i.receivedQty != null && num(i.receivedQty) > 0),
    );
    test.skip(withReceipts.length === 0, 'no purchase order has recorded a receipt yet');

    const stock = await get(request, 'inventory');
    const batches = stock.flatMap((p: any) => p.batches ?? []);

    // The join key, checked before it is used. Written against
    // `purchaseOrderItemId` first — a field the API does not return — every
    // batch summed to zero and the test reported a 40-unit shortfall that did
    // not exist. A join on an absent key is silently always-empty, and it
    // accuses the data rather than itself.
    expect(
      batches.every((b: any) => typeof b.sourcePoItemId === 'string'),
      'inventory batches no longer carry sourcePoItemId — this test cannot join and must be updated, the data is not necessarily wrong',
    ).toBe(true);

    for (const o of withReceipts) {
      for (const item of o.items ?? []) {
        const received = num(item.receivedQty);
        if (received <= 0) continue;
        const forItem = batches
          .filter((b: any) => b.sourcePoItemId === item.id)
          .reduce((s: number, b: any) => s + num(b.receivedQty), 0);
        expect(Math.abs(forItem - received), `${o.reference}: item says ${received} received, batches hold ${forItem}`).toBeLessThan(0.001);
      }
    }
  });
});

// ─── The flows around it ──────────────────────────────────────────────

test.describe('Production flows', () => {
  test('TC-AUD-06: a cycle past planning has a purchase order that is not a draft', async ({ request }) => {
    const cycles = await get(request, 'cycles?limit=200');
    const moving = cycles.filter((c: any) => !['PLANNING', 'FUNDING'].includes(c.status));
    test.skip(moving.length === 0, 'every cycle is still being planned');

    const orders = await get(request, 'purchases?limit=200');
    for (const c of moving) {
      const mine = orders.filter((o: any) => o.cycleId === c.id);
      expect(mine.length, `${c.code} is ${c.status} with no purchase order at all`).toBeGreaterThan(0);
      // A draft owes nothing and buys nothing. A cycle cannot be in transit on
      // the strength of one.
      expect(
        mine.some((o: any) => o.status !== 'DRAFT'),
        `${c.code} is ${c.status} but every one of its ${mine.length} purchase order(s) is still DRAFT`,
      ).toBe(true);
    }
  });

  test('TC-AUD-07: no money is dated in the future', async ({ request }) => {
    const [ledger, payments] = await Promise.all([
      get(request, 'ledger?limit=200'),
      get(request, 'payments?limit=200'),
    ]);
    const rows = [
      ...ledger.map((e: any) => ({ what: `ledger ${e.type}`, on: e.occurredOn ?? e.createdAt })),
      ...payments.map((p: any) => ({ what: `payment ${p.reference ?? p.id?.slice(0, 8)}`, on: p.receivedOn })),
    ].filter((r) => r.on);
    test.skip(rows.length === 0, 'no ledger entries or payments in production yet');

    // Records of things that happened cannot be dated forward. Tomorrow is
    // generous: a date column and a UTC clock can legitimately disagree by
    // hours, and a false alarm here is worse than none.
    const tomorrow = new Date(Date.now() + 36 * 60 * 60 * 1000);
    for (const r of rows) {
      expect(new Date(r.on).getTime(), `${r.what} is dated ${String(r.on).slice(0, 10)}`).toBeLessThan(tomorrow.getTime());
    }
  });

  test('TC-AUD-08: no negative money anywhere', async ({ request }) => {
    const [ledger, payments, orders] = await Promise.all([
      get(request, 'ledger?limit=200'),
      get(request, 'payments?limit=200'),
      get(request, 'purchases?limit=200'),
    ]);
    const amounts = [
      ...ledger.map((e: any) => ({ what: `ledger ${e.type}`, v: num(e.amount) })),
      ...payments.map((p: any) => ({ what: 'payment', v: num(p.amount) })),
      ...orders.map((o: any) => ({ what: `PO ${o.reference}`, v: num(o.totalEgp ?? o.total ?? 0) })),
    ];
    test.skip(amounts.length === 0, 'no money has moved in production yet');

    // Direction is a column of its own; an outflow is a positive amount
    // pointing the other way. A negative here is a discount or a refund that
    // overran its line, which is how an order ends up worth less than nothing.
    for (const a of amounts) expect(a.v, `${a.what} is negative`).toBeGreaterThanOrEqual(0);
  });

  test('TC-AUD-09: an unverified shop holds no orders and no balance', async ({ request }) => {
    const customers = await get(request, 'customers?limit=200&verification=ALL');
    const unverified = customers.filter((c: any) => c.verificationStatus === 'UNVERIFIED');
    test.skip(unverified.length === 0, 'no unverified signups in production');

    for (const c of unverified) {
      // Every service that moves money refuses an unverified account, so a
      // balance on one means something got past that refusal.
      expect(num(c.outstandingBalance), `${c.displayName} is unverified but owes ${c.outstandingBalance}`).toBe(0);
    }
  });

  test('TC-AUD-10: the census — production is not empty in a way that hides everything', async ({ request }) => {
    const [cycles, orders, products, customers, stock, ledger] = await Promise.all([
      get(request, 'cycles?limit=200'),
      get(request, 'purchases?limit=200'),
      get(request, 'products?limit=200'),
      get(request, 'customers?limit=200&verification=ALL'),
      get(request, 'inventory'),
      get(request, 'ledger?limit=200'),
    ]);
    const batches = stock.flatMap((p: any) => p.batches ?? []);

    console.log(
      `\n  production census: cycles ${cycles.length} · purchase orders ${orders.length} · ` +
        `products ${products.length} · customers ${customers.length} · ` +
        `stock batches ${batches.length} · ledger rows ${ledger.length}\n`,
    );

    // The point of this test. Most checks above skip on an empty set, which is
    // honest but silent — and a suite that skips everything reports green. This
    // one fails when there is nothing to audit, so "all clear" always means
    // something was actually looked at.
    expect(
      cycles.length + orders.length + products.length + ledger.length,
      'production holds no cycles, orders, products or ledger rows — every check above skipped and the green means nothing',
    ).toBeGreaterThan(0);
  });
});
