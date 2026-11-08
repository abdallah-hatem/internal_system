/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each caller names the field it reads */
/**
 * Running costs (BUSINESS_LOGIC §8, 2026-11-08): an expense with no cycle is
 * shared equally to the cycles running on the day it is dated, inside their
 * profit. A cycle that sold out, funded by named people, built the way the
 * business builds one — an order, a leg, a check-in, a confirmed sale (§4) —
 * and the readings the running-cost tests compare before and after.
 *
 * Running costs are the whole business's, so whatever earlier specs recorded
 * is shared too: these helpers read what is there rather than assuming
 * nothing is.
 */
import { expect, type APIRequestContext, type test as Test } from '@playwright/test';
import { API, apiCtx, daysAgo, today } from './fixtures';
import { psqlQuery } from './database';

export type Headers = Record<string, string>;

/** Users by login email, from the partners page's own endpoint. */
export async function usersByEmail(request: APIRequestContext, headers: Headers) {
  const body = await (await request.get(`${API}/users/participation`, { headers })).json();
  const people: any[] = body.data ?? body;
  return (email: string) => {
    const u = people.find((p) => p.email === email);
    expect(u, `user ${email}`).toBeTruthy();
    return u as { id: string; email: string; displayName: string | null };
  };
}

/**
 * A cycle that sold every unit: `qty` at 100 landed, sold at `price` each.
 * `people`: [userId, CORE_PARTNER | TEMP_INVESTOR, contribution, fee %].
 */
