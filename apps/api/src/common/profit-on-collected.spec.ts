import {
  profitOnCollected,
  splitProfit,
  type ProfitOrder,
} from './profit-on-collected';

/**
 * Profit on collected (owner 2026-11-06, option B). Orders are built the way
 * the services leave them: a confirmed sale's lines carry their COGS
 * allocations; a payment allocation lowers `outstanding`; a reversed payment
 * keeps its allocation, marked REVERSED, and puts the amount back on
 * `outstanding`; a return reverses cost only for goods restocked and lowers
 * `outstanding` by its credit.
 */

type Opts = {
  status?: string;
  total?: number;
  outstanding: number;
  paid?: number[];
  reversed?: number[];
  cogs: number[];
  reversedCogs?: number[];
  cashRefund?: number;
};

const order = (o: Opts): ProfitOrder => ({
  status: o.status ?? 'CONFIRMED',
  total: o.total ?? 1000,
  outstanding: o.outstanding,
  paymentAllocations: [
    ...(o.paid ?? []).map((amount) => ({
      amount,
      payment: { status: 'RECORDED' },
    })),
    ...(o.reversed ?? []).map((amount) => ({
      amount,
      payment: { status: 'REVERSED' },
    })),
  ],
  items: [
    {
      allocations: o.cogs.map((cogsEgp) => ({ cogsEgp })),
      returnItems: (o.reversedCogs ?? []).map((cogsReversedEgp) => ({
        cogsReversedEgp,
      })),
    },
  ],
  returns: o.cashRefund
    ? [{ refundMethod: 'CASH', refundEgp: o.cashRefund }]
    : [],
});

const split = (orders: ProfitOrder[]) => {
  const r = splitProfit(orders);
  return {
    total: r.totalProfitEgp.toFixed(2),
    collected: r.profitOnCollectedEgp.toFixed(2),
    toCome: r.profitToCollectEgp.toFixed(2),
  };
};

