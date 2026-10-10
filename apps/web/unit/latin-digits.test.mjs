/**
 * Arabic screens use Latin digits everywhere (decision log, "Arabic uses Latin
 * digits everywhere", 2026-10-10). One number formatter makes that true:
 * `formatNumber` / `formatMoney` / `useNumberFormat` in `lib/numbers.ts`, and
 * `Money` on top of them. A page that calls `toLocaleString()` itself follows
 * the browser instead — an Arabic browser prints "٣٠" beside a date that says
 * "30" — and nothing looks broken in English (UF7).
 *
 * This fails when:
 *   - a `.tsx` under src/ calls `toLocaleString(` or builds an `Intl.NumberFormat`
 *     (only `lib/numbers.ts` and `lib/dates.ts` may), or
 *   - a locale string holds an Arabic-Indic digit (٠-٩ or ۰-۹).
 *
 * Tests are exempt: they may build an expected value however they like.
 *
 * Run with `npm run test:unit`. Set UF7_SCAN_ROOT to scan another checkout's
 * src/ (how this was shown to fail on the code before the sweep).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.UF7_SCAN_ROOT ?? join(HERE, '../src');

/** The two files that own turning numbers and dates into text. */
const OWNERS = new Set(['lib/numbers.ts', 'lib/dates.ts']);

const RAW_FORMATTING = [
  { name: 'toLocaleString(', re: /\.toLocaleString\(/g },
  { name: 'Intl.NumberFormat', re: /\bIntl\.NumberFormat\b/g },
];

const ARABIC_INDIC = /[٠-٩۰-۹]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const isTest = (path) => /\.test\.[jt]sx?$/.test(path);

test('no component formats a number itself — it goes through lib/numbers.ts', () => {
  const offenders = [];
  for (const path of walk(ROOT)) {
    const rel = relative(ROOT, path).split('\\').join('/');
    if (!rel.endsWith('.tsx') || isTest(rel) || OWNERS.has(rel)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const rule of RAW_FORMATTING) {
        rule.re.lastIndex = 0;
        if (rule.re.test(line)) offenders.push(`${rel}:${i + 1}  ${rule.name}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `Format numbers with useNumberFormat() or <Money> from lib/numbers.ts:\n${offenders.join('\n')}`,
  );
});

test('no locale string carries an Arabic-Indic digit', () => {
  const offenders = [];
  const visit = (file, node, path) => {
    if (typeof node === 'string') {
      if (ARABIC_INDIC.test(node)) offenders.push(`${file} ${path}: ${node}`);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) visit(file, value, path ? `${path}.${key}` : key);
    }
  };
  const localeDir = join(ROOT, 'i18n/locales');
  const files = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2, `expected the locale files in ${localeDir}`);
  for (const file of files) visit(file, JSON.parse(readFileSync(join(localeDir, file), 'utf8')), '');
  assert.deepEqual(offenders, [], `Write digits in Latin, even in Arabic strings:\n${offenders.join('\n')}`);
});

test('the scan reaches the pages and components it guards', () => {
  const files = walk(ROOT).map((p) => relative(ROOT, p).split('\\').join('/'));
  assert.ok(files.some((f) => f.startsWith('app/[locale]/') && f.endsWith('.tsx')), 'no pages scanned');
  assert.ok(files.some((f) => f.startsWith('components/') && f.endsWith('.tsx')), 'no components scanned');
});
