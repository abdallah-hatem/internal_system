import {
  ABSORBED_REASON,
  BackfillCycle,
  BackfillPlan,
  planShipmentBackfill,
} from './shipment-backfill';
import { shipmentPosition } from './shipment-position';

/**
 * B1's migration cases (plan 2026-10-10). The backfill is a pure planner, so
 * each case is a stored cycle in, the rows to write out. `apply` plays the
 * script's part — writes the plan into the snapshot — so "run it twice" and
 * "what does the position say afterwards" are tested without a database.
 */

let n = 0;
const id = () => `id-${++n}`;

const LEG1 = 'leg-1';
const LEG2 = 'leg-2';
const A = 'line-a';
const B = 'line-b';

function cycle(over: Partial<BackfillCycle> = {}): BackfillCycle {
  return {
    legs: [
      { id: LEG1, sequence: 1, arrivedOn: new Date('2026-08-10T00:00:00Z') },
      { id: LEG2, sequence: 2, arrivedOn: new Date('2026-09-01T00:00:00Z') },
    ],
    items: [{ id: A, orderedQty: '20.000' }],
    batches: [],
    deliveries: [],
    losses: [],
    ...over,
  };
}

/** What the script does with a plan, done to the snapshot instead of a database. */
function apply(c: BackfillCycle, plan: BackfillPlan): BackfillCycle {
  return {
    legs: c.legs.map((l) => {
      const u = plan.legUpdates.find((x) => x.legId === l.id);
      return u ? { ...l, arrivedOn: new Date(`${u.arrivedOn}T00:00:00Z`) } : l;
    }),
    items: c.items,
    batches: c.batches.map((b) => {
      const link = plan.batchLinks.find((x) => x.batchId === b.id);
      return link
        ? { ...b, sourceDeliveryLineId: link.sourceDeliveryLineId }
        : b;
    }),
    deliveries: [
      ...c.deliveries,
      ...plan.deliveries.map((d) => ({
        id: d.id,
        legId: d.legId,
        arrivedOn: d.arrivedOn,
        lines: d.lines,
      })),
    ],
    losses: [...c.losses, ...plan.losses],
  };
}

/**
 * The position after the backfill, read the way the app reads it. Only for a
 * cycle that had no deliveries before (the snapshot does not carry their qty).
 */
function positionAfter(c: BackfillCycle, plan: BackfillPlan) {
  expect(c.deliveries).toEqual([]);
  const done = apply(c, plan);
  return shipmentPosition({
    lines: done.items.map((i) => ({ id: i.id, orderedQty: i.orderedQty })),
    legs: done.legs.map((l) => ({ id: l.id, sequence: l.sequence })),
    deliveries: plan.deliveries,
    losses: done.losses.map((l) => ({
      ...l,
      qty: (l as { qty?: string }).qty ?? 0,
    })),
    batches: done.batches,
  });
}

const batch = (
  poi: string,
  qty: string,
  createdAt = '2026-09-02T09:00:00Z',
) => ({
  id: id(),
  sourcePoItemId: poi,
  sourceDeliveryLineId: null,
  receivedQty: qty,
  createdAt: new Date(createdAt),
});

