import { receivablesByCustomer, toCollect, withOverdue } from './receivables';
import { toCollectLimit } from '../modules/customers/customers.controller';

/**
 * Who owes what (I1, 2026-10-11): one row per customer with something owed,
 * the largest balance first, with what is overdue on their plan.
 */

const order = (
  customerId: string,
  outstanding: number | string,
  orderedAt: string,
  extra: Record<string, unknown> = {},
) => ({
  customerId,
  outstanding,
  orderedAt: new Date(orderedAt),
  customer: { displayName: `Shop ${customerId}`, phone: null, isWalkIn: false },
  ...extra,
});

describe('receivablesByCustomer', () => {
  it('sums each customer’s open orders, oldest unpaid first seen, largest balance first', () => {
    const rows = receivablesByCustomer([
      order('a', '1000.00', '2026-09-10T08:00:00Z'),
      order('b', '9000.50', '2026-09-20T08:00:00Z'),
      order('a', '250.25', '2026-08-01T08:00:00Z'),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        customerId: 'b',
        outstanding: '9000.50',
        openOrders: 1,
        oldestUnpaidOn: '2026-09-20',
      }),
      expect.objectContaining({
        customerId: 'a',
        outstanding: '1250.25',
        openOrders: 2,
        oldestUnpaidOn: '2026-08-01',
      }),
    ]);
  });

  it('money sums to the cent, not through floats (0.1 + 0.2)', () => {
    const [row] = receivablesByCustomer([
      order('a', '0.10', '2026-09-01T08:00:00Z'),
      order('a', '0.20', '2026-09-02T08:00:00Z'),
    ]);
    expect(row.outstanding).toBe('0.30');
  });

  it('an order owing nothing (or less) is not a receivable', () => {
    expect(
      receivablesByCustomer([
        order('a', 0, '2026-09-01T08:00:00Z'),
        order('b', '-5', '2026-09-01T08:00:00Z'),
      ]),
    ).toEqual([]);
  });

  it('the walk-in record never owes, whatever a row says', () => {
    expect(
      receivablesByCustomer([
        order('w', '100', '2026-09-01T08:00:00Z', {
          customer: { displayName: 'Walk-in', phone: null, isWalkIn: true },
        }),
      ]),
    ).toEqual([]);
  });

  it('the oldest unpaid day is the day in Cairo: 00:30 on 1 Sep Cairo is 21:30 UTC on 31 Aug', () => {
    const [row] = receivablesByCustomer([
      order('a', '10', '2026-08-31T21:30:00Z'),
    ]);
    expect(row.oldestUnpaidOn).toBe('2026-09-01');
  });

  it('equal balances fall back to the name, so the order is stable', () => {
    const rows = receivablesByCustomer([
      order('z', '10', '2026-09-01T08:00:00Z', {
        customer: { displayName: 'Zamalek', phone: null, isWalkIn: false },
      }),
      order('a', '10', '2026-09-01T08:00:00Z', {
        customer: { displayName: 'Abbasiya', phone: null, isWalkIn: false },
      }),
    ]);
    expect(rows.map((r) => r.customer)).toEqual(['Abbasiya', 'Zamalek']);
  });
});

describe('withOverdue', () => {
  const rows = () =>
    receivablesByCustomer([
      order('a', '5000', '2026-09-01T08:00:00Z'),
      order('b', '9000', '2026-09-05T08:00:00Z'),
      order('c', '100', '2026-09-07T08:00:00Z'),
    ]);

  it('adds what is overdue on each customer’s plans; none is 0.00, not missing', () => {
    const out = withOverdue(rows(), [
      { customer: { id: 'a' }, overdueEgp: '2000.00' },
    ]);
    expect(out.map((r) => [r.customerId, r.overdue])).toEqual([
      ['b', '0.00'],
      ['a', '2000.00'],
      ['c', '0.00'],
    ]);
  });

  it('overdueOnly keeps only customers with something overdue, still largest balance first', () => {
    const out = withOverdue(
      rows(),
      [
        { customer: { id: 'c' }, overdueEgp: '50.00' },
        { customer: { id: 'a' }, overdueEgp: '2000.00' },
      ],
      { overdueOnly: true },
    );
    expect(out.map((r) => r.customerId)).toEqual(['a', 'c']);
  });

  it('two plans for one customer add up (a cancelled one is never in the summary)', () => {
    const out = withOverdue(rows(), [
      { customer: { id: 'a' }, overdueEgp: '100.10' },
      { customer: { id: 'a' }, overdueEgp: '0.20' },
    ]);
    expect(out.find((r) => r.customerId === 'a')!.overdue).toBe('100.30');
  });

  it('overdue on a customer who owes nothing on an order is not invented into a row', () => {
    const out = withOverdue(rows(), [
      { customer: { id: 'nobody' }, overdueEgp: '10.00' },
    ]);
    expect(out.map((r) => r.customerId)).toEqual(['b', 'a', 'c']);
  });

  it('overdue is never more than the balance the customer actually owes', () => {
    const out = withOverdue(rows(), [
      { customer: { id: 'c' }, overdueEgp: '500.00' },
    ]);
    expect(out.find((r) => r.customerId === 'c')!.overdue).toBe('100.00');
  });
});

