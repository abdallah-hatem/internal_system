// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import {
  cyclesForCost,
  equalParts,
  runningEntries,
  runningOn,
  type CycleHistory,
} from './running-cost-allocation';

/**
 * Which cycles a running cost dated on a day is shared to (BUSINESS_LOGIC §8,
 * owner 2026-11-08: "by day its dated, we need to know when statuses moved";
 * a cycle runs "the moment we pay for the goods" — Preparing — until its
 * settlement is approved). Pure: every case is built from a status history.
 *
 * Days are Cairo days. In November Cairo is UTC+2, so 22:00 UTC is midnight;
 * in July (summer time) UTC+3, so 21:00 UTC is midnight.
 */

const at = (iso: string) => new Date(iso);
let n = 0;
function cycle(
  changes: [string | null, string, string][],
  opts: {
    locked?: boolean;
    createdAt?: string;
    status?: string;
    id?: string;
  } = {},
): CycleHistory {
  n += 1;
  const created = opts.createdAt ?? changes[0]?.[2] ?? '2026-01-01T08:00:00Z';
  return {
    id: opts.id ?? `c${String(n).padStart(3, '0')}`,
    createdAt: at(created),
    status: opts.status ?? changes[changes.length - 1]?.[1] ?? 'PLANNING',
    locked: opts.locked ?? false,
    changes: changes.map(([fromStatus, toStatus, when]) => ({
      fromStatus,
      toStatus,
      changedAt: at(when),
    })),
  };
}

