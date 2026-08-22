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

export const today = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

export type Mk = (path: string, data: any) => Promise<any>;

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

/** A product with `qty` units genuinely received into stock. */
export async function stockedProduct(
  request: APIRequestContext,
  headers: any,
  mk: Mk,
  label: string,
  qty = 100,
) {
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });

  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: qty, unitPrice: 10 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    provider: `${label} Freight`, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
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