export async function soldOutCycle(
  request: APIRequestContext,
  label: string,
  people: [string, 'CORE_PARTNER' | 'TEMP_INVESTOR', number, number?][],
  opts: { qty?: number; price?: number } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const qty = opts.qty ?? 10;
  const price = opts.price ?? 300;
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const part = await mk('products', { name: `${label} ${stamp} Chain`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Supplier`, country: 'AE' });
  const customer = await mk('customers', { displayName: `${label} ${stamp} Shop`, type: 'B2B' });
  const cycle = await mk('cycles', {
    originType: 'UAE_DIRECT',
    currency: 'EGP',
    participants: people.map(([userId, type, contributionAmount, fee]) =>
      type === 'CORE_PARTNER'
        ? { participantType: type, partnerUserId: userId, contributionAmount }
        : { participantType: type, investorUserId: userId, contributionAmount, investorFeePct: fee ?? 0 },
    ),
  });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: part.id, orderedQty: qty, unitPrice: 100 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', provider: `${label} Freight`,
    costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(20), arrivedOn: daysAgo(5),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'PREPARING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', { cycleId: cycle.id, items: [{ purchaseOrderItemId: poItem.id, productId: part.id, receivedQty: qty }] });
  const order = await mk('sales/orders', {
    customerId: customer.id, channel: 'B2B', currency: 'EGP',
    items: [{ productId: part.id, quantity: qty, unitPrice: price, discount: 0 }],
  });
  await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
  return { headers, mk, cycle, customer, order, part, stamp };
}

/** A running cost recorded the way "Record money in or out" records it. */
export async function recordCost(
  request: APIRequestContext,
  headers: Headers,
  body: { category?: string; amount: number; cycleId?: string; occurredOn?: string; note?: string },
) {
  const res = await request.post(`${API}/ledger`, {
    headers,
    data: { kind: 'EXPENSE', category: body.category ?? 'rent', amount: body.amount, currency: 'EGP', occurredOn: body.occurredOn ?? today(), ...(body.cycleId ? { cycleId: body.cycleId } : {}), ...(body.note ? { note: body.note } : {}) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).data;
}

/** The Partners page's figures, over every day there is. */
export async function runningCosts(request: APIRequestContext, headers: Headers, range = { from: '2000-01-01', to: today() }) {
  const res = await request.get(`${API}/settlements/running-costs?from=${range.from}&to=${range.to}`, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data as {
    spentEgp: string; sharedEgp: string; chargedEgp: string; waitingEgp: string; waitingAllTimeEgp: string;
    cycles: { cycleId: string; code: string; status: string; sharedEgp: string }[];
  };
}

/** Calculate and approve; the id of the approved settlement. */
export async function approved(mk: any, cycleId: string) {
  const draft = await mk(`settlements/calculate/${cycleId}`, {});
  await mk(`settlements/${draft.id}/approve`, {});
  return draft.id as string;
}

export async function settlement(request: APIRequestContext, headers: Headers, id: string) {
  const res = await request.get(`${API}/settlements/${id}`, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data;
}

/** The settlement's own ledger rows. */
export async function settlementRows(request: APIRequestContext, headers: Headers, id: string) {
  const rows: any[] = (await (await request.get(`${API}/ledger?limit=200`, { headers })).json()).data;
  return rows.filter((r) => r.relatedId === id);
}

export const cents = (n: number | string) => Math.round(Number(n) * 100);

/**
 * A spec that records running costs owns them (LEARNINGS "A fixture should
 * own what it asserts on"). Since 2026-11-09 a running cost none of whose
 * cycles is settled yet is split again over every cycle that ran on its day
 * (§8) — and in a test run every cycle runs today — so a cost one test left
 * behind would go on moving into every cycle the rest of the run builds, and
 * every exact profit after it would be off by its part. After each test the
 * running costs it recorded are undone, through the API as a person would,
 * unless a settled cycle already holds a part (then it never moves anyway).
 * `ownRunningCosts(test)` in the spec file; `'all'` where the costs are built
 * in `beforeAll` and read by every test.
 */
export function ownRunningCosts(t: typeof Test, scope: 'each' | 'all' = 'each') {
  let since = new Date();
  const start = () => {
    since = new Date();
  };
  const undo = async ({ request }: { request: APIRequestContext }) => undoRunningCostsSince(request, since);
  if (scope === 'all') {
    t.beforeAll(start);
    t.afterAll(undo);
  } else {
    t.beforeEach(start);
    t.afterEach(undo);
  }
}

export async function undoRunningCostsSince(request: APIRequestContext, since: Date) {
  const ids = psqlQuery(`
    SELECT f.id FROM financial_transactions f
     WHERE f.cycle_id IS NULL AND f.type = 'EXPENSE' AND f.direction = 'OUTFLOW'
       AND f.reversal_of_id IS NULL AND f.created_at >= '${since.toISOString()}'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM financial_transactions r WHERE r.reversal_of_id = f.id)
       AND NOT EXISTS (
         SELECT 1 FROM running_cost_allocations a JOIN import_cycles c ON c.id = a.cycle_id
          WHERE a.cost_entry_id = f.id
            AND (c.status IN ('SETTLEMENT', 'CLOSED', 'CANCELLED')
                 OR EXISTS (SELECT 1 FROM settlements s WHERE s.cycle_id = c.id AND s.status IN ('APPROVED', 'PAID'))));`)
    .split('\n')
    .filter(Boolean);
  if (ids.length === 0) return;
  const { headers } = await apiCtx(request);
  const refused: string[] = [];
  for (const id of ids) {
    const res = await request.post(`${API}/ledger/${id}/reverse`, {
      headers,
      data: { reason: 'test clean-up: a running cost this test recorded' },
    });
    if (res.status() >= 500) throw new Error(`undo running cost ${id}: ${await res.text()}`);
    // Refused for its own reason (the partner it credited has taken the money
    // out, TC-PAIDBY-03): parked on a closed cycle of its own instead, as the
    // database suites park theirs (api common/running-costs-quiet-spec.ts).
    if (!res.ok()) refused.push(id);
  }
  if (refused.length === 0) return;
  const list = refused.map((id) => `'${id}'::uuid`).join(', ');
  psqlQuery(`
    WITH sink AS (
      INSERT INTO import_cycles (id, code, origin_type, currency, status, updated_at)
      VALUES (gen_random_uuid(), 'PARK-' || substr(md5(random()::text), 1, 8), 'UAE_DIRECT', 'EGP', 'CLOSED', now())
      RETURNING id)
    , gone AS (DELETE FROM running_cost_allocations WHERE cost_entry_id IN (${list}))
    UPDATE financial_transactions SET cycle_id = (SELECT id FROM sink) WHERE id IN (${list});`);
}
