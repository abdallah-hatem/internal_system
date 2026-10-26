import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arabicSearchKey,
  localDescription,
  localName,
  otherName,
  searchFinds,
} from './localized-name';
// The server's own file — the rule this copy must agree with.
import {
  arabicSearchKey as apiArabicSearchKey,
  displayDescription,
  displayName,
} from '../../../api/src/common/arabic-names';

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

/**
 * Arabic search forgives spelling (§3, owner 2026-10-15). This copy runs over
 * the API's own case table and against the API's own function, so the two
 * cannot drift: change the rule there and this fails until it is changed here.
 */
describe('arabicSearchKey — the office copy of the search rule', () => {
  const cases = JSON.parse(
    readFileSync(resolve(__dirname, '../../../api/src/common/arabic-search-cases.json'), 'utf8'),
  ) as { keys: [string, string][]; same: [string, string][]; different: [string, string][] };

  it.each(cases.keys)('%j → %j', (text, key) => {
    expect(arabicSearchKey(text)).toBe(key);
  });
  it.each(cases.keys)('agrees with the API on %j', (text) => {
    expect(arabicSearchKey(text)).toBe(apiArabicSearchKey(text));
  });
  it.each(cases.same)('%s finds %s, both ways', (a, b) => {
    expect(searchFinds(a, b)).toBe(true);
    expect(searchFinds(b, a)).toBe(true);
  });
  it.each(cases.different)('%s does NOT find %s', (a, b) => {
    expect(arabicSearchKey(a)).not.toBe(arabicSearchKey(b));
  });
  it('nothing → empty', () => {
    expect(arabicSearchKey(null)).toBe('');
    expect(arabicSearchKey(undefined)).toBe('');
  });
});