describe('runningOn — a cycle runs from its goods paid for until it is settled', () => {
  const c = cycle([
    [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
    ['PURCHASING', 'PREPARING', '2026-11-03T10:00:00Z'],
    ['PREPARING', 'IN_TRANSIT', '2026-11-05T10:00:00Z'],
    ['IN_TRANSIT', 'SELLING', '2026-11-10T10:00:00Z'],
    ['SELLING', 'SETTLEMENT', '2026-11-20T10:00:00Z'],
  ]);

  it.each([
    ['2026-11-02', false], // still buying
    ['2026-11-03', true], // paid at noon: running that day
    ['2026-11-07', true], // in transit
    ['2026-11-15', true], // selling
    ['2026-11-20', true], // approved that day: it ran part of it
    ['2026-11-21', false], // being settled
  ])('%s → %s', (day, expected) => {
    expect(runningOn(c, day)).toBe(expected);
  });

  it('Planning, Funding, Purchasing are not running; nor Settlement, Closed, Cancelled', () => {
    for (const status of [
      'PLANNING',
      'FUNDING',
      'PURCHASING',
      'SETTLEMENT',
      'CLOSED',
      'CANCELLED',
    ]) {
      expect(
        runningOn(
          cycle([[null, status, '2026-11-01T08:00:00Z']]),
          '2026-11-02',
        ),
      ).toBe(false);
    }
    for (const status of [
      'PREPARING',
      'IN_TRANSIT',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
      'ARRIVED_EGYPT',
      'VERIFICATION',
      'SELLING',
    ]) {
      expect(
        runningOn(
          cycle([[null, status, '2026-11-01T08:00:00Z']]),
          '2026-11-02',
        ),
      ).toBe(true);
    }
  });

  it('a stretch ending exactly at Cairo midnight does not reach into the next day', () => {
    // 22:00 UTC on 4 Nov is 00:00 on 5 Nov in Cairo (UTC+2).
    const c2 = cycle([
      [null, 'PREPARING', '2026-11-01T08:00:00Z'],
      ['PREPARING', 'PURCHASING', '2026-11-04T22:00:00Z'],
    ]);
    expect(runningOn(c2, '2026-11-04')).toBe(true);
    expect(runningOn(c2, '2026-11-05')).toBe(false);
    // One millisecond later, it ran a moment of the 5th.
    const c3 = cycle([
      [null, 'PREPARING', '2026-11-01T08:00:00Z'],
      ['PREPARING', 'PURCHASING', '2026-11-04T22:00:00.001Z'],
    ]);
    expect(runningOn(c3, '2026-11-05')).toBe(true);
  });

  it('the day is Cairo’s, not UTC’s: 23:30 UTC on the 9th is the 10th in Cairo', () => {
    const c2 = cycle([
      [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
      ['PURCHASING', 'PREPARING', '2026-11-09T23:30:00Z'],
    ]);
    expect(runningOn(c2, '2026-11-09')).toBe(false);
    expect(runningOn(c2, '2026-11-10')).toBe(true);
    expect(runningEntries(c2).map((e) => e.day)).toEqual(['2026-11-10']);
  });

  it('summer time: 21:30 UTC on 15 July is already the 16th in Cairo (UTC+3)', () => {
    const c2 = cycle([
      [null, 'PURCHASING', '2026-07-01T08:00:00Z'],
      ['PURCHASING', 'PREPARING', '2026-07-15T21:30:00Z'],
    ]);
    expect(runningOn(c2, '2026-07-15')).toBe(false);
    expect(runningOn(c2, '2026-07-16')).toBe(true);
  });

  it('back and forth: Preparing, back to Purchasing, Preparing again — a gap in between', () => {
    const c2 = cycle([
      [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
      ['PURCHASING', 'PREPARING', '2026-11-03T08:00:00Z'],
      ['PREPARING', 'PURCHASING', '2026-11-04T08:00:00Z'],
      ['PURCHASING', 'PREPARING', '2026-11-08T08:00:00Z'],
    ]);
    expect(
      [
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
        '2026-11-07',
        '2026-11-08',
      ].map((d) => runningOn(c2, d)),
    ).toEqual([true, true, false, false, true]);
    expect(runningEntries(c2).map((e) => e.day)).toEqual([
      '2026-11-03',
      '2026-11-08',
    ]);
  });

  it('a status held for no time at all is passed through, not run', () => {
    const t = '2026-11-03T08:00:00Z';
    const c2 = cycle([
      [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
      ['PURCHASING', 'PREPARING', t],
      ['PREPARING', 'CANCELLED', t],
    ]);
    expect(runningOn(c2, '2026-11-03')).toBe(false);
    expect(runningEntries(c2)).toEqual([]);
  });

  it('walking through several running statuses at one instant is one entry, not three', () => {
    const t = '2026-11-03T08:00:00Z';
    const c2 = cycle([
      [null, 'ARRIVED_EGYPT', '2026-11-01T08:00:00Z'],
      ['ARRIVED_EGYPT', 'VERIFICATION', t],
      ['VERIFICATION', 'SELLING', t],
    ]);
    expect(runningEntries(c2).map((e) => e.day)).toEqual(['2026-11-01']);
    expect(runningOn(c2, '2026-11-03')).toBe(true);
  });

  it('no history recorded: its status now, since it was created', () => {
    const c2 = cycle([], {
      status: 'SELLING',
      createdAt: '2026-11-05T08:00:00Z',
    });
    expect(runningOn(c2, '2026-11-04')).toBe(false);
    expect(runningOn(c2, '2026-11-05')).toBe(true);
    expect(runningOn(c2, '2026-12-31')).toBe(true);
  });

  it('history that starts after it was created: before the first change, the status it left', () => {
    // Created on the 1st; the record begins with Preparing → In transit on the 5th.
    const c2 = cycle([['PREPARING', 'IN_TRANSIT', '2026-11-05T08:00:00Z']], {
      createdAt: '2026-11-01T08:00:00Z',
    });
    expect(runningOn(c2, '2026-11-02')).toBe(true);
    expect(runningEntries(c2).map((e) => e.day)).toEqual(['2026-11-01']);
  });
});

describe('cyclesForCost — who bears a cost dated on a day', () => {
  it('the cycles running that day, in the order they were paid for', () => {
    const late = cycle([[null, 'PREPARING', '2026-11-05T08:00:00Z']], {
      id: 'late',
    });
    const early = cycle([[null, 'SELLING', '2026-10-01T08:00:00Z']], {
      id: 'early',
    });
    const notYet = cycle([[null, 'PURCHASING', '2026-10-01T08:00:00Z']], {
      id: 'notyet',
    });
    expect(cyclesForCost('2026-11-06', [late, notYet, early])).toEqual([
      'early',
      'late',
    ]);
    expect(cyclesForCost('2026-11-04', [late, notYet, early])).toEqual([
      'early',
    ]);
  });

  it('a settled cycle takes nothing more, even for a day it ran', () => {
    const settled = cycle([[null, 'SELLING', '2026-10-01T08:00:00Z']], {
      id: 'settled',
      locked: true,
    });
    const other = cycle([[null, 'IN_TRANSIT', '2026-10-01T08:00:00Z']], {
      id: 'other',
    });
    expect(cyclesForCost('2026-10-10', [settled, other])).toEqual(['other']);
  });

  it('none running that day: the next cycle whose goods were paid for after it', () => {
    const a = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-12T08:00:00Z'],
      ],
      { id: 'a' },
    );
    const b = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-20T08:00:00Z'],
      ],
      { id: 'b' },
    );
    expect(cyclesForCost('2026-11-05', [b, a])).toEqual(['a']);
  });

  it('two paid for on the same next day share it', () => {
    const a = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-12T08:00:00Z'],
      ],
      { id: 'a' },
    );
    const b = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-12T15:00:00Z'],
      ],
      { id: 'b' },
    );
    expect(cyclesForCost('2026-11-05', [b, a])).toEqual(['a', 'b']);
  });

  it('the next one paid for is settled already: the one after it', () => {
    const a = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-12T08:00:00Z'],
      ],
      { id: 'a', locked: true },
    );
    const b = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-20T08:00:00Z'],
      ],
      { id: 'b' },
    );
    expect(cyclesForCost('2026-11-05', [a, b])).toEqual(['b']);
  });

  it('only settled cycles ran that day and nothing came after: it waits', () => {
    const a = cycle([[null, 'SELLING', '2026-10-01T08:00:00Z']], {
      locked: true,
    });
    expect(cyclesForCost('2026-10-10', [a])).toEqual([]);
    expect(cyclesForCost('2026-10-10', [])).toEqual([]);
  });

  it('a cycle that ran that day and was cancelled since bears nothing', () => {
    const c = cycle(
      [
        [null, 'PREPARING', '2026-11-01T08:00:00Z'],
        ['PREPARING', 'CANCELLED', '2026-11-08T08:00:00Z'],
      ],
      { locked: true },
    );
    expect(cyclesForCost('2026-11-03', [c])).toEqual([]);
  });

  it('a cost dated before every cycle goes to the first one paid for', () => {
    const a = cycle([[null, 'PREPARING', '2026-11-12T08:00:00Z']], { id: 'a' });
    expect(cyclesForCost('2025-01-01', [a])).toEqual(['a']);
  });

  it('a cycle paid for the day after counts as next, not as that day’s', () => {
    const a = cycle(
      [
        [null, 'PURCHASING', '2026-11-01T08:00:00Z'],
        ['PURCHASING', 'PREPARING', '2026-11-06T08:00:00Z'],
      ],
      { id: 'a' },
    );
    const b = cycle([[null, 'SELLING', '2026-10-01T08:00:00Z']], { id: 'b' });
    expect(cyclesForCost('2026-11-05', [a, b])).toEqual(['b']);
    expect(cyclesForCost('2026-11-06', [a, b])).toEqual(['b', 'a']);
  });

  it('ties in when they were paid for break by when they were created, then by id — never by list order', () => {
    const t = '2026-11-01T08:00:00Z';
    const x = cycle([[null, 'SELLING', t]], { id: 'x' });
    const y = cycle([[null, 'SELLING', t]], { id: 'y' });
    expect(cyclesForCost('2026-11-02', [y, x])).toEqual(['x', 'y']);
    expect(cyclesForCost('2026-11-02', [x, y])).toEqual(['x', 'y']);
  });
});

describe('equalParts — to the piastre, the odd one last, never lost', () => {
  it.each([
    ['1000', 2, ['500.00', '500.00']],
    ['100.01', 2, ['50.00', '50.01']],
    ['100', 3, ['33.33', '33.33', '33.34']],
    ['0.01', 2, ['0.00', '0.01']],
    ['0.02', 3, ['0.00', '0.00', '0.02']],
    ['700', 7, Array(7).fill('100.00')],
  ])('%s over %i', (amount, k, parts) => {
    const out = equalParts(new Prisma.Decimal(amount), k);
    expect(out.map((p) => p.toFixed(2))).toEqual(parts);
    expect(
      out.reduce((s, p) => s.add(p), new Prisma.Decimal(0)).toFixed(2),
    ).toBe(new Prisma.Decimal(amount).toFixed(2));
  });
  it('nobody: no parts', () => {
    expect(equalParts(new Prisma.Decimal(5), 0)).toEqual([]);
  });
});
