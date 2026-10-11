import { describe, expect, it } from 'vitest';
import { shipmentPosition } from '../../../../api/src/common/shipment-position';
import type { Shipment } from '@/components/shipment/shipment-model';
import { LOCATION_PLACES, locateGoods, type GoodsBuckets, type LocationBatch } from './goods-location';

/**
 * The where-the-goods-are cards (I3, layout A). Each scenario is built the way
 * the server builds it: the rows a cycle would hold go through the server's own
 * `shipmentPosition`, so these tests read the same figures the page reads, not
 * a hand-written guess at them (CLAUDE.md §4).
 */

const PAD = { poi: 'poi-pad', productId: 'p-pad', productName: 'Brake pad' };
const CHAIN = { poi: 'poi-chain', productId: 'p-chain', productName: 'Chain kit' };

interface Scenario {
  direct?: boolean;
  /** Per order line, how many were ordered. */
  ordered: Array<[typeof PAD, number]>;
  /** Each leg's departure, in sequence order; null = not left. Omit for "no legs yet". */
  legs?: Array<string | null>;
  deliveries?: Array<{ leg: number; line: typeof PAD; qty: number; id?: string }>;
  losses?: Array<{ leg: number; line: typeof PAD; qty: number }>;
  /** Batches received from the last leg: received, and what is left on the shelf. */
  batches?: Array<{ line: typeof PAD; received: number; remaining: number }>;
  /** Batches the position does not see (no source order line — older data). */
  extraBatches?: LocationBatch[];
}

function scenario(s: Scenario) {
  const legs = (s.legs ?? []).map((departedOn, i) => ({ id: `leg-${i + 1}`, sequence: i + 1, departedOn }));
  let n = 0;
  const deliveries = (s.deliveries ?? []).map((d) => ({
    id: `d-${++n}`,
    legId: `leg-${d.leg}`,
    arrivedOn: '2026-09-20',
    lines: [{ id: `dl-${n}`, purchaseOrderItemId: d.line.poi, qty: d.qty }],
  }));
  const position = shipmentPosition({
    lines: s.ordered.map(([line, qty]) => ({ id: line.poi, orderedQty: qty, productId: line.productId, productName: line.productName })),
    legs,
    deliveries,
    losses: (s.losses ?? []).map((l) => ({ legId: `leg-${l.leg}`, purchaseOrderItemId: l.line.poi, qty: l.qty })),
    batches: (s.batches ?? []).map((b) => ({ sourcePoItemId: b.line.poi, receivedQty: b.received })),
  });
  const shipment = {
    lines: position.lines,
    legs: position.legs.map((p) => ({ ...p, departedOn: legs.find((l) => l.id === p.legId)?.departedOn ?? null })),
  } as unknown as Pick<Shipment, 'lines' | 'legs'>;
  const batches: LocationBatch[] = (s.batches ?? []).map((b) => ({
    productId: b.line.productId,
    receivedQty: String(b.received),
    remainingQty: String(b.remaining),
  }));
  const extra = s.extraBatches ?? [];
  return locateGoods({ originType: s.direct ? 'UAE_DIRECT' : 'CHINA', shipment, batches: [...batches, ...extra] });
}

const expectPlaces = (actual: GoodsBuckets, expected: Partial<GoodsBuckets>) => {
  const all: GoodsBuckets = { ordered: 0, inChina: 0, toUae: 0, inUae: 0, toEgypt: 0, inEgypt: 0, notCheckedIn: 0, sold: 0, lost: 0, ...expected };
  const picked = Object.fromEntries(Object.keys(all).map((k) => [k, actual[k as keyof GoodsBuckets]]));
  expect(picked).toEqual(all);
};

const placesSum = (b: GoodsBuckets) => LOCATION_PLACES.reduce((s, k) => s + Math.round(b[k] * 1000), 0) / 1000;

