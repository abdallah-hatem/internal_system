import { describe, expect, it } from 'vitest';
import { localDescription, localName, matchesName, otherName } from './localized-name';
// The server's own file — the rule this copy must agree with.
import { displayDescription, displayName } from '../../../api/src/common/arabic-names';

/**
 * Which name a reader sees (BUSINESS_LOGIC §3, owner 2026-10-14), kept in two
 * files because Next cannot import across apps. Both run over the same table.
 */

type Row = [string, { name: string; nameAr?: string | null }, string, string];

const rows: Row[] = [
  ['Arabic reader, Arabic present', { name: 'Brake pads', nameAr: 'تيل فرامل' }, 'ar', 'تيل فرامل'],
  ['English reader, Arabic present', { name: 'Brake pads', nameAr: 'تيل فرامل' }, 'en', 'Brake pads'],
  ['Arabic reader, no Arabic → English', { name: 'Chain kit', nameAr: null }, 'ar', 'Chain kit'],
  ['Arabic reader, Arabic missing', { name: 'Chain kit' }, 'ar', 'Chain kit'],
  ['Arabic reader, Arabic blank → English, never blank', { name: 'Chain kit', nameAr: '  ' }, 'ar', 'Chain kit'],
  ['Arabic reader, Arabic padded → trimmed', { name: 'Helmets', nameAr: ' خوذ ' }, 'ar', 'خوذ'],
];

describe('localName — the office copy of the fallback', () => {
  it.each(rows)('%s', (_, record, locale, expected) => {
    expect(localName(record, locale)).toBe(expected);
  });

  it.each(rows)('agrees with the API: %s', (_, record, locale) => {
    expect(localName(record, locale)).toBe(displayName(record, locale));
  });

  it('nothing to name → empty, not a crash', () => {
    expect(localName(null, 'ar')).toBe('');
    expect(localName(undefined, 'en')).toBe('');
  });
});

describe('localDescription', () => {
  const cases: [{ description?: string | null; descriptionAr?: string | null }, string][] = [
    [{ description: 'Front pads', descriptionAr: 'تيل أمامي' }, 'ar'],
    [{ description: 'Front pads', descriptionAr: null }, 'ar'],
    [{ description: 'Front pads', descriptionAr: 'تيل أمامي' }, 'en'],
    [{ description: null, descriptionAr: '' }, 'ar'],
  ];
  it.each(cases)('agrees with the API (%o, %s)', (record, locale) => {
    expect(localDescription(record, locale)).toBe(displayDescription(record, locale) ?? '');
  });
  it('Arabic when present on /ar, English otherwise', () => {
    expect(localDescription(cases[0][0], 'ar')).toBe('تيل أمامي');
    expect(localDescription(cases[1][0], 'ar')).toBe('Front pads');
    expect(localDescription(cases[2][0], 'en')).toBe('Front pads');
  });
});

describe('otherName — the second line under a localized name', () => {
  it('on /ar, the English under the Arabic', () => {
    expect(otherName({ name: 'Brake pads', nameAr: 'تيل فرامل' }, 'ar')).toBe('Brake pads');
  });
  it('on /en, the Arabic under the English', () => {
    expect(otherName({ name: 'Brake pads', nameAr: 'تيل فرامل' }, 'en')).toBe('تيل فرامل');
  });
  it('no Arabic → nothing, so the English is not printed twice', () => {
    expect(otherName({ name: 'Chain kit', nameAr: null }, 'ar')).toBe('');
    expect(otherName({ name: 'Chain kit', nameAr: '' }, 'en')).toBe('');
  });
});

describe('matchesName — a search in either language, and the SKU', () => {
  const pads = { name: 'Brake pads', nameAr: 'تيل فرامل', sku: 'PRD-000012' };
  const chain = { name: 'Chain kit', nameAr: null, sku: 'PRD-000013' };

  it('"تيل" finds the brake pads by their Arabic name', () => {
    expect(matchesName(pads, 'تيل')).toBe(true);
    expect(matchesName(chain, 'تيل')).toBe(false);
  });
  it('the English name, ignoring case, and part of the SKU still match', () => {
    expect(matchesName(pads, 'BRAKE')).toBe(true);
    expect(matchesName(chain, '0013')).toBe(true);
    expect(matchesName(chain, 'prd-00001')).toBe(true);
  });
  it('an empty or blank search matches everything', () => {
    expect(matchesName(chain, '')).toBe(true);
    expect(matchesName(chain, '   ')).toBe(true);
  });
  it('surrounding space in the search is ignored', () => {
    expect(matchesName(pads, '  تيل ')).toBe(true);
  });
});
