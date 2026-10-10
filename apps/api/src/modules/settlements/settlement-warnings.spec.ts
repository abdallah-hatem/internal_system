import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec building Decimal inputs; no data access
import { Prisma } from '@prisma/client';

import {
  SETTLEMENT_WARNING_CODES,
  settlementWarnings,
} from './settlement-warnings';

const D = (v: string | number) => new Prisma.Decimal(v);

/** Two or more words in a row of letters — the shape of an English sentence. */
const SENTENCE = /[A-Za-z]+\s+[A-Za-z]+/;

function assertNoProse(value: unknown) {
  const text = JSON.stringify(value);
  // Strip the keys and codes we expect, then look for prose in what is left.
  const strings: string[] = [];
  JSON.parse(text, (_k, v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    return v;
  });
  for (const s of strings) expect(s).not.toMatch(SENTENCE);
}

describe('settlement warnings carry codes, not English (rule 9)', () => {
  it('stock still on the shelf → UNSOLD_STOCK with numbers, no sentence', () => {
    const w = settlementWarnings({
      fullySold: false,
      unitsRemaining: D('12.5'),
      unsoldValue: D('3456.789'),
      hasAllocations: true,
    });
    expect(w).toEqual([
      { code: 'UNSOLD_STOCK', params: { units: 12.5, valueEgp: 3456.79 } },
    ]);
    assertNoProse(w);
  });

  it('nothing sold yet → NO_REALISED_SALES, alongside the stock warning', () => {
    const w = settlementWarnings({
      fullySold: false,
      unitsRemaining: D(40),
      unsoldValue: D(9000),
      hasAllocations: false,
    });
    expect(w.map((x) => x.code)).toEqual(['UNSOLD_STOCK', 'NO_REALISED_SALES']);
    assertNoProse(w);
  });

  it('a fully sold cycle with sales warns about nothing', () => {
    expect(
      settlementWarnings({
        fullySold: true,
        unitsRemaining: D(0),
        unsoldValue: D(0),
        hasAllocations: true,
      }),
    ).toEqual([]);
  });

  it('a large figure stays a number, never a formatted string', () => {
    const [w] = settlementWarnings({
      fullySold: false,
      unitsRemaining: D(1284),
      unsoldValue: D('1250000.5'),
      hasAllocations: true,
    });
    expect(typeof w.params.units).toBe('number');
    expect(typeof w.params.valueEgp).toBe('number');
    expect(w.params.valueEgp).toBe(1250000.5);
  });

  it('every code is UPPER_SNAKE and every param value is a number', () => {
    for (const code of SETTLEMENT_WARNING_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
    }
    const all = settlementWarnings({
      fullySold: false,
      unitsRemaining: D(1),
      unsoldValue: D(1),
      hasAllocations: false,
    });
    for (const w of all) {
      expect(SETTLEMENT_WARNING_CODES).toContain(w.code);
      for (const v of Object.values(w.params)) expect(typeof v).toBe('number');
    }
  });

  it('the service builds its warnings here, and writes no sentence of its own', () => {
    const source = readFileSync(
      join(__dirname, 'settlements.service.ts'),
      'utf8',
    );
    expect(source).toContain('settlementWarnings(');
    expect(source).not.toMatch(/warnings\.push\(/);
  });
});
