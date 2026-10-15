/**
 * Content loads are skeletons, not a spinner and the word "Loading" (owner,
 * 2026-10-15): "loading a table is just a loader with Loading text, it needs
 * to be a table skeleton as said in the skill."
 *
 * Every list and detail screen used to render
 *
 *     <Loader2 className="animate-spin" /> {tc('loading')}
 *
 * in place of its rows. They render a skeleton traced from the real rows now
 * (components/ui/skeleton.tsx). This reads every TSX source under src/ and
 * fails when the old pattern comes back:
 *
 *   - the translated "Loading" text (`tc('loading')`, `t('loading')`,
 *     `tCommon('loading')`, `t('common.loading')`) rendered anywhere but
 *     inside a button, or
 *   - a spinning `<Loader2>` anywhere but inside a button.
 *
 * A spinner inside a button that is mid-submit is the one place a spinner
 * belongs — that is an action's busy state, not content — so `<button>` and
 * `<Button>` bodies are allowed. So is the skeleton module itself, which says
 * "Loading" once to a screen reader and nothing on screen.
 *
 * Run with `npm run test:unit`. Set SPIN_SCAN_ROOT to scan another checkout's
 * src/ (how this was shown to fail on the code before the conversion).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SPIN_SCAN_ROOT ?? join(HERE, '../src');

/**
 * Files allowed to say "Loading":
 *   - the skeleton's own screen-reader line;
 *   - the date filter's busy sign. It is not content standing in for rows:
 *     the list under it keeps the previous range's rows on screen, dimmed,
 *     while the new range loads (I2), and this small line beside the filter
 *     says a refresh is under way — the status line the skill asks for, not
 *     a placeholder.
 */
const EXEMPT_FILES = new Set([
  ['components', 'ui', 'skeleton.tsx'].join(sep),
  ['components', 'ui', 'date-range-filter.tsx'].join(sep),
]);

const LOADING_TEXT = /\b(?:tc|t|tCommon|tc2)\(\s*['"](?:common\.)?loading['"]\s*\)/g;
const SPINNER = /<Loader2\b[^>]*animate-spin/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip comments so a sentence about the old pattern is not the pattern. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Where the opening tag starting at `start` ends: the first `>` outside braces and quotes. */
function openingTagEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return i;
  }
  return src.length;
}

/**
 * Is `index` inside a button — its body, or its own attributes? Buttons do
 * not nest, so it is enough that the last button opened before `index` has
 * not been closed yet, and is not a self-closing `<Button … />`.
 */
function insideButton(src, index) {
  const before = src.slice(0, index);
  const open = Math.max(before.lastIndexOf('<button'), before.lastIndexOf('<Button'));
  if (open === -1) return false;
  const close = Math.max(before.lastIndexOf('</button>'), before.lastIndexOf('</Button>'));
  if (close > open) return false;
  const end = openingTagEnd(src, open);
  if (end > index) return true; // in the tag's own attributes
  return src[end - 1] !== '/';
}

function offences(file) {
  const src = withoutComments(readFileSync(file, 'utf8'));
  const out = [];
  for (const [what, re] of [['"Loading" text', LOADING_TEXT], ['a spinning Loader2', SPINNER]]) {
    for (const m of src.matchAll(re)) {
      if (insideButton(src, m.index)) continue;
      out.push({ what, line: src.slice(0, m.index).split('\n').length });
    }
  }
  return out;
}

test('no screen shows a spinner and "Loading" where its content will be', () => {
  const found = [];
  let files = 0;
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    if (EXEMPT_FILES.has(rel)) continue;
    files += 1;
    for (const o of offences(file)) found.push(`${rel}:${o.line} ${o.what} outside a button`);
  }
  assert.ok(files > 50, `only ${files} files scanned — is the scan pointed at src/?`);
  assert.deepEqual(found, []);
});

test('the scanner tells a busy button from a loading screen', () => {
  // The two shapes it must tell apart, so a change to it cannot quietly pass both.
  const page = `<div className="py-12"><Loader2 className="h-5 w-5 animate-spin" /> {tc('loading')}</div>`;
  const button = `<button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? tc('loading') : tc('save')}</button>`;
  const shadcn = `<Button disabled={busy}><Loader2 className="animate-spin" /> {t('loading')}</Button>`;
  const srcOf = (s) => withoutComments(s);
  const hits = (s) =>
    [LOADING_TEXT, SPINNER].flatMap((re) => [...srcOf(s).matchAll(re)].filter((m) => !insideButton(srcOf(s), m.index)));
  assert.equal(hits(page).length, 2);
  assert.equal(hits(button).length, 0);
  assert.equal(hits(shadcn).length, 0);
});
