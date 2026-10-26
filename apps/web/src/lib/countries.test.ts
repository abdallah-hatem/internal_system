import { describe, expect, it } from 'vitest';
import * as web from './countries';
// The server's own list — the one the API refuses from.
import * as server from '../../../api/src/common/countries';

/**
 * One list of countries, kept in two files (rule 11, §21 2026-10-16). The
 * picker offers from this copy and the server refuses from its own; drift
 * means a country on the form that ends in COUNTRY_UNKNOWN, or one the server
 * allows that nobody can pick.
 */
describe('the country codes', () => {
  it('are the codes the server enforces, in the same order', () => {
    expect([...web.COUNTRY_CODES]).toEqual([...server.COUNTRY_CODES]);
    expect([...web.PREFERRED_COUNTRIES]).toEqual([...server.PREFERRED_COUNTRIES]);
  });
});

describe('countryLabel — a stored country in the reader’s language', () => {
  it('a code → its name in English on /en and Arabic on /ar', () => {
    expect(web.countryLabel('CN', 'en')).toBe('China');
    expect(web.countryLabel('CN', 'ar')).toBe('الصين');
    expect(web.countryLabel('EG', 'ar')).toBe('مصر');
    expect(web.countryLabel('AE', 'en')).toBe('United Arab Emirates');
    expect(web.countryLabel('AE', 'ar')).toMatch(/^الإمارات/);
  });

  it('never the raw code, for any code on the list, in either language', () => {
    for (const locale of ['en', 'ar']) {
      for (const code of web.COUNTRY_CODES) {
        expect(web.countryLabel(code, locale), `${code} ${locale}`).not.toBe(code);
      }
    }
  });

  it('free text the migration could not read is shown as it was typed', () => {
    expect(web.countryLabel(' Narnia ', 'ar')).toBe('Narnia');
  });

  it('nothing stored → a dash, never blank', () => {
    for (const v of ['', '  ', null, undefined]) expect(web.countryLabel(v, 'en')).toBe('—');
  });
});

describe('countryOptions — what the picker offers', () => {
  it('the business’s countries first, then every other A–Z in the reader’s language', () => {
    const en = web.countryOptions('en');
    expect(en).toHaveLength(249);
    expect(en.slice(0, 5).map((o) => o.value)).toEqual(['CN', 'AE', 'EG', 'TR', 'IN']);
    const rest = en.slice(5).map((o) => o.label);
    expect(rest).toEqual([...rest].sort(new Intl.Collator('en').compare));
    expect(rest[0]).toBe('Afghanistan');

    const ar = web.countryOptions('ar');
    expect(ar[0]).toMatchObject({ value: 'CN', label: 'الصين' });
    const arRest = ar.slice(5).map((o) => o.label);
    expect(arRest).toEqual([...arRest].sort(new Intl.Collator('ar').compare));
  });

  it('each option is found by the other language’s name and by its code', () => {
    const egypt = web.countryOptions('en').find((o) => o.value === 'EG')!;
    expect(egypt.label).toBe('Egypt');
    expect(egypt.keywords).toContain('مصر');
    expect(egypt.keywords).toContain('EG');
    const china = web.countryOptions('ar').find((o) => o.value === 'CN')!;
    expect(china.keywords).toContain('China');
  });
});
