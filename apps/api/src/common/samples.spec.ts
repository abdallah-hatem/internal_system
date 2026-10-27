// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type; the rules are checked in it
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';

import {
  assertNoSamplesOut,
  daysAtShop,
  isSamplesStatus,
  planSampleLines,
  planSamplesConversion,
  samplesReminderDay,
  samplesRemindersDue,
  splitSampleAllocations,
} from './samples';
import { startOfBusinessDay } from './dates';
import { buildStatement } from './customer-statement';
import { cycleCostLines, sumCostLines } from './payout-breakdown';

/**
 * Samples left at shops (BUSINESS_LOGIC §4, owner 2026-10-18): the pure rules.
 * Every refusal is tried as well as the happy path (CLAUDE.md §0): too much,
 * too little, negative, twice, missing, and the arithmetic in Decimal.
 */

const D = (v: number | string) => new Prisma.Decimal(v);

// Two batches of the piston kit went out: 2 at 100 (older), 3 at 130 (newer).
const DRAWS = [
  { productId: 'pa', batchId: 'old', qty: 2, unitCostEgp: 100 },
  { productId: 'pa', batchId: 'new', qty: 3, unitCostEgp: 130 },
  { productId: 'pb', batchId: 'chain', qty: '0.3', unitCostEgp: 50 },
];

const kept = (plan: ReturnType<typeof planSamplesConversion>, i: number) =>
  plan.lines[i].fromSamples.map((k) => [
    k.batchId,
    k.qty.toString(),
    k.cogsEgp.toFixed(2),
  ]);
const product = (
  plan: ReturnType<typeof planSamplesConversion>,
  id: string,
) => {
  const p = plan.products.find((x) => x.productId === id)!;
  return {
    out: p.out.toString(),
    kept: p.kept.toString(),
    extra: p.extra.toString(),
    back: p.back.map((b) => [b.batchId, b.qty.toString()]),
  };
};

describe('planSamplesConversion — the sale from samples, as the popup was saved', () => {
  it('everything kept as it went out: the same units at the cost they left at, nothing back, nothing more drawn', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pa', quantity: 5 },
      { productId: 'pb', quantity: '0.3' },
    ]);
    expect(kept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '3', '390.00'],
    ]);
    expect(plan.lines.map((l) => l.fromShelf.toString())).toEqual(['0', '0']);
    expect(product(plan, 'pa')).toEqual({
      out: '5',
      kept: '5',
      extra: '0',
      back: [],
    });
  });

  it('a lowered quantity keeps the oldest units; the rest go back to the newer batch they left', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pa', quantity: 3 },
      { productId: 'pb', quantity: '0.3' },
    ]);
    expect(kept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '1', '130.00'],
    ]);
    expect(product(plan, 'pa')).toEqual({
      out: '5',
      kept: '3',
      extra: '0',
      back: [['new', '2']],
    });
  });

  it('a removed sample line: all of it back, each unit to its own batch', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pb', quantity: '0.3' },
    ]);
    expect(plan.lines).toHaveLength(1);
    expect(product(plan, 'pa')).toEqual({
      out: '5',
      kept: '0',
      extra: '0',
      back: [
        ['old', '2'],
        ['new', '3'],
      ],
    });
  });

  it('a raised quantity keeps every unit that went out and asks the shelf for the rest only', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pa', quantity: 8 },
    ]);
    expect(kept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '3', '390.00'],
    ]);
    expect(plan.lines[0].fromShelf.toString()).toBe('3');
    expect(product(plan, 'pa')).toMatchObject({
      kept: '5',
      extra: '3',
      back: [],
    });
    // The chain was not on the sale: all 0.3 back.
    expect(product(plan, 'pb').back).toEqual([['chain', '0.3']]);
  });

  it('a product that never went out is drawn from the shelf in full', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pa', quantity: 5 },
      { productId: 'pc', quantity: 4 },
    ]);
    expect(plan.lines[1]).toEqual({ fromSamples: [], fromShelf: D(4) });
    expect(product(plan, 'pc')).toEqual({
      out: '0',
      kept: '0',
      extra: '4',
      back: [],
    });
  });

  it('two lines of one product share what went out in order, the second taking the shelf for its rest', () => {
    const plan = planSamplesConversion(DRAWS, [
      { productId: 'pa', quantity: 3 },
      { productId: 'pa', quantity: 4 },
    ]);
    expect(kept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '1', '130.00'],
    ]);
    expect(kept(plan, 1)).toEqual([['new', '2', '260.00']]);
    expect(plan.lines.map((l) => l.fromShelf.toString())).toEqual(['0', '2']);
    expect(product(plan, 'pa')).toMatchObject({
      kept: '5',
      extra: '2',
      back: [],
    });
  });

  it('every unit that went out is either kept or back, and the sale gets exactly its quantities — in Decimal', () => {
    for (const wanted of [0, 0.1, 0.2, 0.3, 0.7, 1, 2.5, 5, 6.25, 12]) {
      const lines =
        wanted > 0 ? [{ productId: 'pa', quantity: String(wanted) }] : [];
      const plan = planSamplesConversion(DRAWS, lines);
      const p = plan.products.find((x) => x.productId === 'pa')!;
      const back = p.back.reduce((s, b) => s.add(b.qty), D(0));
      expect(p.kept.add(back).toString()).toBe('5');
      if (wanted > 0) {
        const got = plan.lines[0].fromSamples
          .reduce((s, k) => s.add(k.qty), D(0))
          .add(plan.lines[0].fromShelf);
        expect(got.toString()).toBe(D(wanted).toString());
        expect(plan.lines[0].fromShelf.toString()).toBe(p.extra.toString());
      }
    }
    // 0.1 + 0.2 of the chain's 0.3 is exact.
    const chain = planSamplesConversion(DRAWS, [
      { productId: 'pb', quantity: '0.1' },
      { productId: 'pb', quantity: '0.2' },
    ]);
    expect(product(chain, 'pb')).toEqual({
      out: '0.3',
      kept: '0.3',
      extra: '0',
      back: [],
    });
  });
});

