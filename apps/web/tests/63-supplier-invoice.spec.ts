import { test, expect, APIRequestContext } from '@playwright/test';

import { API, apiCtx, daysAgo, Mk } from './support/fixtures';

/**
 * A supplier's invoice is recorded once — BUSINESS_LOGIC.md §15.
 *
 * Receipts are about to arrive by photograph, and the same photo sent twice —
 * by two partners, or by one who was not sure it went through — would otherwise
 * become two purchase orders: double the stock and double the landed cost of a
 * cycle. The supplier's own invoice number is the only thing that recognises
 * the same piece of paper, so it is unique per supplier, compared trimmed and
 * case-insensitively. A receipt with no number is allowed and never checked.
 *
 * Every order here is built the way the office builds one: a real supplier, a
 * real product, a cycle still in PLANNING, where the wizard creates its order.
 */

const stamp = () => Math.random().toString(36).slice(2, 8);

type Ctx = { request: APIRequestContext; headers: Record<string, string>; mk: Mk };

async function setup(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  return { ctx: { request, headers, mk } as Ctx, supplier, product, cycle };
}

/** The order body the office sends, plus whatever this test is about. */
function body(supplierId: string, productId: string, extra: Record<string, unknown> = {}) {
  return {
    supplierId,
    currency: 'AED',
    fxRateToEgp: 13.85,
    orderedOn: daysAgo(5),
    items: [{ productId, orderedQty: 10, unitPrice: 25 }],
    ...extra,
  };
}

/** A POST that does not fail the test on refusal, so the refusal can be read. */
async function attempt(ctx: Ctx, cycleId: string, data: unknown) {
  const res = await ctx.request.post(`${API}/cycles/${cycleId}/purchases`, {
    headers: ctx.headers,
    data,
  });
  const json = await res.json();
  return { status: res.status(), data: json.data, error: json.error };
}

async function ordersOn(ctx: Ctx, cycleId: string): Promise<any[]> {
  const res = await ctx.request.get(`${API}/cycles/${cycleId}/purchases`, { headers: ctx.headers });
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  return json.data ?? json;
}

