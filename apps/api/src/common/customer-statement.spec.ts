import { HttpException } from '@nestjs/common';

import { buildStatement, type StatementSource } from './customer-statement';

/**
 * The statement's arithmetic (BUSINESS_LOGIC §7b, 2026-10-11). The rule that
 * matters most — the closing balance is the balance the app shows — is
 * checked against a real database in 34-business-invariants; here every
 * kind of event is checked for what it does to the running balance, with
 * non-zero figures throughout (CLAUDE.md §10: zero hides every bug).
 */

const SHOP = { id: 'c1', displayName: 'Nile Motors', phone: null };
const at = (iso: string) => new Date(iso);
const day = (d: string) => new Date(`${d}T00:00:00Z`);

function order(
  id: string,
  total: number,
  orderedAt: string,
  status = 'CONFIRMED',
  items = [{ id: `${id}-i1`, quantity: 2 }],
) {
  return {
    id,
    orderNo: `SO-${id}`,
    status,
    total,
    orderedAt: at(orderedAt),
    items,
  };
}

function payment(
  id: string,
  amount: number,
  receivedOn: string,
  allocations: { saleOrderId: string; amount: number; createdAt?: string }[],
  extra: Partial<StatementSource['payments'][number]> = {},
) {
  const createdAt = at(`${receivedOn}T12:00:00Z`);
  return {
    id,
    amount,
    receivedOn: day(receivedOn),
    method: 'CASH',
    reference: null,
    status: 'RECORDED',
    createdAt,
    updatedAt: createdAt,
    allocations: allocations.map((a) => ({
      saleOrderId: a.saleOrderId,
      amount: a.amount,
      createdAt: a.createdAt ? at(a.createdAt) : createdAt,
    })),
    ...extra,
  };
}

function ret(
  id: string,
  saleOrderId: string,
  refundEgp: number,
  returnedOn: string,
  refundMethod: 'CREDIT_NOTE' | 'CASH',
  qty: number,
) {
  return {
    id,
    saleOrderId,
    reference: `RET-${id}`,
    returnedOn: day(returnedOn),
    refundMethod,
    refundEgp,
    createdAt: at(`${returnedOn}T15:00:00Z`),
    items: [{ saleItemId: `${saleOrderId}-i1`, qty }],
  };
}

const balances = (s: ReturnType<typeof buildStatement>) =>
  s.rows.map((r) => [r.kind, r.effect, r.balance]);

