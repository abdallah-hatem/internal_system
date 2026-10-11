import {
  shipmentPosition,
  type PositionDepartureInput,
  type PositionDeliveryInput,
  type ShipmentPositionInput,
} from './shipment-position';
import { planDepartureBackfill } from './departure-backfill';

/**
 * L8 — goods can leave in parts (BUSINESS_LOGIC §1, owner 2026-10-12).
 * The position's reading of departures: what waits at a leg's origin, what is
 * on the way, the leg's status in every state, which departures are free to
 * undo, and that every unit is still in exactly one place.
 */

const L1 = 'leg-1';
const L2 = 'leg-2';
const A = 'line-a';
const B = 'line-b';

let n = 0;
const departure = (
  legId: string,
  departedOn: string,
  lines: Record<string, number>,
): PositionDepartureInput => ({
  id: `dep${++n}`,
  legId,
  departedOn,
  lines: Object.entries(lines).map(([poi, qty]) => ({
    purchaseOrderItemId: poi,
    qty,
  })),
});
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

const china = (over: Partial<ShipmentPositionInput> = {}) =>
  ({
    lines: [{ id: A, orderedQty: 40 }],
    legs: [
      { id: L1, sequence: 1 },
      { id: L2, sequence: 2 },
    ],
    departures: [],
    deliveries: [],
    losses: [],
    batches: [],
    ...over,
  }) satisfies ShipmentPositionInput;

const leg = (p: ReturnType<typeof shipmentPosition>, id: string) =>
  p.legs.find((l) => l.legId === id)!;
const legLine = (p: ReturnType<typeof shipmentPosition>, id: string, poi = A) =>
  leg(p, id).lines.find((l) => l.purchaseOrderItemId === poi)!;

