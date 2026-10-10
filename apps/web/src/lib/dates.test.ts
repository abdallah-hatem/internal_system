import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessToday, formatDate, timeAgo } from './dates';

describe('formatDate', () => {
  it('English output is unchanged', () => {
    expect(formatDate('2026-08-19T12:00:00.000Z')).toBe('Aug 19, 2026');
    expect(formatDate('2026-08-19T12:00:00.000Z', { locale: 'en' })).toBe('Aug 19, 2026');
    expect(formatDate('2026-08-19T14:30:00.000Z', { includeTime: true, locale: 'en' })).toBe(
      'Aug 19, 2026, 2:30 PM',
    );
  });

  it('Arabic gets Arabic month names with Latin digits', () => {
    const out = formatDate('2026-08-19T12:00:00.000Z', { locale: 'ar' });
    expect(out).toContain('أغسطس');
    expect(out).toContain('19');
    expect(out).toContain('2026');
    expect(out).not.toMatch(/[A-Za-z]/);
    expect(out).not.toMatch(/[٠-٩]/); // no Arabic-Indic digits
  });

  it('Arabic with time reads as Arabic, not English', () => {
    const out = formatDate('2026-08-19T14:30:00.000Z', { includeTime: true, locale: 'ar' });
    expect(out).toContain('2:30');
    expect(out).not.toMatch(/PM|AM/);
  });

  it('missing or invalid input gives a dash in either language', () => {
    for (const locale of ['en', 'ar']) {
      expect(formatDate(null, { locale })).toBe('—');
      expect(formatDate(undefined, { locale })).toBe('—');
      expect(formatDate('not a date', { locale })).toBe('—');
    }
  });
});

describe('timeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('English keeps its compact form; Arabic reads in Arabic', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    expect(timeAgo('2026-10-10T11:55:00Z')).toBe('5m ago');
    const ar = timeAgo('2026-10-10T11:55:00Z', { locale: 'ar' });
    expect(ar).toContain('5');
    expect(ar).not.toMatch(/[A-Za-z]/);
  });

  it('a future timestamp is "just now", not a negative age', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    expect(timeAgo('2026-10-10T12:05:00Z')).toBe('just now');
    expect(timeAgo('2026-10-10T12:05:00Z', { locale: 'ar' })).not.toMatch(/[A-Za-z-]/);
  });
});

describe('businessToday', () => {
  it("is Cairo's calendar day either side of Cairo midnight", () => {
    expect(businessToday(new Date('2026-12-15T21:59:00Z'))).toBe('2026-12-15'); // 23:59 Cairo
    expect(businessToday(new Date('2026-12-15T22:00:00Z'))).toBe('2026-12-16'); // 00:00 Cairo
    expect(businessToday(new Date('2026-12-15T23:30:00Z'))).toBe('2026-12-16'); // 01:30 Cairo
  });
});