describe('planSampleLines — New Order lines bought from samples the shop holds (owner 2026-10-27)', () => {
  const linesKept = (plan: ReturnType<typeof planSampleLines>, i: number) =>
    plan.lines[i].fromSamples.map((k) => [
      k.batchId,
      k.qty.toString(),
      k.cogsEgp.toFixed(2),
    ]);
  const shelf = (plan: ReturnType<typeof planSampleLines>) =>
    Object.fromEntries([...plan.shelf].map(([p, q]) => [p, q.toString()]));
  const ORDERS = new Map([
    ['s1', DRAWS],
    ['s2', [{ productId: 'pa', batchId: 'later', qty: 1, unitCostEgp: 150 }]],
  ]);

  it('all of the sample: every unit from it, oldest first, at the cost it left at; nothing from the shelf', () => {
    const plan = planSampleLines(
      [{ productId: 'pa', quantity: 5, fromSamplesOrderId: 's1' }],
      ORDERS,
    );
    expect(linesKept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '3', '390.00'],
    ]);
    expect(shelf(plan)).toEqual({});
    expect(plan.taken.get('s1')?.map((t) => t.kept.toString())).toEqual(['5']);
  });

  it('less than the sample: the oldest units, the rest stays a sample; products not on the sale are not touched', () => {
    const plan = planSampleLines(
      [{ productId: 'pa', quantity: 1, fromSamplesOrderId: 's1' }],
      ORDERS,
    );
    expect(linesKept(plan, 0)).toEqual([['old', '1', '100.00']]);
    // pb went out on s1 too, but no line takes it: it is not in the plan.
    expect(plan.taken.get('s1')?.map((t) => t.productId)).toEqual(['pa']);
    expect(shelf(plan)).toEqual({});
  });

  it('more than the sample: the sample first, the rest from the shelf', () => {
    const plan = planSampleLines(
      [{ productId: 'pa', quantity: 8, fromSamplesOrderId: 's1' }],
      ORDERS,
    );
    expect(plan.lines[0].fromShelf.toString()).toBe('3');
    expect(shelf(plan)).toEqual({ pa: '3' });
  });

  it('none: a line with no samples order is all shelf, even when the shop holds that product', () => {
    const plan = planSampleLines([{ productId: 'pa', quantity: 2 }], ORDERS);
    expect(plan.lines[0].fromSamples).toEqual([]);
    expect(shelf(plan)).toEqual({ pa: '2' });
    expect(plan.taken.size).toBe(0);
  });

  it('two samples orders and two lines of one product: each line its own order, the shelf need summed per product', () => {
    const plan = planSampleLines(
      [
        { productId: 'pa', quantity: 3, fromSamplesOrderId: 's2' },
        { productId: 'pa', quantity: 4, fromSamplesOrderId: 's1' },
        { productId: 'pa', quantity: '1.5' },
        { productId: 'pb', quantity: '0.3', fromSamplesOrderId: 's1' },
      ],
      ORDERS,
    );
    expect(linesKept(plan, 0)).toEqual([['later', '1', '150.00']]);
    expect(linesKept(plan, 1)).toEqual([
      ['old', '2', '200.00'],
      ['new', '2', '260.00'],
    ]);
    expect(linesKept(plan, 3)).toEqual([['chain', '0.3', '15.00']]);
    // 2 beyond s2, 1.5 untagged.
    expect(shelf(plan)).toEqual({ pa: '3.5' });
  });

  it('two lines on the same samples order share it in the order given, never counting a unit twice', () => {
    const plan = planSampleLines(
      [
        { productId: 'pa', quantity: 4, fromSamplesOrderId: 's1' },
        { productId: 'pa', quantity: 4, fromSamplesOrderId: 's1' },
      ],
      ORDERS,
    );
    expect(linesKept(plan, 0)).toEqual([
      ['old', '2', '200.00'],
      ['new', '2', '260.00'],
    ]);
    expect(linesKept(plan, 1)).toEqual([['new', '1', '130.00']]);
    expect(plan.lines.map((l) => l.fromShelf.toString())).toEqual(['0', '3']);
  });
});