test.describe('A supplier invoice is recorded once', () => {
  test('same supplier, same invoice number twice: the second is refused and nothing is written', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `Dup${stamp()}`);

    const first = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'INV-001' }));
    expect(first.status, JSON.stringify(first.error)).toBe(201);

    const second = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'INV-001' }));
    expect(second.status).toBe(400);
    expect(second.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
    // The refusal names the order that already holds it, so the partner can go and look.
    expect(second.error.params).toMatchObject({
      ref: 'INV-001',
      supplier: supplier.name,
      purchaseOrder: first.data.reference,
    });

    const orders = await ordersOn(ctx, cycle.id);
    expect(orders, 'the refused receipt still became an order').toHaveLength(1);
    expect(orders[0].items, 'the refused receipt still added lines').toHaveLength(1);
  });

  test('" inv-001 " then "INV-001" for one supplier: the second is refused', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `Case${stamp()}`);

    const first = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: ' inv-001 ' }));
    expect(first.status, JSON.stringify(first.error)).toBe(201);
    expect(first.data.supplierInvoiceRef, 'stored as typed, not normalised').toBe('INV-001');

    const second = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'INV-001' }));
    expect(second.status).toBe(400);
    expect(second.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(await ordersOn(ctx, cycle.id)).toHaveLength(1);
  });

  test('the same invoice on a different cycle of the same supplier is still refused', async ({ request }) => {
    // The wrong context: a second cycle does not make it a second receipt.
    const { ctx, supplier, product, cycle } = await setup(request, `Cyc${stamp()}`);
    const otherCycle = await ctx.mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    const first = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'INV-9' }));
    expect(first.status, JSON.stringify(first.error)).toBe(201);

    const second = await attempt(ctx, otherCycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'inv-9' }));
    expect(second.status).toBe(400);
    expect(second.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(await ordersOn(ctx, otherCycle.id)).toHaveLength(0);
  });

  test('same invoice number, different suppliers: both are accepted', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `Two${stamp()}`);
    const otherSupplier = await ctx.mk('suppliers', { name: `Other ${stamp()} Supplier`, country: 'CN' });

    const a = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'INV-001' }));
    const b = await attempt(ctx, cycle.id, body(otherSupplier.id, product.id, { supplierInvoiceRef: 'INV-001' }));
    expect(a.status, JSON.stringify(a.error)).toBe(201);
    expect(b.status, JSON.stringify(b.error)).toBe(201);
    expect(await ordersOn(ctx, cycle.id)).toHaveLength(2);
  });

  test('no invoice number, twice, same supplier: both are accepted', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `None${stamp()}`);

    const a = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: null }));
    const b = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: null }));
    expect(a.status, JSON.stringify(a.error)).toBe(201);
    expect(b.status, JSON.stringify(b.error)).toBe(201);
    expect(a.data.supplierInvoiceRef).toBeNull();
    expect(b.data.supplierInvoiceRef).toBeNull();
  });

  test('an empty string is stored as absent, and does not collide with the next blank', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `Blank${stamp()}`);

    const a = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: '' }));
    expect(a.status, JSON.stringify(a.error)).toBe(201);
    expect(a.data.supplierInvoiceRef, 'an empty invoice number was stored as ""').toBeNull();

    // Whitespace is blank too: stored as "" it would make every later blank a duplicate.
    const b = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: '   ' }));
    expect(b.status, JSON.stringify(b.error)).toBe(201);
    expect(b.data.supplierInvoiceRef).toBeNull();
  });

  test('a purchase order created without the field still works', async ({ request }) => {
    // The office app does not send the field. It must keep working unchanged.
    const { ctx, supplier, product, cycle } = await setup(request, `Plain${stamp()}`);

    const po = await attempt(ctx, cycle.id, body(supplier.id, product.id));
    expect(po.status, JSON.stringify(po.error)).toBe(201);
    expect(po.data.reference).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(po.data.supplierInvoiceRef).toBeNull();

    const again = await attempt(ctx, cycle.id, body(supplier.id, product.id));
    expect(again.status, JSON.stringify(again.error)).toBe(201);
  });

  test('an invoice number longer than 64 characters is refused', async ({ request }) => {
    const { ctx, supplier, product, cycle } = await setup(request, `Long${stamp()}`);

    const tooLong = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'X'.repeat(65) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.error.code).toBe('VALIDATION_FAILED');
    expect(tooLong.error.params?.fields).toContain('supplierInvoiceRef');
    expect(await ordersOn(ctx, cycle.id)).toHaveLength(0);

    // The limit, not one short of it: exactly 64 is a valid number.
    const atLimit = await attempt(ctx, cycle.id, body(supplier.id, product.id, { supplierInvoiceRef: 'X'.repeat(64) }));
    expect(atLimit.status, JSON.stringify(atLimit.error)).toBe(201);
  });

  test('the same receipt sent twice at once becomes one order, and the other is a refusal, not a 500', async ({ request }) => {
    // Both requests can pass the service's check before either commits; the
    // unique index has to stop the second, and say so in the same words.
    const { ctx, supplier, product, cycle } = await setup(request, `Race${stamp()}`);
    const data = body(supplier.id, product.id, { supplierInvoiceRef: 'INV-RACE' });

    const results = await Promise.all([
      attempt(ctx, cycle.id, data),
      attempt(ctx, cycle.id, data),
      attempt(ctx, cycle.id, data),
    ]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const refused of results.filter((r) => r.status !== 201)) {
      expect(refused.status, JSON.stringify(refused.error)).toBe(400);
      expect(refused.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
    }
    expect(await ordersOn(ctx, cycle.id)).toHaveLength(1);
  });
});
