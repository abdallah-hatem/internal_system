/**
 * "Today" has to mean today where the business is.
 *
 * The bug these pin down: at 00:37 on the 23rd in Cairo it is still the 22nd
 * in UTC. A payment entered at that moment was judged against the UTC day and
 * refused as being in the future — on a machine in Cairo it was fine, and it
 * would have broken the moment this ran on a UTC server.
 */
import { assertNotFuture, businessToday } from './dates';

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
