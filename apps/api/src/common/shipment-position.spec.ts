import {
  shipmentPosition,
  ShipmentPositionInput,
  PositionDeliveryInput,
} from './shipment-position';

/**
 * B1 edge cases (plan 2026-10-10). Each test is named after the case it pins.
 * Pure: no database, no clock.
 */

const L1 = 'leg-1';
const L2 = 'leg-2';
const A = 'line-a';
const B = 'line-b';

let n = 0;
const delivery = (
  legId: string,
  arrivedOn: string,
  lines: Record<string, number>,
): PositionDeliveryInput => ({
  id: `d${++n}`,
  legId,
  arrivedOn,
  lines: Object.entries(lines).map(([poi, qty]) => ({
    id: `dl${++n}`,
    purchaseOrderItemId: poi,
    qty,
  })),
});

function base(
  over: Partial<ShipmentPositionInput> = {},
): ShipmentPositionInput {
  return {
    lines: [{ id: A, orderedQty: 40 }],
    legs: [{ id: L1, sequence: 1, departedOn: '2026-09-01' }],
    deliveries: [],
    losses: [],
    batches: [],
    ...over,
  };
}

const leg = (p: ReturnType<typeof shipmentPosition>, id: string) =>
  p.legs.find((l) => l.legId === id)!;
const line = (p: ReturnType<typeof shipmentPosition>, id: string) =>
  p.lines.find((l) => l.purchaseOrderItemId === id)!;

