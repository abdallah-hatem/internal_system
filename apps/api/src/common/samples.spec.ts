// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type; the rules are checked in it
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';

import {
  assertNoSamplesOut,
  daysAtShop,
  isSamplesStatus,
  planSamplesDecision,
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

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return ((e as HttpException).getResponse() as { code: string }).code;
  }
  return 'not refused';
}

const LINES = [
  { saleItemId: 'a', productId: 'pa', product: 'Piston kit', outQty: 5 },
  { saleItemId: 'b', productId: 'pb', product: 'Chain', outQty: '0.3' },
];

describe('planSamplesDecision — what the shop decided, checked', () => {
  it('a partial decision: bought and returned add up per line, a price for what is bought', () => {
    const plan = planSamplesDecision('ORD-1', LINES, [
      { saleItemId: 'a', buyQty: 3, returnQty: 2, unitPrice: 250 },
      { saleItemId: 'b', buyQty: 0, returnQty: '0.3' },
    ]);
    expect(plan.map((l) => [l.buy.toString(), l.back.toString()])).toEqual([
      ['3', '2'],
      ['0', '0.3'],
    ]);
    expect(plan[0].unitPrice?.toString()).toBe('250');
    // Nothing bought of the chain: no price asked for, none recorded.
    expect(plan[1].unitPrice).toBeNull();
  });

  it('all bought, none returned, and all returned, none bought, both pass', () => {
    const all = planSamplesDecision('ORD-1', LINES, [
      { saleItemId: 'a', buyQty: 5, returnQty: 0, unitPrice: 1 },
      { saleItemId: 'b', buyQty: '0.3', returnQty: 0, unitPrice: '10' },
    ]);
    expect(all.every((l) => l.back.isZero())).toBe(true);
    const none = planSamplesDecision('ORD-1', LINES, [
      { saleItemId: 'a', buyQty: 0, returnQty: 5 },
      { saleItemId: 'b', buyQty: 0, returnQty: 0.3 },
    ]);
    expect(none.every((l) => l.buy.isZero())).toBe(true);
  });

  it('buying + returned is compared in Decimal: 0.1 + 0.2 of 0.3 out is exact', () => {
    const plan = planSamplesDecision(
      'ORD-1',
      [LINES[1]],
      [{ saleItemId: 'b', buyQty: 0.1, returnQty: 0.2, unitPrice: 5 }],
    );
    expect(plan[0].buy.add(plan[0].back).toString()).toBe('0.3');
  });

  it.each([
    ['more than is out', { buyQty: 4, returnQty: 2 }],
    ['less than is out', { buyQty: 2, returnQty: 2 }],
    ['zero of everything', { buyQty: 0, returnQty: 0 }],
  ])('%s → SAMPLES_DECISION_MISMATCH', (_name, qty) => {
    expect(
      codeOf(() =>
        planSamplesDecision(
          'ORD-1',
          [LINES[0]],
          [{ saleItemId: 'a', unitPrice: 10, ...qty }],
        ),
      ),
    ).toBe('SAMPLES_DECISION_MISMATCH');
  });

  it('a negative quantity is refused even when the sum matches (-1 bought, 6 back of 5)', () => {
    expect(
      codeOf(() =>
        planSamplesDecision(
          'ORD-1',
          [LINES[0]],
          [{ saleItemId: 'a', buyQty: -1, returnQty: 6, unitPrice: 10 }],
        ),
      ),
    ).toBe('SAMPLES_QTY_NEGATIVE');
  });

  it('a bought line with no price → SAMPLES_PRICE_REQUIRED; 0 is a price, a negative one is not', () => {
    for (const unitPrice of [undefined, null, '']) {
      expect(
        codeOf(() =>
          planSamplesDecision(
            'ORD-1',
            [LINES[0]],
            [{ saleItemId: 'a', buyQty: 1, returnQty: 4, unitPrice }],
          ),
        ),
      ).toBe('SAMPLES_PRICE_REQUIRED');
    }
    expect(
      planSamplesDecision(
        'ORD-1',
        [LINES[0]],
        [{ saleItemId: 'a', buyQty: 1, returnQty: 4, unitPrice: 0 }],
      )[0].unitPrice?.toString(),
    ).toBe('0');
    expect(
      codeOf(() =>
        planSamplesDecision(
          'ORD-1',
          [LINES[0]],
          [{ saleItemId: 'a', buyQty: 1, returnQty: 4, unitPrice: -5 }],
        ),
      ),
    ).toBe('PRICE_NEGATIVE');
  });

  it('every line must be decided once: a line left out, named twice, or not on the order is refused', () => {
    expect(
      codeOf(() =>
        planSamplesDecision('ORD-1', LINES, [
          { saleItemId: 'a', buyQty: 5, returnQty: 0, unitPrice: 1 },
        ]),
      ),
    ).toBe('SAMPLES_LINE_MISSING');
    expect(
      codeOf(() =>
        planSamplesDecision('ORD-1', LINES, [
          { saleItemId: 'a', buyQty: 5, returnQty: 0, unitPrice: 1 },
          { saleItemId: 'a', buyQty: 5, returnQty: 0, unitPrice: 1 },
        ]),
      ),
    ).toBe('SAMPLES_LINE_TWICE');
    expect(
      codeOf(() =>
        planSamplesDecision('ORD-1', LINES, [
          { saleItemId: 'someone-elses', buyQty: 1, returnQty: 0 },
        ]),
      ),
    ).toBe('SAMPLES_LINE_NOT_IN_ORDER');
  });

  it('a body that is not a list, or text where a number goes, is VALIDATION_FAILED — never a 500', () => {
    expect(codeOf(() => planSamplesDecision('ORD-1', LINES, undefined))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(() => planSamplesDecision('ORD-1', LINES, []))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      codeOf(() =>
        planSamplesDecision(
          'ORD-1',
          [LINES[0]],
          [{ saleItemId: 'a', buyQty: 'three', returnQty: 2, unitPrice: 1 }],
        ),
      ),
    ).toBe('VALIDATION_FAILED');
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

it('the samples statuses are exactly the three, and none is a sale', () => {
  expect(
    ['SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF'].every(
      isSamplesStatus,
    ),
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