describe('splitSampleAllocations — which units are bought, which come back', () => {
  // Drawn FIFO: 2 from the old batch at 100, 3 from the newer at 130.
  const draws = [
    { id: 'old', batchId: 'B-old', qty: 2, unitCostEgp: 100 },
    { id: 'new', batchId: 'B-new', qty: 3, unitCostEgp: 130 },
  ];

  it('bought units are the oldest ones (FIFO); returned units go back to the batch they left', () => {
    const split = splitSampleAllocations(draws, 3);
    expect(
      split.keep.map((k) => [k.id, k.qty.toString(), k.cogsEgp.toString()]),
    ).toEqual([
      ['old', '2', '200'],
      ['new', '1', '130'],
    ]);
    expect(split.remove).toEqual([]);
    expect(split.back.map((b) => [b.batchId, b.qty.toString()])).toEqual([
      ['B-new', '2'],
    ]);
  });

  it('nothing bought: every draw removed and every unit back, to its own batch', () => {
    const split = splitSampleAllocations(draws, 0);
    expect(split.keep).toEqual([]);
    expect(split.remove).toEqual(['old', 'new']);
    expect(split.back.map((b) => [b.batchId, b.qty.toString()])).toEqual([
      ['B-old', '2'],
      ['B-new', '3'],
    ]);
  });

  it('every unit is either kept or back — never both, never lost', () => {
    for (const buy of [0, 1, 2, 2.5, 3, 4.999, 5]) {
      const split = splitSampleAllocations(draws, buy);
      const kept = split.keep.reduce((s, k) => s.add(k.qty), D(0));
      const back = split.back.reduce((s, b) => s.add(b.qty), D(0));
      expect(kept.toString()).toBe(D(buy).toString());
      expect(kept.add(back).toString()).toBe('5');
    }
  });

  it('buying more than the draws hold is a bug, not a quiet partial sale', () => {
    expect(() => splitSampleAllocations(draws, 6)).toThrow();
  });
});

describe('the 14-day reminder', () => {
  // Left at 10:00 Cairo on 2026-10-01.
  const leftAt = new Date(
    startOfBusinessDay('2026-10-01').getTime() + 10 * 3_600_000,
  );
  const order = (
    patch: Partial<Parameters<typeof samplesRemindersDue>[0][number]> = {},
  ) => ({
    id: 'o1',
    status: 'SAMPLES',
    samplesLeftAt: leftAt,
    samplesRemindedAt: null,
    ...patch,
  });
  const at = (day: string, hour = 7) =>
    new Date(startOfBusinessDay(day).getTime() + hour * 3_600_000);

  it('is due on the 14th Cairo day after they were left, not the 13th', () => {
    expect(samplesReminderDay(leftAt)).toBe('2026-10-15');
    expect(samplesRemindersDue([order()], at('2026-10-14', 23))).toHaveLength(
      0,
    );
    expect(samplesRemindersDue([order()], at('2026-10-15', 0))).toHaveLength(1);
    expect(samplesRemindersDue([order()], at('2026-11-30'))).toHaveLength(1);
  });

  it('never twice, and never for samples already decided', () => {
    const now = at('2026-10-20');
    expect(
      samplesRemindersDue(
        [order({ samplesRemindedAt: at('2026-10-15') })],
        now,
      ),
    ).toHaveLength(0);
    for (const status of [
      'SAMPLES_RETURNED',
      'SAMPLES_WRITTEN_OFF',
      'CONFIRMED',
      'PAID',
    ]) {
      expect(samplesRemindersDue([order({ status })], now)).toHaveLength(0);
    }
    // An ordinary sale never was samples.
    expect(
      samplesRemindersDue(
        [order({ status: 'SAMPLES', samplesLeftAt: null })],
        now,
      ),
    ).toHaveLength(0);
  });

  it('counts Cairo days across a whole year, every hour (no UTC/local drift)', () => {
    for (let d = 0; d < 365; d += 1) {
      const day = new Date(Date.UTC(2026, 0, 1) + d * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const hour of [0, 1, 11, 22, 23]) {
        const left = new Date(
          startOfBusinessDay(day).getTime() + hour * 3_600_000 + 60_000,
        );
        const due = samplesReminderDay(left);
        // 14 days later at the same hour is due; one day before is not.
        const later = new Date(startOfBusinessDay(due).getTime() + 60_000);
        expect(daysAtShop(left, later)).toBe(14);
        const before = new Date(startOfBusinessDay(due).getTime() - 60_000);
        expect(
          samplesRemindersDue([order({ samplesLeftAt: left })], before),
        ).toHaveLength(0);
      }
    }
  });
});