describe('buildStatement', () => {
  it('a sale owes its total, a payment takes off what it paid, and the running balance follows them in date order', () => {
    const s = buildStatement(SHOP, {
      orders: [
        order('a', 3000, '2026-09-01T09:00:00Z'),
        order('b', 4000, '2026-09-10T09:00:00Z'),
      ],
      payments: [
        payment('p1', 3500, '2026-09-15', [
          { saleOrderId: 'a', amount: 3000 },
          { saleOrderId: 'b', amount: 500 },
        ]),
      ],
      returns: [],
    });
    expect(balances(s)).toEqual([
      ['SALE', '3000.00', '3000.00'],
      ['SALE', '4000.00', '7000.00'],
      ['PAYMENT', '-3500.00', '3500.00'],
    ]);
    expect(s.rows[2].orders).toEqual(['SO-a', 'SO-b']);
    expect(s).toMatchObject({
      openingBalance: '0.00',
      debits: '7000.00',
      credits: '3500.00',
      closingBalance: '3500.00',
    });
  });

  it('drafts and cancelled orders never appear and never owe', () => {
    const s = buildStatement(SHOP, {
      orders: [
        order('a', 3000, '2026-09-01T09:00:00Z'),
        order('d', 9000, '2026-09-02T09:00:00Z', 'DRAFT'),
        order('x', 8000, '2026-09-03T09:00:00Z', 'CANCELLED'),
      ],
      payments: [],
      returns: [],
    });
    expect(s.rows.map((r) => r.reference)).toEqual(['SO-a']);
    expect(s.closingBalance).toBe('3000.00');
  });

  it('a credit-note return takes the refund off, but never below what the order still owed', () => {
    const s = buildStatement(SHOP, {
      orders: [
        order('a', 1000, '2026-09-01T09:00:00Z', 'PAID', [
          { id: 'a-i1', quantity: 4 },
        ]),
      ],
      payments: [
        payment('p1', 800, '2026-09-02', [{ saleOrderId: 'a', amount: 800 }]),
      ],
      // 500 refunded against 200 still owed: the shop owes 0, not -300.
      returns: [ret('r1', 'a', 500, '2026-09-03', 'CREDIT_NOTE', 2)],
    });
    expect(balances(s)).toEqual([
      ['SALE', '1000.00', '1000.00'],
      ['PAYMENT', '-800.00', '200.00'],
      ['RETURN', '-200.00', '0.00'],
    ]);
    expect(s.rows[2]).toMatchObject({
      amount: '500.00',
      method: 'CREDIT_NOTE',
    });
  });

  it('a cash return of part of an order changes nothing owed; the last one, bringing every line back, ends what it owed', () => {
    const s = buildStatement(SHOP, {
      orders: [
        order('a', 1000, '2026-09-01T09:00:00Z', 'RETURNED', [
          { id: 'a-i1', quantity: 2 },
        ]),
      ],
      payments: [],
      returns: [
        ret('r1', 'a', 500, '2026-09-02', 'CASH', 1),
        ret('r2', 'a', 500, '2026-09-03', 'CASH', 1),
      ],
    });
    expect(balances(s)).toEqual([
      ['SALE', '1000.00', '1000.00'],
      ['RETURN', '0.00', '1000.00'],
      ['RETURN', '-1000.00', '0.00'],
    ]);
  });

  it('a reversed payment is shown, then its reversal puts the money back on what it paid', () => {
    const s = buildStatement(SHOP, {
      orders: [order('a', 1000, '2026-09-01T09:00:00Z', 'PARTIALLY_PAID')],
      payments: [
        payment('p1', 600, '2026-09-02', [{ saleOrderId: 'a', amount: 600 }], {
          status: 'REVERSED',
          updatedAt: at('2026-09-05T10:00:00Z'),
        }),
      ],
      returns: [],
    });
    expect(balances(s)).toEqual([
      ['SALE', '1000.00', '1000.00'],
      ['PAYMENT', '-600.00', '400.00'],
      ['REVERSAL', '600.00', '1000.00'],
    ]);
    expect(s.rows[2].date).toBe('2026-09-05');
  });

  it('a payment reversed after the order was returned makes the order owed again, as the reversal does to the stored order', () => {
    const s = buildStatement(SHOP, {
      orders: [
        order('a', 1000, '2026-09-01T09:00:00Z', 'PARTIALLY_PAID', [
          { id: 'a-i1', quantity: 1 },
        ]),
      ],
      payments: [
        payment('p1', 600, '2026-09-02', [{ saleOrderId: 'a', amount: 600 }], {
          status: 'REVERSED',
          updatedAt: at('2026-09-06T10:00:00Z'),
        }),
      ],
      returns: [ret('r1', 'a', 1000, '2026-09-04', 'CASH', 1)],
    });
    expect(balances(s)).toEqual([
      ['SALE', '1000.00', '1000.00'],
      ['PAYMENT', '-600.00', '400.00'],
      ['RETURN', '-400.00', '0.00'],
      // PaymentsService.reverse: outstanding 400 + 600, status PARTIALLY_PAID.
      ['REVERSAL', '1000.00', '1000.00'],
    ]);
  });

  it('money on no order is shown as unapplied and changes nothing owed', () => {
    const s = buildStatement(SHOP, {
      orders: [order('a', 1000, '2026-09-01T09:00:00Z')],
      payments: [payment('p1', 300, '2026-09-02', [])],
      returns: [],
    });
    expect(s.rows[1]).toMatchObject({
      kind: 'PAYMENT',
      amount: '300.00',
      effect: '0.00',
      unapplied: '300.00',
      balance: '1000.00',
    });
  });

  it('a range opens at what was owed before it, and leaves out what came after it', () => {
    const source = {
      orders: [
        order('a', 3000, '2026-08-20T09:00:00Z'),
        order('b', 4000, '2026-09-10T09:00:00Z'),
        order('c', 2000, '2026-10-05T09:00:00Z'),
      ],
      payments: [
        payment('p1', 1000, '2026-09-15', [{ saleOrderId: 'a', amount: 1000 }]),
      ],
      returns: [],
    };
    const s = buildStatement(SHOP, source, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(s.openingBalance).toBe('3000.00');
    expect(s.rows.map((r) => r.reference)).toEqual(['SO-b', null]);
    expect(s.closingBalance).toBe('6000.00');
    // The whole history closes at the stored balance: 3000 - 1000 + 4000 + 2000.
    expect(buildStatement(SHOP, source).closingBalance).toBe('8000.00');
  });

  it("the last day of a range is included, and a sale late at night in Cairo is that day's", () => {
    const s = buildStatement(
      SHOP,
      // 22:30 UTC on the 30th is 01:30 on October 1st in Cairo.
      {
        orders: [
          order('a', 500, '2026-09-30T22:30:00Z'),
          order('b', 700, '2026-09-30T08:00:00Z'),
        ],
        payments: [],
        returns: [],
      },
      { to: '2026-09-30' },
    );
    expect(s.rows.map((r) => r.reference)).toEqual(['SO-b']);
    expect(s.closingBalance).toBe('700.00');
  });

  it('a payment dated before the sale it paid still reads in date order, and the closing balance does not care', () => {
    const s = buildStatement(SHOP, {
      orders: [order('a', 1000, '2026-09-10T09:00:00Z')],
      payments: [
        payment('p1', 400, '2026-09-08', [
          { saleOrderId: 'a', amount: 400, createdAt: '2026-09-12T10:00:00Z' },
        ]),
      ],
      returns: [],
    });
    expect(s.rows.map((r) => r.kind)).toEqual(['PAYMENT', 'SALE']);
    expect(s.closingBalance).toBe('600.00');
  });

  it('a range that ends before it starts, or a day that does not exist, is refused', () => {
    const empty = { orders: [], payments: [], returns: [] };
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return ((e as HttpException).getResponse() as { code: string }).code;
      }
      return null;
    };
    expect(
      code(() =>
        buildStatement(SHOP, empty, { from: '2026-10-02', to: '2026-10-01' }),
      ),
    ).toBe('DATE_RANGE_REVERSED');
    expect(
      code(() => buildStatement(SHOP, empty, { from: '2026-02-30' })),
    ).toBe('BAD_DATE');
  });
});