describe('profit on collected (owner 2026-11-06)', () => {
  it('a fully paid order: all its profit is collected, none to come', () => {
    // Sold 1,000 at a cost of 600.
    expect(
      split([order({ outstanding: 0, paid: [1000], cogs: [600] })]),
    ).toEqual({
      total: '400.00',
      collected: '400.00',
      toCome: '0.00',
    });
  });

  it('a part-paid order: the profit splits in the share paid (GUESS)', () => {
    // 300 of 1,000 paid: 30% of the 400 profit is in.
    expect(
      split([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 700,
          paid: [100, 200],
          cogs: [450, 150],
        }),
      ]),
    ).toEqual({ total: '400.00', collected: '120.00', toCome: '280.00' });
  });

  it('an unpaid order: nothing collected, all of it to come', () => {
    expect(split([order({ outstanding: 1000, cogs: [600] })])).toEqual({
      total: '400.00',
      collected: '0.00',
      toCome: '400.00',
    });
  });

  it('a restocked return gives its cost back: the order is worth less and cost less', () => {
    // 1,000 sold at cost 600, unpaid; 250 (cost 150) came back on a credit
    // note and went back on the shelf: owed 750, cost 450.
    expect(
      split([order({ outstanding: 750, cogs: [600], reversedCogs: [150] })]),
    ).toEqual({ total: '300.00', collected: '0.00', toCome: '300.00' });
    // Part-paid (300 in), then the same return: owed 700 − 250 = 450, value
    // 750, profit 300, of which 300/750 is in.
    expect(
      split([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 450,
          paid: [300],
          cogs: [600],
          reversedCogs: [150],
        }),
      ]),
    ).toEqual({ total: '300.00', collected: '120.00', toCome: '180.00' });
  });

  it('a cash refund comes off what was paid: the refunded money is not profit collected', () => {
    // Paid 1,000 in full; 250 (cost 150) came back for 250 cash. The
    // allocation stays and outstanding stays 0, so the refund must be read:
    // kept 750, cost 450, profit 300, all collected (2026-11-06).
    expect(
      split([
        order({
          status: 'PAID',
          outstanding: 0,
          paid: [1000],
          cogs: [600],
          reversedCogs: [150],
          cashRefund: 250,
        }),
      ]),
    ).toEqual({ total: '300.00', collected: '300.00', toCome: '0.00' });
  });

  it('a damaged return reverses no cost: the order is worth less and the cost stays', () => {
    // Unpaid, 250 credited for damaged goods (cogs_reversed_egp = 0).
    expect(
      split([order({ outstanding: 750, cogs: [600], reversedCogs: [0] })]),
    ).toEqual({
      total: '150.00',
      collected: '0.00',
      toCome: '150.00',
    });
  });

  it('a reversed payment is not money in: it counts toward neither paid nor collected profit', () => {
    // 500 paid then reversed (back on outstanding), 300 standing.
    expect(
      split([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 700,
          paid: [300],
          reversed: [500],
          cogs: [600],
        }),
      ]),
    ).toEqual({ total: '400.00', collected: '120.00', toCome: '280.00' });
  });

  it.each([
    'SAMPLES',
    'SAMPLES_RETURNED',
    'SAMPLES_WRITTEN_OFF',
    'DRAFT',
    'CANCELLED',
    'RETURNED',
  ])('a %s order is not a sale and adds nothing', (status) => {
    const real = order({ outstanding: 0, paid: [1000], cogs: [600] });
    expect(
      split([
        real,
        order({ status, outstanding: 1000, paid: [500], cogs: [100] }),
      ]),
    ).toEqual({
      total: '400.00',
      collected: '400.00',
      toCome: '0.00',
    });
  });

  it('an order with no total (a zero-priced sale) adds nothing, even with cost on it', () => {
    expect(split([order({ total: 0, outstanding: 0, cogs: [600] })])).toEqual({
      total: '0.00',
      collected: '0.00',
      toCome: '0.00',
    });
  });

  it('a loss-making order stays a loss: negative, never clamped to zero', () => {
    // Sold 1,000 below its 1,300 cost; half paid.
    expect(
      split([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 500,
          paid: [500],
          cogs: [1300],
        }),
      ]),
    ).toEqual({ total: '-300.00', collected: '-150.00', toCome: '-150.00' });
    // And it takes its share off a profitable order's, not hidden by it.
    expect(
      split([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 500,
          paid: [500],
          cogs: [1300],
        }),
        order({ outstanding: 0, paid: [1000], cogs: [600] }),
      ]),
    ).toEqual({ total: '100.00', collected: '250.00', toCome: '-150.00' });
  });

  it('an order whose value has gone to zero (everything credited back) splits nothing, no division by zero', () => {
    // 1,000 sold, all of it returned on a credit note before any payment.
    expect(
      split([order({ outstanding: 0, cogs: [600], reversedCogs: [600] })]),
    ).toEqual({
      total: '0.00',
      collected: '0.00',
      toCome: '0.00',
    });
  });

  it('no orders: zero', () => {
    expect(split([])).toEqual({
      total: '0.00',
      collected: '0.00',
      toCome: '0.00',
    });
  });

  it('many orders sum, and collected + to come is the whole profit to the piastre', () => {
    const orders = [
      order({ outstanding: 0, paid: [1000], cogs: [600] }),
      order({
        status: 'PARTIALLY_PAID',
        total: 3000,
        outstanding: 2000,
        paid: [1000],
        cogs: [1000],
      }),
      order({ total: 777.77, outstanding: 777.77, cogs: [333.33] }),
    ];
    const r = splitProfit(orders);
    expect(r.totalProfitEgp.toFixed(2)).toBe('2844.44');
    expect(r.profitOnCollectedEgp.toFixed(2)).toBe('1066.67');
    expect(r.profitOnCollectedEgp.add(r.profitToCollectEgp).toFixed(2)).toBe(
      r.totalProfitEgp.toFixed(2),
    );
  });

  it('the loader asks only for realised orders with a total, and applies the same split', async () => {
    const findMany = jest
      .fn<Promise<ProfitOrder[]>, [{ where: unknown }]>()
      .mockResolvedValue([
        order({
          status: 'PARTIALLY_PAID',
          outstanding: 700,
          paid: [300],
          cogs: [600],
        }),
        // A database that ignored the filter still adds no draft.
        order({ status: 'DRAFT', outstanding: 1000, paid: [1000], cogs: [0] }),
      ]);
    const r = await profitOnCollected({ saleOrder: { findMany } } as never);
    expect(findMany.mock.calls[0][0].where).toEqual({
      status: { in: ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] },
      total: { gt: 0 },
    });
    expect(r.profitOnCollectedEgp.toFixed(2)).toBe('120.00');
    expect(r.profitToCollectEgp.toFixed(2)).toBe('280.00');
  });
});
