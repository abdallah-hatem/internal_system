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
  businessDay,
  businessToday,
  chosenDay,
  endOfBusinessDay,
  instantOfDay,
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
    expect(() =>
      assertNotFuture('2026-08-23', 'PAYMENT_RECEIVED'),
    ).not.toThrow();
  });

  it('still refuses a genuinely future day', () => {
    freezeAt('2026-08-22T21:37:00Z');
    expect(() => assertNotFuture('2026-08-24', 'PAYMENT_RECEIVED')).toThrow(
      /future/i,
    );
  });

  it('accepts yesterday and today', () => {
    freezeAt('2026-08-22T09:00:00Z');
    expect(() =>
      assertNotFuture('2026-08-21', 'PAYMENT_RECEIVED'),
    ).not.toThrow();
    expect(() =>
      assertNotFuture('2026-08-22', 'PAYMENT_RECEIVED'),
    ).not.toThrow();
  });

  it('ignores an absent value rather than guessing one', () => {
    expect(() => assertNotFuture(undefined, 'PAYMENT_RECEIVED')).not.toThrow();
    expect(() => assertNotFuture(null, 'PAYMENT_RECEIVED')).not.toThrow();
  });

  it('leaves malformed input to the DTO', () => {
    expect(() =>
      assertNotFuture('not-a-date', 'PAYMENT_RECEIVED'),
    ).not.toThrow();
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

describe('a record dated a chosen day (§4 and §3, 2026-10-16)', () => {
  const DAY_MS = 86_400_000;
  const everyDay = (fn: (day: string) => void) => {
    for (
      let t = Date.UTC(2024, 0, 1);
      t <= Date.UTC(2027, 11, 31);
      t += DAY_MS
    ) {
      fn(new Date(t).toISOString().slice(0, 10));
    }
  };

  it('instantOfDay lands inside the chosen day in Cairo, and on the same UTC date — every day of four years', () => {
    const now = new Date('2028-06-01T10:00:00Z');
    const wrong: string[] = [];
    everyDay((day) => {
      const at = instantOfDay(day, now);
      if (businessDay(at) !== day || at.toISOString().slice(0, 10) !== day) {
        wrong.push(`${day} → ${at.toISOString()}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it('instantOfDay of today is now, to the millisecond — today keeps its own order', () => {
    const now = new Date('2026-08-22T21:37:00Z'); // the 23rd in Cairo
    expect(instantOfDay('2026-08-23', now)).toBe(now);
  });

  it('endOfBusinessDay is the first instant of the next day in Cairo — every day of four years', () => {
    const wrong: string[] = [];
    everyDay((day) => {
      const end = endOfBusinessDay(day);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS)
        .toISOString()
        .slice(0, 10);
      if (
        businessDay(new Date(end.getTime() - 1)) !== day ||
        businessDay(end) !== next
      ) {
        wrong.push(day);
      }
    });
    expect(wrong).toEqual([]);
  });

  it('chosenDay: left out is today; today and the past are kept; the future and non-dates are refused with codes', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { getResponse(): { code: string } }).getResponse().code;
      }
      return 'accepted';
    };
    const tomorrow = new Date(
      Date.parse(`${businessToday()}T00:00:00Z`) + DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    expect(chosenDay(undefined, 'SALE_MADE')).toBe(businessToday());
    expect(chosenDay('', 'SALE_MADE')).toBe(businessToday());
    expect(chosenDay(null, 'SALE_MADE')).toBe(businessToday());
    expect(chosenDay('2026-01-31', 'SALE_MADE')).toBe('2026-01-31');
    expect(code(() => chosenDay(tomorrow, 'SALE_MADE'))).toBe('DATE_IN_FUTURE');
    expect(code(() => chosenDay('2026-02-29', 'SALE_MADE'))).toBe('BAD_DATE');
    expect(code(() => chosenDay('2026-1-5', 'SALE_MADE'))).toBe('BAD_DATE');
    expect(code(() => chosenDay(42, 'STOCK_RECEIVED'))).toBe('BAD_DATE');
    expect(code(() => chosenDay({}, 'STOCK_RECEIVED'))).toBe('BAD_DATE');
  });
});