describe('L8 — what waits at origin and what is on the way', () => {
  it('leg 1, 40 ordered, 25 left → 15 at origin, 25 on the way, PARTLY_DEPARTED', () => {
    const p = shipmentPosition(
      china({ departures: [departure(L1, '2026-09-01', { [A]: 25 })] }),
    );
    expect(legLine(p, L1)).toMatchObject({
      entered: 40,
      departed: 25,
      atOrigin: 15,
      onTheWay: 25,
    });
    expect(leg(p, L1).status).toBe('PARTLY_DEPARTED');
    expect(leg(p, L1).departedOn).toBe('2026-09-01');
    expect(p.totals.atOrigin).toBe(15);
    expect(p.totals.onTheWay).toBe(25);
  });

  it('nothing departed → everything waits at origin, nothing is on the way', () => {
    const p = shipmentPosition(china());
    expect(legLine(p, L1)).toMatchObject({ atOrigin: 40, onTheWay: 0 });
    expect(leg(p, L1).status).toBe('PENDING');
    expect(leg(p, L1).departedOn).toBeNull();
  });

  it('two departures, 25 then 15 → in transit, the leg left on the first day', () => {
    const p = shipmentPosition(
      china({
        departures: [
          departure(L1, '2026-09-08', { [A]: 15 }),
          departure(L1, '2026-09-01', { [A]: 25 }),
        ],
      }),
    );
    expect(legLine(p, L1)).toMatchObject({ atOrigin: 0, onTheWay: 40 });
    expect(leg(p, L1).status).toBe('IN_TRANSIT');
    expect(leg(p, L1).departedOn).toBe('2026-09-01');
    expect(leg(p, L1).departures.map((d) => d.departedOn)).toEqual([
      '2026-09-01',
      '2026-09-08',
    ]);
  });

  it('partly departed AND partly arrived → status PARTLY_ARRIVED, with what still waits at origin alongside', () => {
    const p = shipmentPosition(
      china({
        departures: [departure(L1, '2026-09-01', { [A]: 25 })],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 10 })],
      }),
    );
    expect(leg(p, L1).status).toBe('PARTLY_ARRIVED');
    expect(leg(p, L1).atOrigin).toBe(15);
    expect(leg(p, L1).onTheWay).toBe(15);
  });

  it('everything that left was delivered, but some never left → not ARRIVED', () => {
    const p = shipmentPosition(
      china({
        departures: [departure(L1, '2026-09-01', { [A]: 25 })],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 25 })],
      }),
    );
    expect(leg(p, L1).onTheWay).toBe(0);
    expect(leg(p, L1).status).toBe('PARTLY_ARRIVED');
    expect(leg(p, L1).arrivedOn).toBeNull();
  });

  it('everything delivered or lost → ARRIVED', () => {
    const p = shipmentPosition(
      china({
        departures: [
          departure(L1, '2026-09-01', { [A]: 25 }),
          departure(L1, '2026-09-05', { [A]: 15 }),
        ],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 35 })],
        losses: [{ legId: L1, purchaseOrderItemId: A, qty: 5 }],
      }),
    );
    expect(leg(p, L1).status).toBe('ARRIVED');
    expect(leg(p, L1).arrivedOn).toBe('2026-09-15');
  });

  it('leg 2 carries only what leg 1 delivered: 30 reached Dubai, 20 left → 10 in Dubai, 20 on the way to Egypt', () => {
    const p = shipmentPosition(
      china({
        departures: [
          departure(L1, '2026-09-01', { [A]: 40 }),
          departure(L2, '2026-09-20', { [A]: 20 }),
        ],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 30 })],
      }),
    );
    expect(legLine(p, L1)).toMatchObject({ onTheWay: 10, atOrigin: 0 });
    expect(legLine(p, L2)).toMatchObject({
      entered: 30,
      departed: 20,
      atOrigin: 10,
      onTheWay: 20,
    });
    expect(leg(p, L2).status).toBe('PARTLY_DEPARTED');
  });

  it('a leg that had sent everything waits again when the leg before delivers more', () => {
    const input = china({
      departures: [
        departure(L1, '2026-09-01', { [A]: 40 }),
        departure(L2, '2026-09-20', { [A]: 30 }),
      ],
      deliveries: [delivery(L1, '2026-09-15', { [A]: 30 })],
    });
    expect(leg(shipmentPosition(input), L2).status).toBe('IN_TRANSIT');
    input.deliveries.push(delivery(L1, '2026-09-25', { [A]: 10 }));
    const p = shipmentPosition(input);
    expect(leg(p, L2).status).toBe('PARTLY_DEPARTED');
    expect(legLine(p, L2).atOrigin).toBe(10);
  });

  it('on the last leg, a loss beyond what is on the way comes off what was delivered — never off the origin', () => {
    const p = shipmentPosition(
      china({
        lines: [{ id: A, orderedQty: 50 }],
        legs: [{ id: L1, sequence: 1 }],
        departures: [departure(L1, '2026-09-01', { [A]: 40 })],
        deliveries: [delivery(L1, '2026-09-10', { [A]: 40 })],
        losses: [{ legId: L1, purchaseOrderItemId: A, qty: 5 }],
        batches: [{ sourcePoItemId: A, receivedQty: 30 }],
      }),
    );
    expect(legLine(p, L1)).toMatchObject({
      atOrigin: 10,
      onTheWay: 0,
      waiting: 5,
      received: 30,
      lost: 5,
    });
  });

  it('a loss recorded before L8 on a leg that never left comes off the origin, so nothing is counted twice', () => {
    const p = shipmentPosition(
      china({ losses: [{ legId: L1, purchaseOrderItemId: A, qty: 4 }] }),
    );
    expect(legLine(p, L1)).toMatchObject({
      atOrigin: 36,
      onTheWay: 0,
      lost: 4,
    });
  });

  it('a leg with deliveries but no departure (backfilled before L8 from an arrival date alone) → its delivered goods are not back at the origin', () => {
    const p = shipmentPosition(
      china({
        legs: [{ id: L1, sequence: 1 }],
        deliveries: [delivery(L1, '2026-09-10', { [A]: 40 })],
        losses: [],
        batches: [{ sourcePoItemId: A, receivedQty: 38 }],
      }),
    );
    expect(legLine(p, L1)).toMatchObject({
      atOrigin: 0,
      onTheWay: 0,
      waiting: 2,
    });
  });

  it('nextLeg: what a leg added after the last one would find at its origin', () => {
    const none = shipmentPosition(china({ legs: [] }));
    expect(none.nextLeg).toEqual([{ purchaseOrderItemId: A, waiting: 40 }]);
    const one = shipmentPosition(
      china({
        legs: [{ id: L1, sequence: 1 }],
        departures: [departure(L1, '2026-09-01', { [A]: 40 })],
        deliveries: [delivery(L1, '2026-09-15', { [A]: 30 })],
      }),
    );
    expect(one.nextLeg).toEqual([{ purchaseOrderItemId: A, waiting: 30 }]);
  });
});

