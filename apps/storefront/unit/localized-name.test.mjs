/**
 * Which name a shop sees (BUSINESS_LOGIC §3, owner 2026-10-14): the Arabic on
 * /ar when there is one, the English otherwise, never blank. The same table
 * the office's `localized-name.test.ts` runs against the API's definition.
 *
 * Node loads the .ts file directly (type stripping, Node 23+).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  arabicSearchKey,
  localDescription,
  localName,
  otherName,
  searchFinds,
} from '../src/lib/localized-name.ts';

/**
 * The API's own table for the Arabic search rule (§3, owner 2026-10-15). The
 * API's `arabicSearchKey` passes it in jest; this copy must pass it too, so
 * the shop's search and the server's cannot drift.
 */
const cases = JSON.parse(
  readFileSync(new URL('../../api/src/common/arabic-search-cases.json', import.meta.url), 'utf8'),
);

for (const [text, key] of cases.keys) {
  test(`arabicSearchKey: ${JSON.stringify(text)} → ${JSON.stringify(key)}`, () => {
    assert.equal(arabicSearchKey(text), key);
  });
}
for (const [a, b] of cases.same) {
  test(`search: ${a} finds ${b}, both ways`, () => {
    assert.equal(searchFinds(a, b), true);
    assert.equal(searchFinds(b, a), true);
  });
}
for (const [a, b] of cases.different) {
  test(`search: ${a} does NOT find ${b}`, () => {
    assert.notEqual(arabicSearchKey(a), arabicSearchKey(b));
  });
}
test('arabicSearchKey: nothing → empty', () => {
  assert.equal(arabicSearchKey(null), '');
  assert.equal(arabicSearchKey(undefined), '');
});
test('a category picker: "فرامل" finds "فَرامِل", and "حوندا" does not find "هوندا"', () => {
  assert.equal(searchFinds('Brakes فَرامِل', 'فرامل'), true);
  assert.equal(searchFinds('Honda هوندا', 'حوندا'), false);
});

const rows = [
  ['Arabic reader, Arabic present', { name: 'Brake pads', nameAr: 'تيل فرامل' }, 'ar', 'تيل فرامل'],
  ['English reader, Arabic present', { name: 'Brake pads', nameAr: 'تيل فرامل' }, 'en', 'Brake pads'],
  ['Arabic reader, no Arabic → English', { name: 'Chain kit', nameAr: null }, 'ar', 'Chain kit'],
  ['Arabic reader, Arabic missing', { name: 'Chain kit' }, 'ar', 'Chain kit'],
  ['Arabic reader, Arabic blank → English, never blank', { name: 'Chain kit', nameAr: '   ' }, 'ar', 'Chain kit'],
  ['Arabic padded → trimmed', { name: 'Helmets', nameAr: ' خوذ ' }, 'ar', 'خوذ'],
];

for (const [label, record, locale, expected] of rows) {
  test(`localName: ${label}`, () => {
    assert.equal(localName(record, locale), expected);
  });
}

test('localName: nothing → empty, not a crash', () => {
  assert.equal(localName(null, 'ar'), '');
});

test('localDescription: Arabic on /ar when present, English otherwise, null when neither', () => {
  assert.equal(localDescription({ description: 'Front', descriptionAr: 'أمامي' }, 'ar'), 'أمامي');
  assert.equal(localDescription({ description: 'Front', descriptionAr: null }, 'ar'), 'Front');
  assert.equal(localDescription({ description: 'Front', descriptionAr: 'أمامي' }, 'en'), 'Front');
  assert.equal(localDescription({ description: '', descriptionAr: ' ' }, 'ar'), null);
});

test('otherName: the name a filter also matches, never the shown one twice', () => {
  assert.equal(otherName({ name: 'Brake pads', nameAr: 'تيل فرامل' }, 'ar'), 'Brake pads');
  assert.equal(otherName({ name: 'Brake pads', nameAr: 'تيل فرامل' }, 'en'), 'تيل فرامل');
  assert.equal(otherName({ name: 'Chain kit', nameAr: null }, 'ar'), '');
});