describe('a China cycle (two legs)', () => {
  it('nothing shipped yet: everything ordered is in China', () => {
    const r = scenario({ ordered: [[PAD, 40], [CHAIN, 10]], legs: [null, null] });
    expect(r.direct).toBe(false);
    expectPlaces(r.totals, { ordered: 50, inChina: 50 });
    expectPlaces(r.products.find((p) => p.productId === 'p-chain')!, { ordered: 10, inChina: 10 });
  });

  it('no legs recorded at all: still in China', () => {
    const r = scenario({ ordered: [[PAD, 40]] });
    expectPlaces(r.totals, { ordered: 40, inChina: 40 });
  });

  it('leg 1 left: on the way to the UAE', () => {
    const r = scenario({ ordered: [[PAD, 40]], legs: ['2026-09-01', null] });
    expectPlaces(r.totals, { ordered: 40, toUae: 40 });
  });

  it('a partial delivery in Dubai: 15 of 40 in the UAE, 25 still on the way there', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01', null],
      deliveries: [{ leg: 1, line: PAD, qty: 15 }],
    });
    expectPlaces(r.totals, { ordered: 40, toUae: 25, inUae: 15 });
  });

  it('leg 2 left with what reached Dubai: on the way to Egypt; partial deliveries on both legs', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01', '2026-09-10'],
      deliveries: [
        { leg: 1, line: PAD, qty: 15 },
        { leg: 1, line: PAD, qty: 10 },
        { leg: 2, line: PAD, qty: 12 },
      ],
    });
    // 40 ordered: 15 still to UAE, 25 reached Dubai and left again, 12 of those reached Egypt.
    expectPlaces(r.totals, { ordered: 40, toUae: 15, toEgypt: 13, inEgypt: 12, notCheckedIn: 12 });
  });

  it('goods waiting to be checked in count as in Egypt, and are named apart', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01', '2026-09-10'],
      deliveries: [{ leg: 1, line: PAD, qty: 40 }, { leg: 2, line: PAD, qty: 30 }],
      batches: [{ line: PAD, received: 22, remaining: 22 }],
    });
    expectPlaces(r.totals, { ordered: 40, toEgypt: 10, inEgypt: 30, notCheckedIn: 8 });
  });

  it('lost goods are their own place, on whichever leg they were lost — including units never found at the count', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01', '2026-09-10'],
      deliveries: [{ leg: 1, line: PAD, qty: 35 }, { leg: 2, line: PAD, qty: 35 }],
      losses: [
        { leg: 1, line: PAD, qty: 5 }, // never reached Dubai
        { leg: 2, line: PAD, qty: 3 }, // delivered to Egypt, not found when counted
      ],
      batches: [{ line: PAD, received: 30, remaining: 30 }],
    });
    expectPlaces(r.totals, { ordered: 40, inEgypt: 32, notCheckedIn: 2, lost: 8 });
  });

  it('sold comes off what is in Egypt, per product', () => {
    const r = scenario({
      ordered: [[PAD, 40], [CHAIN, 10]],
      legs: ['2026-09-01', '2026-09-10'],
      deliveries: [
        { leg: 1, line: PAD, qty: 40 },
        { leg: 1, line: CHAIN, qty: 10 },
        { leg: 2, line: PAD, qty: 40 },
        { leg: 2, line: CHAIN, qty: 10 },
      ],
      batches: [
        { line: PAD, received: 25, remaining: 25 },
        { line: PAD, received: 15, remaining: 3 },
        { line: CHAIN, received: 10, remaining: 10 },
      ],
    });
    expectPlaces(r.products.find((p) => p.productId === 'p-pad')!, { ordered: 40, inEgypt: 28, sold: 12 });
    expectPlaces(r.products.find((p) => p.productId === 'p-chain')!, { ordered: 10, inEgypt: 10 });
    expectPlaces(r.totals, { ordered: 50, inEgypt: 38, sold: 12 });
  });

  it('everything sold: Sold equals Ordered and nothing is anywhere else', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01', '2026-09-10'],
      deliveries: [{ leg: 1, line: PAD, qty: 40 }, { leg: 2, line: PAD, qty: 40 }],
      batches: [{ line: PAD, received: 40, remaining: 0 }],
    });
    expectPlaces(r.totals, { ordered: 40, sold: 40 });
  });

  it('a China cycle whose second leg is not recorded yet keeps what reached Dubai in the UAE', () => {
    const r = scenario({
      ordered: [[PAD, 40]],
      legs: ['2026-09-01'],
      deliveries: [{ leg: 1, line: PAD, qty: 15 }],
    });
    expectPlaces(r.totals, { ordered: 40, toUae: 25, inUae: 15 });
  });
});