describe('L8 — which departures can be undone (first in, first out)', () => {
  it('two departures of 10, 5 delivered → the first is in use, the second is free', () => {
    const p = shipmentPosition(
      china({
        lines: [{ id: A, orderedQty: 20 }],
        departures: [
          departure(L1, '2026-09-05', { [A]: 10 }),
          departure(L1, '2026-09-01', { [A]: 10 }),
        ],
        deliveries: [delivery(L1, '2026-09-12', { [A]: 5 })],
      }),
    );
    const [first, second] = leg(p, L1).departures;
    expect(first.departedOn).toBe('2026-09-01');
    expect(first.inUse).toBe(true);
    expect(first.lines[0].accountedFor).toBe(5);
    expect(second.inUse).toBe(false);
  });

  it('a loss on the way uses a departure as a delivery does', () => {
    const p = shipmentPosition(
      china({
        departures: [departure(L1, '2026-09-01', { [A]: 40 })],
        losses: [{ legId: L1, purchaseOrderItemId: A, qty: 1 }],
      }),
    );
    expect(leg(p, L1).departures[0].inUse).toBe(true);
  });

  it('nothing delivered or lost → every departure is free', () => {
    const p = shipmentPosition(
      china({
        departures: [
          departure(L1, '2026-09-01', { [A]: 20 }),
          departure(L1, '2026-09-02', { [A]: 20 }),
        ],
      }),
    );
    expect(leg(p, L1).departures.every((d) => !d.inUse)).toBe(true);
  });

  it('deliveries spill over into the next departure in order', () => {
    const p = shipmentPosition(
      china({
        departures: [
          departure(L1, '2026-09-01', { [A]: 10 }),
          departure(L1, '2026-09-02', { [A]: 10 }),
          departure(L1, '2026-09-03', { [A]: 10 }),
        ],
        deliveries: [delivery(L1, '2026-09-12', { [A]: 15 })],
      }),
    );
    expect(leg(p, L1).departures.map((d) => d.inUse)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe('L8 — the backfill reading old legs', () => {
  it('a departed leg with no rows becomes one departure of everything that entered it, on its Cairo day', () => {
    const plan = planDepartureBackfill({
      legs: [
        // 22:30 UTC on the 31st is 01:30 on 1 September in Cairo.
        { id: L1, sequence: 1, departedOn: new Date('2026-08-31T22:30:00Z') },
        { id: L2, sequence: 2, departedOn: '2026-09-20' },
      ],
      lines: [
        { id: A, orderedQty: '40.000' },
        { id: B, orderedQty: '0' },
      ],
      deliveries: [
        { legId: L1, lines: [{ purchaseOrderItemId: A, qty: '30' }] },
        { legId: L1, lines: [{ purchaseOrderItemId: A, qty: '5' }] },
      ],
      departures: [],
    });
    expect(plan).toEqual([
      {
        legId: L1,
        departedOn: '2026-09-01',
        lines: [{ purchaseOrderItemId: A, qty: '40.000' }],
      },
      {
        legId: L2,
        departedOn: '2026-09-20',
        lines: [{ purchaseOrderItemId: A, qty: '35.000' }],
      },
    ]);
  });

  it('a leg with a departure row already, or with no date, is left alone — running it twice adds nothing', () => {
    expect(
      planDepartureBackfill({
        legs: [
          { id: L1, sequence: 1, departedOn: '2026-09-01' },
          { id: L2, sequence: 2, departedOn: null },
        ],
        lines: [{ id: A, orderedQty: 40 }],
        deliveries: [],
        departures: [{ legId: L1 }],
      }),
    ).toEqual([]);
  });

  it('a later leg whose leg before delivered nothing → a departure with no lines: it still reads as left', () => {
    const plan = planDepartureBackfill({
      legs: [
        { id: L1, sequence: 1, departedOn: '2026-09-01' },
        { id: L2, sequence: 2, departedOn: '2026-09-02' },
      ],
      lines: [{ id: A, orderedQty: 40 }],
      deliveries: [],
      departures: [],
    });
    expect(plan[1]).toEqual({ legId: L2, departedOn: '2026-09-02', lines: [] });
    const p = shipmentPosition(
      china({ departures: plan.map((d, i) => ({ id: `b${i}`, ...d })) }),
    );
    expect(leg(p, L2).status).toBe('IN_TRANSIT');
    expect(leg(p, L1).status).toBe('IN_TRANSIT');
  });
});

describe('L8 — every unit is in exactly one place, whatever happened', () => {
  // A small seeded generator, so a failure names its seed and can be replayed.
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  it('random histories built only from legal moves: at origin + on the way + waiting + received + lost = ordered, per line', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = (max: number) => Math.floor(r() * (max + 1));
      const twoLegs = r() < 0.6;
      const lines = [
        { id: A, orderedQty: 1 + pick(60) },
        { id: B, orderedQty: pick(25) },
      ];
      const legs = twoLegs
        ? [
            { id: L1, sequence: 1 },
            { id: L2, sequence: 2 },
          ]
        : [{ id: L1, sequence: 1 }];
      const input: ShipmentPositionInput = {
        lines,
        legs,
        departures: [],
        deliveries: [],
        losses: [],
        batches: [],
      };
      for (let step = 0; step < 12; step++) {
        const p = shipmentPosition(input);
        const lg = legs[pick(legs.length - 1)].id;
        const lp = leg(p, lg);
        const poi = [A, B][pick(1)];
        const l = lp.lines.find((x) => x.purchaseOrderItemId === poi)!;
        const move = pick(3);
        const dayN = `2026-09-${String(1 + step * 2).padStart(2, '0')}`;
        if (move === 0 && l.atOrigin > 0) {
          input.departures.push(
            departure(lg, dayN, { [poi]: 1 + pick(l.atOrigin - 1) }),
          );
        } else if (move === 1 && l.onTheWay > 0) {
          input.deliveries.push(
            delivery(lg, dayN, { [poi]: 1 + pick(l.onTheWay - 1) }),
          );
        } else if (move === 2 && l.onTheWay + (l.waiting ?? 0) > 0) {
          const most = l.onTheWay + (l.waiting ?? 0);
          input.losses.push({
            legId: lg,
            purchaseOrderItemId: poi,
            qty: 1 + pick(most - 1),
          });
        } else if (move === 3 && lp.isLast && (l.waiting ?? 0) > 0) {
          input.batches.push({
            sourcePoItemId: poi,
            receivedQty: 1 + pick((l.waiting ?? 1) - 1),
          });
        }
      }
      const p = shipmentPosition(input);
      for (const line of p.lines) {
        const placed =
          line.atOrigin +
          line.onTheWay +
          line.waiting +
          line.received +
          line.lost;
        if (placed !== line.ordered) {
          throw new Error(
            `seed ${seed}: ${line.purchaseOrderItemId} placed ${placed} of ${line.ordered}`,
          );
        }
      }
      expect(
        p.totals.atOrigin +
          p.totals.onTheWay +
          p.totals.waiting +
          p.totals.received +
          p.totals.lost,
      ).toBe(p.totals.ordered);
    }
  });
});
