/**
 * L5 (BUSINESS_LOGIC §8): a cycle with leftovers, and one to take them —
 * built the way the business builds them, for 99-leftover-transfer and the
 * money invariants in 34.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { aCorePartnerUser, API, apiCtx, daysAgo, PASSWORD } from './fixtures';

const INVESTOR_EMAIL = 'investor@motoparts.com';

/**
 * A: 40 brake pads at 100 (free freight: 100.00 a unit landed), funded 4,000
 * by a partner, all delivered and checked in — selling — and 10 sold at 200.
 * 30 are left on the shelf. B: a new cycle, still being planned.
 * `investor`: the seeded investor is on both, so he can open them.
 */
export async function leftoverWorld(
  request: APIRequestContext,
  label: string,
  opts: { investor?: boolean; bFunding?: number } = {},
) {
  const { headers, mk } = await apiCtx(request);
  const partner = await aCorePartnerUser(request, headers);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let investorId: string | undefined;
  if (opts.investor) {
    const login = await request.post(`${API}/auth/login`, { data: { email: INVESTOR_EMAIL, password: PASSWORD } });
    const token = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    const me = await (await request.get(`${API}/auth/profile`, { headers: token })).json();
    investorId = (me.data?.data ?? me.data ?? me).id;
  }
  const investorRow = investorId
    ? [{ participantType: 'TEMP_INVESTOR', investorUserId: investorId, contributionAmount: 0 }]
    : [];
  const pad = await mk('products', { name: `${label} ${stamp} Brake pad`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Supplier`, country: 'AE' });
  const customer = await mk('customers', { displayName: `${label} ${stamp} Shop`, type: 'B2B' });

  const a = await mk('cycles', {
    originType: 'UAE_DIRECT',
    currency: 'EGP',
    participants: [{ participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: 4000 }, ...investorRow],
  });
  await mk(`cycles/${a.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: pad.id, orderedQty: 40, unitPrice: 100 }],
  });
  await mk(`cycles/${a.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', provider: `${label} Freight`,
    costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(20), arrivedOn: daysAgo(5),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${a.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${a.id}`, { headers })).json();
  const poItem = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', { cycleId: a.id, items: [{ purchaseOrderItemId: poItem.id, productId: pad.id, receivedQty: 40 }] });
  const order = await mk('sales/orders', {
    customerId: customer.id, channel: 'B2B', currency: 'EGP',
    items: [{ productId: pad.id, quantity: 10, unitPrice: 200, discount: 0 }],
  });
  await mk(`sales/orders/${order.id}/confirm`, { version: order.version });

  const b = await mk('cycles', {
    originType: 'UAE_DIRECT',
    currency: 'EGP',
    participants:
      investorRow.length || opts.bFunding !== undefined
        ? [{ participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: opts.bFunding ?? 0 }, ...investorRow]
        : undefined,
  });
  const aNow = await (await request.get(`${API}/cycles/${a.id}`, { headers })).json();
  expect((aNow.data ?? aNow).status, 'A is selling').toBe('SELLING');
  return { headers, mk, a, b, pad, customer, stamp };
}