describe('a UAE-direct cycle (one leg)', () => {
  it('nothing shipped yet: in the UAE; never in China or on the way to the UAE', () => {
    const r = scenario({ direct: true, ordered: [[PAD, 40]], legs: [null] });
    expect(r.direct).toBe(true);
    expectPlaces(r.totals, { ordered: 40, inUae: 40 });
  });

  it('no legs recorded: in the UAE', () => {
    expectPlaces(scenario({ direct: true, ordered: [[PAD, 40]] }).totals, { ordered: 40, inUae: 40 });
  });

  it('left, partly delivered, partly checked in, partly sold, some lost', () => {
    const r = scenario({
      direct: true,
      ordered: [[PAD, 40]],
      legs: ['2026-09-01'],
      deliveries: [{ leg: 1, line: PAD, qty: 15 }, { leg: 1, line: PAD, qty: 10 }],
      losses: [{ leg: 1, line: PAD, qty: 5 }],
      batches: [{ line: PAD, received: 20, remaining: 14 }],
    });
    expectPlaces(r.totals, { ordered: 40, toEgypt: 10, inEgypt: 19, notCheckedIn: 5, sold: 6, lost: 5 });
  });
});

describe('the places always add up to what was ordered', () => {
  it('nothing ordered: every place is zero', () => {
    const r = scenario({ ordered: [], legs: [null, null] });
    expectPlaces(r.totals, {});
    expect(r.products).toEqual([]);
  });

  it('a stale shelf figure never makes Sold more than was received', () => {
    // Batches reading more sold than the position received (an older batch
    // with no source line): Sold is capped at what was received, the sum holds.
    const r = scenario({
      direct: true,
      ordered: [[PAD, 40]],
      legs: ['2026-09-01'],
      deliveries: [{ leg: 1, line: PAD, qty: 10 }],
      batches: [{ line: PAD, received: 10, remaining: 4 }],
      extraBatches: [{ productId: 'p-pad', receivedQty: 20, remainingQty: 0 }],
    });
    expectPlaces(r.totals, { ordered: 40, toEgypt: 30, sold: 10 });
  });

  it('no shipment loaded yet: nothing to place', () => {
    const r = locateGoods({ originType: 'CHINA', shipment: undefined, batches: [] });
    expect(r.products).toEqual([]);
    expectPlaces(r.totals, {});
  });

  it('over 2,000 random cycles, built through the server, every product and the total add up exactly', () => {
    // A small deterministic generator, so a failure names a seed that reproduces it.
    let seed = 20261011;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 2000; run++) {
      const direct = rnd(3) === 0;
      const legCount = direct ? rnd(2) : rnd(3); // 0..1 or 0..2 legs recorded
      const legs = Array.from({ length: legCount }, () => (rnd(4) === 0 ? null : '2026-09-01'));
      const ordered: Array<[typeof PAD, number]> = [[PAD, 1 + rnd(60)], ...(rnd(2) ? [[CHAIN, 1 + rnd(30)] as [typeof PAD, number]] : [])];
      const deliveries: NonNullable<Scenario['deliveries']> = [];
      const losses: NonNullable<Scenario['losses']> = [];
      const batches: NonNullable<Scenario['batches']> = [];
      for (const [line, qty] of ordered) {
        let entering = qty;
        legs.forEach((departed, i) => {
          if (!departed) return; // nothing arrives from a leg that has not left
          const lost = rnd(3) === 0 ? rnd(entering + 1) : 0;
          const delivered = rnd(entering - lost + 1);
          if (delivered) deliveries.push({ leg: i + 1, line, qty: delivered });
          if (lost) losses.push({ leg: i + 1, line, qty: lost });
          entering = delivered;
          if (i === legs.length - 1 && (direct || i === 1) && delivered) {
            const received = rnd(delivered + 1);
            if (received) batches.push({ line, received, remaining: rnd(received + 1) });
          }
        });
      }
      const r = scenario({ direct, ordered, legs, deliveries, losses, batches });
      for (const p of r.products) {
        expect(placesSum(p), `seed run ${run}, ${p.productName}`).toBe(p.ordered);
        for (const k of LOCATION_PLACES) expect(p[k], `run ${run} ${k}`).toBeGreaterThanOrEqual(0);
        expect(p.notCheckedIn).toBeLessThanOrEqual(p.inEgypt);
        if (direct) expect(p.inChina + p.toUae, `run ${run}`).toBe(0);
      }
      expect(placesSum(r.totals), `run ${run}`).toBe(r.totals.ordered);
      expect(r.totals.ordered).toBe(ordered.reduce((s, [, q]) => s + q, 0));
    }
  });
});