describe('shipmentPosition', () => {
  it('one leg, 40 ordered, deliveries 15+10+5+10 → delivered 40, on the way 0, leg accounted', () => {
    const p = shipmentPosition(
      base({
        deliveries: [
          delivery(L1, '2026-09-10', { [A]: 15 }),
          delivery(L1, '2026-09-20', { [A]: 10 }),
          delivery(L1, '2026-09-25', { [A]: 5 }),
          delivery(L1, '2026-10-05', { [A]: 10 }),
        ],
      }),
    );
    const l = leg(p, L1);
    expect(l.delivered).toBe(40);
    expect(l.onTheWay).toBe(0);
    expect(l.status).toBe('ARRIVED');
    expect(l.arrivedOn).toBe('2026-10-05'); // the delivery that completed it
    // Delivered is not received: the cycle is not accounted yet.
    expect(l.waiting).toBe(40);
    expect(p.accounted).toBe(false);
  });

  it('one leg, 40 ordered, 15 delivered, 5 lost → on the way 20, not accounted', () => {
    const p = shipmentPosition(
      base({
        deliveries: [delivery(L1, '2026-09-10', { [A]: 15 })],
        losses: [{ legId: L1, purchaseOrderItemId: A, qty: 5 }],
        batches: [{ sourcePoItemId: A, receivedQty: 15 }],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(20);
    expect(leg(p, L1).status).toBe('PARTLY_ARRIVED');
    expect(leg(p, L1).arrivedOn).toBeNull();
    expect(line(p, A).accounted).toBe(false);
    expect(p.accounted).toBe(false);
  });

  it('two legs: leg 1 delivered 30 of 40 → leg 2 entered 30, not 40', () => {
    const p = shipmentPosition(
      base({
        legs: [
          { id: L1, sequence: 1, departedOn: '2026-09-01' },
          { id: L2, sequence: 2, departedOn: '2026-09-20' },
        ],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 30 })],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(10);
    expect(leg(p, L2).entered).toBe(30);
    expect(leg(p, L2).onTheWay).toBe(30);
    expect(line(p, A).onTheWay).toBe(40); // 10 on leg 1 + 30 on leg 2
  });

  it('leg 2 delivered 30, leg 1 lost 10 → line accounted only when received + all losses = ordered', () => {
    const input = base({
      legs: [
        { id: L1, sequence: 1, departedOn: '2026-09-01' },
        { id: L2, sequence: 2, departedOn: '2026-09-20' },
      ],
      deliveries: [
        delivery(L1, '2026-09-15', { [A]: 30 }),
        delivery(L2, '2026-10-01', { [A]: 30 }),
      ],
      losses: [{ legId: L1, purchaseOrderItemId: A, qty: 10 }],
      batches: [{ sourcePoItemId: A, receivedQty: 29 }],
    });
    const short = shipmentPosition(input);
    expect(line(short, A).lost).toBe(10);
    expect(line(short, A).accounted).toBe(false); // 29 + 10 ≠ 40

    input.batches.push({ sourcePoItemId: A, receivedQty: 1 });
    const full = shipmentPosition(input);
    expect(line(full, A).accounted).toBe(true); // 30 + 10 = 40
    expect(full.accounted).toBe(true);
    expect(leg(full, L1).status).toBe('ARRIVED');
  });

  it('received less than a last-leg delivery said → the difference is waiting to be received against that delivery, not on the way', () => {
    const d = delivery(L1, '2026-09-10', { [A]: 15 });
    const p = shipmentPosition(
      base({
        deliveries: [d],
        batches: [
          {
            sourcePoItemId: A,
            sourceDeliveryLineId: d.lines[0].id,
            receivedQty: 12,
          },
        ],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(25); // 40 − 15, unaffected by the short count
    expect(leg(p, L1).waiting).toBe(3);
    expect(line(p, A).waiting).toBe(3);
    const dl = leg(p, L1).deliveries[0].lines[0];
    expect(dl.qty).toBe(15);
    expect(dl.received).toBe(12);
  });

  it('several order lines move independently on one leg', () => {
    const p = shipmentPosition(
      base({
        lines: [
          { id: A, orderedQty: 40 },
          { id: B, orderedQty: 10 },
        ],
        deliveries: [
          delivery(L1, '2026-09-10', { [A]: 40 }),
          delivery(L1, '2026-09-12', { [B]: 4 }),
        ],
        batches: [{ sourcePoItemId: A, receivedQty: 40 }],
      }),
    );
    const lines = leg(p, L1).lines;
    expect(lines.find((x) => x.purchaseOrderItemId === A)!.onTheWay).toBe(0);
    expect(lines.find((x) => x.purchaseOrderItemId === B)!.onTheWay).toBe(6);
    expect(line(p, A).accounted).toBe(true);
    expect(line(p, B).accounted).toBe(false);
    expect(leg(p, L1).status).toBe('PARTLY_ARRIVED');
  });

  it('a cycle with no legs and every unit received → accounted', () => {
    const p = shipmentPosition(
      base({ legs: [], batches: [{ sourcePoItemId: A, receivedQty: 40 }] }),
    );
    expect(p.legs).toEqual([]);
    expect(p.accounted).toBe(true);
  });

  it('a cycle with nothing ordered → accounted', () => {
    const p = shipmentPosition(base({ lines: [] }));
    expect(p.accounted).toBe(true);
    expect(p.totals).toEqual({
      ordered: 0,
      received: 0,
      lost: 0,
      onTheWay: 0,
      waiting: 0,
    });
    // Nothing entered, nothing delivered: the leg has not arrived.
    expect(leg(p, L1).status).toBe('IN_TRANSIT');
  });

  it('a last-leg delivery of 15 received 14 → 1 waiting to be received (not on the way); the leg reads arrived, the cycle is not accounted', () => {
    const d = delivery(L1, '2026-09-10', { [A]: 15 });
    const p = shipmentPosition(
      base({
        lines: [{ id: A, orderedQty: 15 }],
        deliveries: [d],
        batches: [
          {
            sourcePoItemId: A,
            sourceDeliveryLineId: d.lines[0].id,
            receivedQty: 14,
          },
        ],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(0);
    expect(leg(p, L1).waiting).toBe(1);
    expect(leg(p, L1).status).toBe('ARRIVED');
    expect(p.accounted).toBe(false);
    expect(p.totals.waiting).toBe(1);
    expect(p.totals.onTheWay).toBe(0);
  });

  it('UAE-direct cycle: one leg, entered = ordered', () => {
    const p = shipmentPosition(base({ lines: [{ id: A, orderedQty: 25 }] }));
    expect(p.legs).toHaveLength(1);
    expect(leg(p, L1).isLast).toBe(true);
    expect(leg(p, L1).entered).toBe(25);
    expect(leg(p, L1).onTheWay).toBe(25);
  });

  // ── Beyond the plan's list: the limits and the second visit (rule 0). ──

  it('a loss on the last leg clears what is waiting once nothing is on the way', () => {
    const p = shipmentPosition(
      base({
        lines: [{ id: A, orderedQty: 15 }],
        deliveries: [delivery(L1, '2026-09-10', { [A]: 15 })],
        losses: [{ legId: L1, purchaseOrderItemId: A, qty: 1 }],
        batches: [{ sourcePoItemId: A, receivedQty: 14 }],
      }),
    );
    expect(leg(p, L1).waiting).toBe(0);
    expect(p.accounted).toBe(true);
  });

  it('more received than ordered is not "accounted" — it is a record the business could not produce', () => {
    const p = shipmentPosition(
      base({
        deliveries: [delivery(L1, '2026-09-10', { [A]: 40 })],
        batches: [{ sourcePoItemId: A, receivedQty: 41 }],
      }),
    );
    expect(line(p, A).accounted).toBe(false);
    expect(p.accounted).toBe(false);
  });

  it('fractions sum exactly: 0.1 + 0.2 delivered of 0.3 leaves nothing on the way', () => {
    const p = shipmentPosition(
      base({
        lines: [{ id: A, orderedQty: '0.3' }],
        deliveries: [
          delivery(L1, '2026-09-10', { [A]: 0.1 }),
          delivery(L1, '2026-09-11', { [A]: 0.2 }),
        ],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(0);
    expect(leg(p, L1).status).toBe('ARRIVED');
  });

  it('every unit lost on a leg with no delivery → arrived, with no arrival date', () => {
    const p = shipmentPosition(
      base({ losses: [{ legId: L1, purchaseOrderItemId: A, qty: 40 }] }),
    );
    expect(leg(p, L1).status).toBe('ARRIVED');
    expect(leg(p, L1).arrivedOn).toBeNull();
    expect(p.accounted).toBe(true);
  });

  it('leg statuses: nothing recorded → PENDING; departed → IN_TRANSIT', () => {
    expect(
      leg(shipmentPosition(base({ legs: [{ id: L1, sequence: 1 }] })), L1)
        .status,
    ).toBe('PENDING');
    expect(leg(shipmentPosition(base()), L1).status).toBe('IN_TRANSIT');
  });

  it('legs given out of order are read in sequence order', () => {
    const p = shipmentPosition(
      base({
        legs: [
          { id: L2, sequence: 2, departedOn: '2026-09-20' },
          { id: L1, sequence: 1, departedOn: '2026-09-01' },
        ],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 30 })],
      }),
    );
    expect(p.legs.map((l) => l.legId)).toEqual([L1, L2]);
    expect(leg(p, L2).isLast).toBe(true);
    expect(leg(p, L2).entered).toBe(30);
  });

  it('accepts Decimal-like quantities (objects with toString), as Prisma returns them', () => {
    const dec = (v: string) => ({ toString: () => v });
    const p = shipmentPosition(
      base({
        lines: [{ id: A, orderedQty: dec('40.000') }],
        deliveries: [delivery(L1, '2026-09-10', { [A]: 40 })],
        batches: [{ sourcePoItemId: A, receivedQty: dec('40.000') }],
      }),
    );
    expect(p.accounted).toBe(true);
  });
});
