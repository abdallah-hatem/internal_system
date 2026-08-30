/**
 * Building blocks for tests that need money to be real.
 *
 * A balance only exists behind a confirmed order, a confirmed order needs
 * stock, and stock only comes from a cycle with a purchase order, a shipping
 * leg and a verified receipt. Three suites had each grown their own copy of
 * that chain, and a fourth had skipped it and tested against draft orders —
 * which owe nothing, so the rules it meant to exercise never applied.
 *
 * Laborious to set up is a fact about the domain, not a reason to fake it.
 */
import { expect, APIRequestContext } from '@playwright/test';

export const API = 'http://localhost:3001/api/v1';
export const EMAIL = 'partner.a@motoparts.com';
export const PASSWORD = 'password123';

/** A date `n` days back, for shipments that have already happened. */
export const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

export const today = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

export type Mk = (path: string, data: any) => Promise<any>;

/**
 * Somebody who can actually hold a share of a cycle.
 *
 * Tests used to take `users[0]` and get whichever account was newest. Once the
 * storefront existed that was a shop owner, and a shop owner on a cycle means a
 * share of the partners' profit at settlement — so the server refuses it now,
 * and a fixture that reached for one was building a state the business does not
 * recognise.
 *
 * Prefers the seeded temporary investor. A core partner is the fallback, and is
 * legitimate: putting extra money in beside your own share is a real thing an
 * owner does, and `docs/business-rules.md` says so.
 */
export async function aCorePartnerUser(request: APIRequestContext, headers: any) {
  const res = await request.get(`${API}/users`, { headers });
  const body = await res.json();
  const users: any[] = body.data?.items ?? body.data ?? body;

  const partner = users.find((u) => u.status === 'ACTIVE' && u.role === 'CORE_PARTNER');
  expect(partner, 'no core partner in the seed').toBeTruthy();
  return partner;
}

export async function anInvestorUser(request: APIRequestContext, headers: any) {
  const res = await request.get(`${API}/users`, { headers });
  const body = await res.json();
  const users: any[] = body.data?.items ?? body.data ?? body;

  const eligible = users.filter(
    (u) => u.status === 'ACTIVE' && (u.role === 'TEMP_INVESTOR' || u.role === 'CORE_PARTNER'),
  );
  const investor = eligible.find((u) => u.role === 'TEMP_INVESTOR') ?? eligible[0];
  expect(investor, 'no user in the seed can be a cycle participant').toBeTruthy();
  return investor;
}

/** An authenticated context plus a POST helper that fails loudly. */
export async function apiCtx(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const headers = { Authorization: `Bearer ${(await auth.json()).data.accessToken}` };

  const mk: Mk = async (path, data) => {
    const res = await request.post(`${API}/${path}`, { headers, data });
    expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    return body.data ?? body;
  };

  return { headers, mk };
}

/**
 * Put `qty` units of an existing product into stock.
 *
 * A product with none cannot be put on an order at all now — the picker
 * disables it and the server refuses — so any fixture that builds a product
 * and then sells it has to bring it into existence properly first.
 */
export async function giveStock(
  request: APIRequestContext,
  headers: any,
  mk: Mk,
  productId: string,
  label: string,
  qty = 100,
) {
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId, orderedQty: qty, unitPrice: 10 }],
  });
  // The departure and arrival dates are the point: a cycle cannot pass a stage
  // its shipment has not reached, so stock cannot exist without them.
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: `${label} Freight`, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    departedOn: daysAgo(20), arrivedOn: daysAgo(5),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', {
    cycleId: cycle.id,
    items: [{ purchaseOrderItemId: poItem.id, productId, receivedQty: qty }],
  });
  return { supplier, cycle };
}

/** A product with `qty` units genuinely received into stock. */
export async function stockedProduct(
  request: APIRequestContext,
  headers: any,
  mk: Mk,
  label: string,
  qty = 100,
  /** Optional, so a test can filter by a category nothing else can be in. */
  categoryId?: string,
) {
  const product = await mk('products', {
    name: `${label} Part`,
    minStock: 0,
    ...(categoryId ? { categoryId } : {}),
  });
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });

  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: qty, unitPrice: 10 }],
  });
  // The departure and arrival dates are the point: a cycle cannot pass a stage
  // its shipment has not reached, so stock cannot exist without them.
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: `${label} Freight`, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    departedOn: daysAgo(20), arrivedOn: daysAgo(5),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }

  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', {
    cycleId: cycle.id,
    items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: qty }],
  });

  return { product, supplier, cycle };
}

/** An order this customer genuinely owes — confirmed, so it counts. */
export async function owedOrder(mk: Mk, customerId: string, productId: string, amount: number) {
  const order = await mk('sales/orders', {
    customerId, channel: 'B2B', currency: 'EGP',
    items: [{ productId, quantity: 1, unitPrice: amount, discount: 0 }],
  });
  await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
  return order;
}

/** What an order still owes, straight from the API. */
export async function outstandingOf(request: APIRequestContext, headers: any, id: string) {
  const res = await request.get(`${API}/sales/orders/${id}`, { headers });
  return Number(((await res.json()).data ?? {}).outstanding);
}
