/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each caller names the field it reads */
/**
 * L7 (BUSINESS_LOGIC §8): running costs come out of the core partners'
 * payouts. A cycle that sold out, funded by named people, built the way the
 * business builds one — an order, a leg, a check-in, a confirmed sale (§4) —
 * and the readings the running-cost tests compare before and after.
 *
 * Running costs are the whole business's, so whatever earlier specs recorded
 * is waiting too. These helpers read what is waiting rather than assuming
 * nothing is, and the cycles they build fund a payout big enough to take all
 * of it.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, daysAgo, today } from './fixtures';

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
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
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
    spentEgp: string; chargedEgp: string; waitingEgp: string; waitingAllTimeEgp: string;
    partners: { userId: string; name: string; shareEgp: string; chargedEgp: string; waitingEgp: string; takesResidual: boolean }[];
  };
}

export const waitingFor = (rc: Awaited<ReturnType<typeof runningCosts>>, userId: string) =>
  Number(rc.partners.find((p) => p.userId === userId)?.waitingEgp ?? 0);

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
