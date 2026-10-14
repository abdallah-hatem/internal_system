/**
 * Which name a shop sees (BUSINESS_LOGIC §3, owner 2026-10-14): the Arabic on
 * /ar when there is one, the English otherwise, never blank. The same table
 * the office's `localized-name.test.ts` runs against the API's definition.
 *
 * Node loads the .ts file directly (type stripping, Node 23+).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localDescription, localName, otherName } from '../src/lib/localized-name.ts';

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
