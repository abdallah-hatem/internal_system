import {
  lineValueNow,
  orderValueNow,
  withValueNow,
  type ValueNowLine,
} from './order-value-now';

/**
 * What an order is worth now (BUSINESS_LOGIC §4, owner 2026-10-22, Option A):
 * sold, less returns at the price refunded, less every price cut. The figures
 * here are the stored ones the order's outstanding was moved by; the db spec
 * (`modules/sales/order-value-now.db.spec.ts`) checks the same against a real
 * order and its outstanding.
 */

const at = (n: number) => new Date(Date.UTC(2026, 9, 20, 10, n));
const batch = 'b1';

function line(
  quantity: number,
  unitPrice: number,
  opts: {
    discount?: number;
    returns?: { qty: number; refund: number }[];
    cuts?: { to: number; amount: number; at?: Date }[];
  } = {},
): ValueNowLine {
  return {
    quantity: String(quantity),
    lineTotal: (quantity * unitPrice - (opts.discount ?? 0)).toFixed(2),
    returnItems: (opts.returns ?? []).map((r) => ({
      qty: String(r.qty),
      refundEgp: r.refund.toFixed(2),
      inventoryBatchId: batch,
    })),
    priceAdjustments: (opts.cuts ?? []).map((c, i) => ({
      newUnitPrice: c.to.toFixed(2),
      amountEgp: c.amount.toFixed(2),
      createdAt: c.at ?? at(i),
    })),
  };
}

const order = (items: ValueNowLine[]) => ({
  total: items.reduce((s, i) => s + Number(i.lineTotal), 0).toFixed(2),
  items,
});

describe('order value now', () => {
  it('nothing returned, nothing lowered: worth what was sold, every line as sold', () => {
    const o = order([line(4, 1250), line(12, 900)]);
    expect(orderValueNow(o)).toBe('15800.00');
    expect(lineValueNow(o.items[0])).toEqual({
      returnedQty: '0',
      heldQty: '4',
      soldUnitPrice: '1250.00',
      unitPriceNow: '1250.00',
      priceCut: false,
      lineValueNow: '5000.00',
    });
  });

  it('returns only: worth less by exactly what was refunded, the price unchanged', () => {
    const o = order([
      line(4, 1250, { returns: [{ qty: 1, refund: 1250 }] }),
      line(12, 900, { returns: [{ qty: 2, refund: 1800 }] }),
    ]);
    expect(orderValueNow(o)).toBe('12750.00');
    expect(lineValueNow(o.items[1])).toMatchObject({
      returnedQty: '2',
      heldQty: '10',
      unitPriceNow: '900.00',
      priceCut: false,
      lineValueNow: '9000.00',
    });
  });

  it('cuts only: worth less by the cut, the line at its new price', () => {
    const o = order([line(4, 1250, { cuts: [{ to: 1150, amount: 400 }] })]);
    expect(orderValueNow(o)).toBe('4600.00');
    expect(lineValueNow(o.items[0])).toMatchObject({
      heldQty: '4',
      soldUnitPrice: '1250.00',
      unitPriceNow: '1150.00',
      priceCut: true,
      lineValueNow: '4600.00',
    });
  });

  it('Koshary (ORD-2026-00002): 30,300 sold, 3,050 back, 100 off the 23 held — worth 24,950', () => {
    const o = order([
      line(4, 1250, {
        returns: [{ qty: 1, refund: 1250 }],
        cuts: [{ to: 1150, amount: 300 }],
      }),
      line(12, 900, {
        returns: [{ qty: 2, refund: 1800 }],
        cuts: [{ to: 800, amount: 1000 }],
      }),
      line(10, 1450, { cuts: [{ to: 1350, amount: 1000 }] }),
    ]);
    expect(o.total).toBe('30300.00');
    expect(orderValueNow(o)).toBe('24950.00');
    expect(lineValueNow(o.items[0])).toEqual({
      returnedQty: '1',
      heldQty: '3',
      soldUnitPrice: '1250.00',
      unitPriceNow: '1150.00',
      priceCut: true,
      lineValueNow: '3450.00',
    });
  });

  it('a cut, then a cut unit handed back at the lower price: worth the held units at the lower price', () => {
    const o = order([
      line(4, 1250, {
        cuts: [{ to: 1150, amount: 400 }],
        returns: [{ qty: 1, refund: 1150 }],
      }),
    ]);
    expect(orderValueNow(o)).toBe('3450.00');
    expect(lineValueNow(o.items[0])).toMatchObject({
      heldQty: '3',
      unitPriceNow: '1150.00',
      lineValueNow: '3450.00',
    });
  });

  it('the second cut: from the first cut’s price, the later one is the price now, “was” stays as sold', () => {
    const o = order([
      line(4, 1250, {
        cuts: [
          { to: 1150, amount: 400, at: at(1) },
          { to: 1100, amount: 200, at: at(2) },
        ],
      }),
    ]);
    expect(lineValueNow(o.items[0])).toMatchObject({
      soldUnitPrice: '1250.00',
      unitPriceNow: '1100.00',
      lineValueNow: '4400.00',
    });
  });

  it('everything returned: worth nothing', () => {
    const o = order([line(2, 500, { returns: [{ qty: 2, refund: 1000 }] })]);
    expect(orderValueNow(o)).toBe('0.00');
    expect(lineValueNow(o.items[0])).toMatchObject({
      returnedQty: '2',
      heldQty: '0',
      lineValueNow: '0.00',
    });
  });

  it('a discounted line is “sold at” its price after the discount, as History says', () => {
    // 3 at 1,000 less 300 is 900 each; lowered to 800 on the 3 held.
    const o = order([
      line(3, 1000, { discount: 300, cuts: [{ to: 800, amount: 300 }] }),
    ]);
    expect(lineValueNow(o.items[0])).toMatchObject({
      soldUnitPrice: '900.00',
      unitPriceNow: '800.00',
      lineValueNow: '2400.00',
    });
  });

  it('a third of a pound: the stored refunds are taken off, not a re-priced figure', () => {
    // 100 for 3 is 33.333… each; one back refunded at 33.33 leaves 66.67 —
    // the amount the outstanding was lowered by, to the cent.
    const o = order([
      line(3, 100 / 3, { returns: [{ qty: 1, refund: 33.33 }] }),
    ]);
    expect(o.items[0].lineTotal).toBe('100.00');
    expect(orderValueNow(o)).toBe('66.67');
  });

  it('withValueNow: the order and each line carry the figures, the records they came from are left off', () => {
    const o = order([line(4, 1250, { returns: [{ qty: 1, refund: 1250 }] })]);
    const shown = withValueNow({ ...o, id: 'o1' });
    expect(shown).toMatchObject({
      id: 'o1',
      total: '5000.00',
      valueNowEgp: '3750.00',
    });
    expect(shown.items[0]).toMatchObject({
      lineValueNow: '3750.00',
      heldQty: '3',
    });
    expect(shown.items[0]).not.toHaveProperty('returnItems');
    expect(shown.items[0]).not.toHaveProperty('priceAdjustments');
  });
});
