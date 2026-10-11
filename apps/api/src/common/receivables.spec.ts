import { receivablesByCustomer, withOverdue } from './receivables';

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