describe('toCollect — the dashboard card (owner, 2026-10-15)', () => {
  const r = (customer: string, outstanding: string, overdue = '0.00') => ({
    customerId: customer.toLowerCase(),
    customer,
    phone: null,
    outstanding,
    overdue,
    openOrders: 1,
    oldestUnpaidOn: '2026-10-01',
    oldestUnpaidAt: '2026-10-01T09:00:00.000Z',
  });

  it('anyone overdue comes before anyone not, even with a smaller balance; then the larger balance', () => {
    const out = toCollect(
      [
        r('Big', '90000.00'),
        r('Late small', '500.00', '200.00'),
        r('Mid', '40000.00'),
        r('Late big', '30000.00', '1.00'),
      ],
      5,
    );
    expect(out.rows.map((x) => x.customer)).toEqual([
      'Late big',
      'Late small',
      'Big',
      'Mid',
    ]);
  });

  it('shows only `limit` rows but totals everyone owing, to the cent', () => {
    const all = [
      r('A', '0.10'),
      r('B', '0.20', '0.10'),
      r('C', '100.00'),
      r('D', '5.55', '5.55'),
      r('E', '1.00'),
      r('F', '2.00'),
    ];
    const out = toCollect(all, 2);
    expect(out.rows).toHaveLength(2);
    expect(out.totalOwed).toBe('108.85');
    expect(out.totalOverdue).toBe('5.65');
    expect(out.customers).toBe(6);
  });

  it('nobody owing is a card with nothing to show, not an error', () => {
    expect(toCollect([], 5)).toEqual({
      totalOwed: '0.00',
      totalOverdue: '0.00',
      customers: 0,
      rows: [],
    });
  });

  it('a limit of zero or less shows no rows, and the totals still stand', () => {
    for (const n of [0, -3]) {
      const out = toCollect([r('A', '10.00', '5.00')], n);
      expect(out.rows).toEqual([]);
      expect(out.totalOwed).toBe('10.00');
    }
  });

  it('ties fall back to the name, so the card does not reshuffle between visits', () => {
    const out = toCollect([r('Zed', '100.00'), r('Amr', '100.00')], 5);
    expect(out.rows.map((x) => x.customer)).toEqual(['Amr', 'Zed']);
  });

  it('the overdue it shows is withOverdue\'s, capped at what is owed — never "overdue 500 of a 100 balance"', () => {
    const owing = [r('A', '100.00')];
    const capped = withOverdue(owing, [
      { customer: { id: 'a' }, overdueEgp: '500.00' },
    ]);
    const out = toCollect(capped, 5);
    expect(out.rows[0].overdue).toBe('100.00');
    expect(out.totalOverdue).toBe('100.00');
  });
});

describe('toCollectLimit — what ?limit= may ask for', () => {
  it.each([
    [undefined, 5],
    ['', 5],
    ['abc', 5],
    ['2.5', 5],
    ['NaN', 5],
    ['0', 1],
    ['-4', 1],
    ['1', 1],
    ['7', 7],
    ['20', 20],
    ['21', 20],
    ['99999', 20],
  ])('%p → %p', (raw, n) => {
    expect(toCollectLimit(raw)).toBe(n);
  });
});
