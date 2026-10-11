/**
 * Amounts and quantities typed into a form field sit at the start of the field
 * like every other field — left in English, right in Arabic (owner,
 * 2026-10-11: Record payment showed "90,000.00" at the right edge in English).
 * Figures in tables and summaries stay end-aligned; this is only about inputs.
 *
 * One rule does it: `input:is([inputmode=decimal], [inputmode=numeric],
 * [type=number]) { text-align: start }` in `app/globals.css`, outside any
 * `@layer`, so a utility class on the element cannot outrank it.
 *
 * This fails when:
 *   - that rule is missing, or has been moved inside an `@layer` (where
 *     `text-end` on the element would win again), or
 *   - a numeric `<input>` or a `<MoneyInput>` under src/ asks for `text-end` /
 *     `text-right` — overridden by the rule, but a reader would believe it.
 *
 * Run with `npm run test:unit`. Set ALIGN_SCAN_ROOT to scan another checkout's
 * src/ (how this was shown to fail on the code before the change).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ALIGN_SCAN_ROOT ?? join(HERE, '../src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Each `<input …/>` or `<MoneyInput …/>` element's source, with where it starts. */
function numericInputs(source) {
  const found = [];
  for (const m of source.matchAll(/<(MoneyInput|input)\b/g)) {
    const end = source.indexOf('/>', m.index);
    if (end < 0) continue;
    const element = source.slice(m.index, end);
    const numeric =
      m[1] === 'MoneyInput' || /inputMode="(decimal|numeric)"|type="number"/.test(element);
    if (numeric) found.push({ element, at: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

test('the start-alignment rule for numeric inputs is in globals.css, outside any @layer', () => {
  const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
  const rule = /input:is\(\[inputmode="decimal"\], \[inputmode="numeric"\], \[type="number"\]\) \{\s*text-align: start;\s*\}/;
  const at = css.search(rule);
  assert.ok(at >= 0, 'globals.css has no start-alignment rule for numeric inputs');
  // Unlayered: count the @layer blocks still open where the rule sits.
  let depth = 0;
  let layered = 0;
  const before = css.slice(0, at);
  for (const m of before.matchAll(/@layer[^{;]*\{|\{|\}/g)) {
    if (m[0].startsWith('@layer')) {
      depth += 1;
      layered += 1;
    } else if (m[0] === '{') depth += 1;
    else {
      depth -= 1;
    }
  }
  assert.equal(depth, 0, 'the rule sits inside a block (an @layer would let text-end win)');
  void layered;
});

test('no numeric input or MoneyInput asks to be end-aligned', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const { element, at } of numericInputs(source)) {
      if (/\btext-(end|right)\b/.test(element)) offenders.push(`${relative(ROOT, file)}:${at}`);
    }
  }
  // The shared quantity field class, used by every shipment dialog.
  const dialog = readFileSync(join(ROOT, 'components/shipment/ShipmentDialog.tsx'), 'utf8');
  const qty = /export const qtyInputClass =\s*'([^']*)'/.exec(dialog);
  if (qty && /\btext-(end|right)\b/.test(qty[1])) offenders.push('components/shipment/ShipmentDialog.tsx qtyInputClass');
  assert.deepEqual(offenders, []);
});