describe('planShipmentBackfill', () => {
  it('backfill run twice → no duplicate deliveries or losses', () => {
    const c = cycle({ batches: [batch(A, '18.000')] });
    const first = planShipmentBackfill(c, id);
    expect(first.deliveries).toHaveLength(2);
    expect(first.losses).toHaveLength(1);
    expect(first.batchLinks).toHaveLength(1);

    const second = planShipmentBackfill(apply(c, first), id);
    expect(second).toEqual({
      deliveries: [],
      legUpdates: [],
      batchLinks: [],
      losses: [],
    });
  });

  it('backfill: a legacy line with receivedQty 0 on a SELLING cycle → a delivery waiting to be received; the cycle is not accounted', () => {
    const c = cycle({
      items: [
        { id: A, orderedQty: '20' },
        { id: B, orderedQty: '5' },
      ],
      // A was received in full; B never was (no batch).
      batches: [batch(A, '20')],
    });
    const plan = planShipmentBackfill(c, id);
    // No loss for B: never received is waiting, not short.
    expect(plan.losses).toEqual([]);
    const p = positionAfter(c, plan);
    const b = p.lines.find((l) => l.purchaseOrderItemId === B)!;
    expect(b.waiting).toBe(5);
    expect(b.onTheWay).toBe(0);
    expect(p.accounted).toBe(false);
  });

  it("backfill: a last leg with batches but no arrivedOn → a delivery dated the first batch's receipt day (Cairo)", () => {
    const c = cycle({
      legs: [
        { id: LEG1, sequence: 1, arrivedOn: new Date('2026-08-10T00:00:00Z') },
        { id: LEG2, sequence: 2, arrivedOn: null },
      ],
      batches: [
        batch(A, '10', '2026-09-20T08:00:00Z'),
        // 22:30 UTC on the 14th is 01:30 on the 15th in Cairo (UTC+3 in September).
        batch(A, '10', '2026-09-14T22:30:00Z'),
      ],
    });
    const plan = planShipmentBackfill(c, id);
    const last = plan.deliveries.find((d) => d.legId === LEG2)!;
    expect(last.arrivedOn).toBe('2026-09-15');
    expect(last.lines).toEqual([
      expect.objectContaining({ purchaseOrderItemId: A, qty: '20.000' }),
    ]);
    // The leg itself now reads arrived on that day — what check-data 12.3
    // ("stock received while a leg says it has not arrived") looks for.
    expect(plan.legUpdates).toEqual([
      { legId: LEG2, arrivedOn: '2026-09-15', status: 'ARRIVED' },
    ]);
    expect(plan.batchLinks.every((b) => b.arrivedOn === '2026-09-15')).toBe(
      true,
    );
  });

  it('backfill: a dated leg with no departure → backfilled anyway', () => {
    // The planner never reads departedOn: a dated leg is history, whatever
    // else was or was not recorded about it.
    const c = cycle({
      legs: [
        { id: LEG1, sequence: 1, arrivedOn: new Date('2026-08-10T00:00:00Z') },
      ],
    });
    const plan = planShipmentBackfill(c, id);
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0].legId).toBe(LEG1);
  });

  it('backfill: a leg dated before the migration → one delivery of the full ordered qty on that date', () => {
    const c = cycle({
      items: [
        { id: A, orderedQty: '20' },
        { id: B, orderedQty: '7.5' },
      ],
    });
    const plan = planShipmentBackfill(c, id);
    const leg1 = plan.deliveries.filter((d) => d.legId === LEG1);
    expect(leg1).toHaveLength(1);
    expect(leg1[0].arrivedOn).toBe('2026-08-10');
    expect(leg1[0].lines.map((l) => [l.purchaseOrderItemId, l.qty])).toEqual([
      [A, '20.000'],
      [B, '7.500'],
    ]);
  });

  it('backfill: a line received 18 of 20 → a loss of 2 at cost 0, so check-data and settlement do not count it twice', () => {
    const c = cycle({ batches: [batch(A, '18')] });
    const plan = planShipmentBackfill(c, id);
    expect(plan.losses).toEqual([
      {
        legId: LEG2,
        purchaseOrderItemId: A,
        qty: '2.000',
        unitCostEgp: '0',
        costEgp: '0',
        reason: ABSORBED_REASON,
      },
    ]);
    const p = positionAfter(c, plan);
    expect(p.accounted).toBe(true);
    expect(p.totals).toEqual({
      ordered: 20,
      received: 18,
      lost: 2,
      onTheWay: 0,
      waiting: 0,
    });
  });

  it('backfill on a database with no cycles → runs, changes nothing', () => {
    const cycles: BackfillCycle[] = [];
    expect(cycles.map((c) => planShipmentBackfill(c, id))).toEqual([]);
    // And a cycle with nothing on it at all.
    const empty = planShipmentBackfill(
      { legs: [], items: [], batches: [], deliveries: [], losses: [] },
      id,
    );
    expect(empty).toEqual({
      deliveries: [],
      legUpdates: [],
      batchLinks: [],
      losses: [],
    });
  });

  // ── Beyond the plan's list (rule 0). ──

  it('a leg that already has a delivery is left alone, even with a different date', () => {
    const c = cycle({
      deliveries: [
        {
          id: 'd-old',
          legId: LEG1,
          arrivedOn: '2026-08-12',
          lines: [{ id: 'dl-old', purchaseOrderItemId: A }],
        },
      ],
    });
    const plan = planShipmentBackfill(c, id);
    expect(plan.deliveries.map((d) => d.legId)).toEqual([LEG2]);
  });

  it('a batch already linked is not re-linked', () => {
    const c = cycle({
      batches: [{ ...batch(A, '20'), sourceDeliveryLineId: 'dl-x' }],
    });
    expect(planShipmentBackfill(c, id).batchLinks).toEqual([]);
  });

  it('batches are linked to the LAST leg, never to leg 1', () => {
    const c = cycle({ batches: [batch(A, '20')] });
    const plan = planShipmentBackfill(c, id);
    const lastLineIds = plan.deliveries
      .filter((d) => d.legId === LEG2)
      .flatMap((d) => d.lines.map((l) => l.id));
    expect(lastLineIds).toContain(plan.batchLinks[0].sourceDeliveryLineId);
    expect(plan.batchLinks[0].arrivedOn).toBe('2026-09-01');
  });

  it('a cycle with batches but no legs → nothing to hang a delivery on, nothing written', () => {
    const c = cycle({ legs: [], batches: [batch(A, '18')] });
    expect(planShipmentBackfill(c, id)).toEqual({
      deliveries: [],
      legUpdates: [],
      batchLinks: [],
      losses: [],
    });
  });

  it('an undated China cycle with batches → both legs get the batch day, so leg 2 carries what leg 1 delivered', () => {
    const c = cycle({
      legs: [
        { id: LEG1, sequence: 1, arrivedOn: null },
        { id: LEG2, sequence: 2, arrivedOn: null },
      ],
      batches: [batch(A, '20', '2026-09-03T10:00:00Z')],
    });
    const plan = planShipmentBackfill(c, id);
    expect(plan.deliveries.map((d) => [d.legId, d.arrivedOn])).toEqual([
      [LEG1, '2026-09-03'],
      [LEG2, '2026-09-03'],
    ]);
    expect(positionAfter(c, plan).accounted).toBe(true);
  });

  it('an order line ordered 0 gets no delivery line (a delivery line of 0 is refused by the table)', () => {
    const c = cycle({
      items: [
        { id: A, orderedQty: '20' },
        { id: B, orderedQty: '0' },
      ],
    });
    const plan = planShipmentBackfill(c, id);
    expect(
      plan.deliveries.flatMap((d) => d.lines.map((l) => l.purchaseOrderItemId)),
    ).not.toContain(B);
  });

  it('a cycle that ordered nothing but has a dated leg → no empty delivery', () => {
    const c = cycle({ items: [] });
    expect(planShipmentBackfill(c, id).deliveries).toEqual([]);
  });
});
