import { describe, expect, it } from 'vitest';
import { formatAmount, formatMoney, formatNumber, intlFor, parseDisplayedMoney } from './numbers';
import { formatDate } from './dates';

/**
 * Finding #14: Arabic screens use Latin digits everywhere. `Money` printed
 * "٥٢٩٫٢٣- EGP" beside a date reading "19 أغسطس 2026" — two digit systems on
 * one screen, and a minus on the wrong side.
 */
const ARABIC_INDIC = /[٠-٩۰-۹٫٬]/;
const BIDI_MARK = /[‎‏؜]/;

describe('formatNumber', () => {
  it('Arabic uses Latin digits and the same separators as English', () => {
    for (const v of [0, 7, 1284, 1250000.5, -529.23]) {
      const ar = formatNumber(v, { locale: 'ar', maximumFractionDigits: 2 });
      expect(ar).not.toMatch(ARABIC_INDIC);
      expect(ar).toBe(formatNumber(v, { locale: 'en', maximumFractionDigits: 2 }));
    }
    expect(formatNumber(1250000.5, { locale: 'ar', maximumFractionDigits: 2 })).toBe('1,250,000.5');
  });

  it('a negative reads with the minus directly before the digits, no hidden marks', () => {
    for (const locale of ['en', 'ar']) {
      const out = formatAmount(-529.23, locale);
      expect(out).toBe('-529.23');
      expect(out).not.toMatch(BIDI_MARK);
    }
    // Large negatives keep the sign at the start, not after the last group.
    expect(formatAmount(-1234567.891, 'ar')).toBe('-1,234,567.89');
  });

  it('zero, tiny, huge and nonsense', () => {
    expect(formatAmount(0, 'ar')).toBe('0.00');
    expect(formatAmount(-0.004, 'ar')).toBe('-0.00');
    expect(formatAmount('12.5', 'ar')).toBe('12.50');
    expect(formatAmount(null, 'ar')).toBe('0.00');
    expect(formatAmount(Number.NaN, 'ar')).toBe('—');
    expect(formatAmount(Number.POSITIVE_INFINITY, 'ar')).toBe('—');
    expect(formatAmount('abc', 'ar')).toBe('—');
    expect(formatAmount(1e15, 'ar')).toBe('1,000,000,000,000,000.00');
  });
});

describe('formatMoney', () => {
  it('number first, currency after, in both languages', () => {
    expect(formatMoney(-529.23, { locale: 'ar' })).toBe('-529.23 EGP');
    expect(formatMoney(-529.23, { locale: 'en' })).toBe('-529.23 EGP');
    expect(formatMoney(10, { locale: 'ar', currency: 'USD' })).toBe('10.00 USD');
  });

  it('a value that is not a number shows a dash, never "NaN EGP"', () => {
    expect(formatMoney('x', { locale: 'ar' })).toBe('—');
  });
});

describe('one definition of the Arabic locale (rule 11)', () => {
  it('dates and numbers use the same Intl locale', () => {
    expect(intlFor('ar')).toEqual({ tag: 'ar-EG', numberingSystem: 'latn' });
    const date = formatDate('2026-08-19T12:00:00.000Z', { locale: 'ar' });
    expect(date).not.toMatch(ARABIC_INDIC);
  });
});

describe('parseDisplayedMoney', () => {
  it('reads back figures formatted either way', () => {
    expect(parseDisplayedMoney('1,234.50 EGP')).toEqual({ value: 1234.5, currency: 'EGP' });
    expect(parseDisplayedMoney('؜-٥٢٩٫٢٣ EGP')).toEqual({ value: -529.23, currency: 'EGP' });
    expect(parseDisplayedMoney('١٬٢٣٤٫٠٠ EGP')).toEqual({ value: 1234, currency: 'EGP' });
    expect(parseDisplayedMoney('EGP 10')).toEqual({ value: 10, currency: 'EGP' });
    expect(parseDisplayedMoney('529.23- EGP')).toEqual({ value: -529.23, currency: 'EGP' });
    expect(parseDisplayedMoney('12')).toEqual({ value: 12, currency: null });
  });

  it('refuses text that is not one figure, so it is shown untouched', () => {
    for (const text of ['', '—', 'n/a', '12 x 4', '1.2.3', 'EGP 5 USD', '--5', '-5-', '10%']) {
      expect(parseDisplayedMoney(text)).toBeNull();
    }
  });
});