describe('the Profit column (owner 2026-10-23)', () => {
  // Two units sold at 1,000 each that cost 600 each: 800 profit.
  const sold = {
    ...order('o1', 2000, '2026-10-01T10:00:00Z'),
    items: [
      {
        id: 'o1-i1',
        quantity: 2,
        allocations: [{ cogsEgp: 700 }, { cogsEgp: 500 }],
      },
    ],
  };

  it('a sale is its total less what its units cost; a payment and a reversal are cash, not profit', () => {
    const s = buildStatement(SHOP, {
      orders: [sold],
      payments: [
        payment('p1', 900, '2026-10-02', [{ saleOrderId: 'o1', amount: 900 }], {
          status: 'REVERSED',
          updatedAt: at('2026-10-03T09:00:00Z'),
        }),
      ],
      returns: [],
    });
    expect(s.rows.map((r) => [r.kind, r.profit])).toEqual([
      ['SALE', '800.00'],
      ['PAYMENT', null],
      ['REVERSAL', null],
    ]);
    expect(s.profit).toBe('800.00');
  });

  it('a return gives back the profit on its units; a damaged one gives back its whole price (its cost stays spent)', () => {
    const back = {
      ...ret('r1', 'o1', 1000, '2026-10-05', 'CREDIT_NOTE', 1),
      cogsReversedEgp: 600,
    };
    const damaged = {
      ...ret('r2', 'o1', 1000, '2026-10-06', 'CREDIT_NOTE', 1),
      cogsReversedEgp: 0,
    };
    const s = buildStatement(SHOP, {
      orders: [sold],
      payments: [],
      returns: [back, damaged],
    });
    expect(s.rows.map((r) => [r.kind, r.profit])).toEqual([
      ['SALE', '800.00'],
      ['RETURN', '-400.00'],
      ['RETURN', '-1000.00'],
    ]);
    // Sold for 2,000, everything back, one unit's 600 cost never returned: a loss of 600.
    expect(s.profit).toBe('-600.00');
  });

  it('a price cut is profit given up, all of it', () => {
    const s = buildStatement(SHOP, {
      orders: [sold],
      payments: [],
      returns: [],
      adjustments: [
        {
          id: 'a1',
          saleOrderId: 'o1',
          adjustedOn: day('2026-10-04'),
          amountEgp: 300,
          createdAt: at('2026-10-04T10:00:00Z'),
        },
      ],
    });
    expect(s.rows.map((r) => r.profit)).toEqual(['800.00', '-300.00']);
    expect(s.profit).toBe('500.00');
  });

  it('a sale below cost shows its loss', () => {
    const below = { ...sold, total: 1000 };
    expect(
      buildStatement(SHOP, { orders: [below], payments: [], returns: [] })
        .rows[0].profit,
    ).toBe('-200.00');
  });

  it('the period’s profit counts only the rows in it, not the opening history', () => {
    const later = {
      ...order('o2', 500, '2026-10-20T10:00:00Z'),
      items: [{ id: 'o2-i1', quantity: 1, allocations: [{ cogsEgp: 450 }] }],
    };
    const s = buildStatement(
      SHOP,
      { orders: [sold, later], payments: [], returns: [] },
      { from: '2026-10-10' },
    );
    expect(s.rows.map((r) => r.profit)).toEqual(['50.00']);
    expect(s.profit).toBe('50.00');
  });

  it('a source with no costs (an older caller) counts the whole total, never fails', () => {
    const s = buildStatement(SHOP, {
      orders: [order('o3', 750, '2026-10-01T10:00:00Z')],
      payments: [],
      returns: [],
    });
    expect(s.rows[0].profit).toBe('750.00');
  });
});
