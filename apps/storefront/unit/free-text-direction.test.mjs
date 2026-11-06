/**
 * A product's description is typed by the office in either language, and on
 * /ar the English one shows when there is no Arabic. Laid out in the page's
 * right-to-left direction, its full stop jumped to the front (".speakers for
 * V6 / M2"; UI audit 2026-11, M5). The paragraph reads its direction from its
 * own text, and the name is isolated from the Arabic around it.
 *
 * There is no DOM test runner in the store, and what decides the layout is the
 * markup's `dir` and isolation, so this reads the source.
 *
 * Run with `npm run test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../src/components/catalogue/product-detail.tsx', import.meta.url),
  'utf8',
);

/** The opening tag of the element whose child (not prop) is `{expr}`. */
function tagAround(expr) {
  const escaped = expr.replace(/[(){}]/g, (c) => `\\${c}`);
  const at = src.search(new RegExp(`>\\s*\\{${escaped}\\}`));
  assert.notEqual(at, -1, `product-detail renders {${expr}} as a child`);
  const open = src.lastIndexOf('<', at + 1);
  return src.slice(open, src.indexOf('>', open) + 1);
}

test('the description paragraph takes its direction from its text', () => {
  const tag = tagAround('localDescription(data, locale)');
  assert.match(tag, /^<p\b/);
  assert.match(tag, /\bdir="auto"/);
});

test('the product name is isolated from the line around it', () => {
  assert.match(tagAround('localName(data, locale)'), /^<bdi\b/);
});