describe('settling with samples out', () => {
  it('names how many units at which shops', () => {
    try {
      assertNoSamplesOut('CYC-2026-0001', [
        { shop: 'Nile Motors', units: 3 },
        { shop: 'Delta Bikes', units: '2.5' },
      ]);
      throw new Error('not refused');
    } catch (e) {
      const body = (e as HttpException).getResponse() as {
        code: string;
        params: Record<string, string>;
      };
      expect(body.code).toBe('CYCLE_HAS_SAMPLES_OUT');
      expect(body.params).toEqual({
        cycle: 'CYC-2026-0001',
        units: '5.5',
        shops: 'Nile Motors (3), Delta Bikes (2.5)',
      });
    }
  });

  it('nothing out → no refusal', () => {
    expect(() => assertNoSamplesOut('CYC-1', [])).not.toThrow();
    expect(() =>
      assertNoSamplesOut('CYC-1', [{ shop: 'A', units: 0 }]),
    ).not.toThrow();
  });
});

it('the samples statuses are exactly the four, and none is a sale', () => {
  expect(
    [
      'SAMPLES',
      'SAMPLES_RETURNED',
      'SAMPLES_WRITTEN_OFF',
      // Every unit went into other sales (owner 2026-10-27): not a sale itself.
      'SAMPLES_BOUGHT',
    ].every(isSamplesStatus),
  ).toBe(true);
  for (const s of [
    'DRAFT',
    'CONFIRMED',
    'PARTIALLY_PAID',
    'PAID',
    'CANCELLED',
    'RETURNED',
  ]) {
    expect(isSamplesStatus(s)).toBe(false);
  }
});

describe('not a sale, wherever a sale is counted', () => {
  it('a shop statement shows no row for samples — open, returned or written off — and a bought one on its day', () => {
    const order = (id: string, status: string, total: number, day: string) => ({
      id,
      orderNo: id,
      status,
      total,
      orderedAt: new Date(`${day}T10:00:00Z`),
      items: [{ id: `${id}-i`, quantity: 2 }],
    });
    const statement = buildStatement(
      { id: 'c', displayName: 'Nile Motors', phone: null },
      {
        orders: [
          order('S-OPEN', 'SAMPLES', 0, '2026-10-01'),
          order('S-BACK', 'SAMPLES_RETURNED', 0, '2026-10-02'),
          order('S-GONE', 'SAMPLES_WRITTEN_OFF', 0, '2026-10-03'),
          order('S-BOUGHT', 'CONFIRMED', 640, '2026-10-15'),
        ],
        payments: [],
        returns: [],
      },
    );
    expect(statement.rows.map((r) => [r.kind, r.reference])).toEqual([
      ['SALE', 'S-BOUGHT'],
    ]);
    expect(statement.closingBalance).toBe('640.00');
  });

  it('a payout lists samples written off as their own line, and the lines still add up', () => {
    const lines = cycleCostLines({
      expenseRows: [],
      recoveryRows: [],
      otherIncomeRows: [],
      lossesEgp: D(700),
      samplesWrittenOffEgp: D('703.80'),
      exchangeDifferenceEgp: D(0),
    });
    expect(lines).toEqual([
      { kind: 'loss', category: null, amountEgp: '700.00' },
      { kind: 'loss', category: 'samples_written_off', amountEgp: '703.80' },
    ]);
    expect(sumCostLines(lines).toFixed(2)).toBe('1403.80');
  });
});
