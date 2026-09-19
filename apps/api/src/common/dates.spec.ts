/**
 * "Today" has to mean today where the business is.
 *
 * The bug these pin down: at 00:37 on the 23rd in Cairo it is still the 22nd
 * in UTC. A payment entered at that moment was judged against the UTC day and
 * refused as being in the future — on a machine in Cairo it was fine, and it
 * would have broken the moment this ran on a UTC server.
 */
import {
  assertDayRange,
  assertNotFuture,
  businessToday,
  calendarRange,
  instantRange,
  startOfBusinessDay,
} from './dates';

const CAIRO_EARLY_23RD = new Date('2026-08-22T21:37:00Z'); // 00:37 on the 23rd, Cairo

describe('businessToday', () => {
  it('reads the day in Cairo, not UTC', () => {
    expect(businessToday(CAIRO_EARLY_23RD)).toBe('2026-08-23');
    // The same instant is still the previous day in UTC, which is the trap.
    expect(CAIRO_EARLY_23RD.toISOString().slice(0, 10)).toBe('2026-08-22');
  });

  it('agrees with UTC during the rest of the day', () => {
    const midday = new Date('2026-08-22T09:00:00Z');
    expect(businessToday(midday)).toBe('2026-08-22');
  });
});

describe('assertNotFuture', () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
    jest.useRealTimers();
  });

  const freezeAt = (iso: string) => {
    jest.useFakeTimers().setSystemTime(new Date(iso));
  };

  it('accepts a date entered just after midnight in Cairo', () => {
    freezeAt('2026-08-22T21:37:00Z'); // 00:37 on the 23rd, Cairo
    expect(() => assertNotFuture('2026-08-23', 'A payment')).not.toThrow();
  });

  it('still refuses a genuinely future day', () => {
    freezeAt('2026-08-22T21:37:00Z');
    expect(() => assertNotFuture('2026-08-24', 'A payment')).toThrow(/future/i);
  });

  it('accepts yesterday and today', () => {
    freezeAt('2026-08-22T09:00:00Z');
    expect(() => assertNotFuture('2026-08-21', 'A payment')).not.toThrow();
    expect(() => assertNotFuture('2026-08-22', 'A payment')).not.toThrow();
  });

  it('ignores an absent value rather than guessing one', () => {
    expect(() => assertNotFuture(undefined, 'A payment')).not.toThrow();
    expect(() => assertNotFuture(null, 'A payment')).not.toThrow();
  });

  it('leaves malformed input to the DTO', () => {
    expect(() => assertNotFuture('not-a-date', 'A payment')).not.toThrow();
  });
});

describe('day ranges', () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { getResponse(): { code: string } }).getResponse().code;
    }
    return null;
  };

  it('refuses a range that ends before it starts', () => {
    expect(codeOf(() => assertDayRange('2026-09-10', '2026-09-01'))).toBe(
      'DATE_RANGE_REVERSED',
    );
    expect(codeOf(() => assertDayRange('2026-09-01', '2026-09-01'))).toBeNull();
    expect(codeOf(() => assertDayRange('2026-09-01', undefined))).toBeNull();
  });

  it('refuses a day that does not exist, rather than letting Postgres choke on it', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-9-1',
      'today',
      '2026-09-01T00:00:00Z',
    ]) {
      expect(codeOf(() => assertDayRange(bad))).toBe('BAD_DATE');
    }
  });

  it('starts a Cairo day at its own midnight, summer and winter', () => {
    // Egypt keeps daylight saving: UTC+3 in August, UTC+2 in January.
    expect(startOfBusinessDay('2026-08-01').toISOString()).toBe(
      '2026-07-31T21:00:00.000Z',
    );
    expect(startOfBusinessDay('2026-01-15').toISOString()).toBe(
      '2026-01-14T22:00:00.000Z',
    );
  });

  it('a timestamp range runs to the start of the day after `to`', () => {
    expect(instantRange('2026-08-01', '2026-08-01')).toEqual({
      gte: new Date('2026-07-31T21:00:00.000Z'),
      lt: new Date('2026-08-01T21:00:00.000Z'),
    });
    expect(instantRange()).toBeUndefined();
  });

  it('a date-column range compares the days themselves, both included', () => {
    expect(calendarRange('2026-08-01', '2026-08-31')).toEqual({
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lte: new Date('2026-08-31T00:00:00.000Z'),
    });
  });
});
