/**
 * No field looks empty (owner, 2026-10-14): "Any input field can't look empty.
 * It must have a placeholder example depending on the field type, not just any
 * placeholder." The same rule and the same check as the office app's
 * `apps/web/unit/placeholders.test.mjs`, for the store: a password shows
 * `StrongPassword@123`, an email `name@company.com`, the search names what it
 * searches.
 *
 * This reads every TSX source under src/ and fails when:
 *   - an `<input>`, `<textarea>`, `<Select>` or `<CommandInput>` carries no
 *     `placeholder`, or
 *   - a placeholder is written into the markup as a literal — `"0"`, `"0.00"`,
 *     `"••••••••"`, an email — instead of coming from the locale files, where
 *     both languages carry it, or
 *   - a placeholder string in en.json / ar.json is one of the weak shapes the
 *     rule replaced: empty, `Select…`, `Search...`, `e.g. …`, `Enter …`, a bare
 *     `0`, or missing from one of the two files.
 *
 * Exempt, because nothing is typed into them: hidden, checkbox, radio and file
 * inputs, and the invisible `aria-hidden` input inside the shared Select that
 * only mirrors `required` for the browser.
 *
 * Run with `npm run test:unit`. Set SF_PH_SCAN_ROOT to scan another checkout's
 * src/ (how this was shown to fail on the code before the sweep).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SF_PH_SCAN_ROOT ?? join(HERE, '../src');

const FIELD = /<(input|textarea|Select|CommandInput)\b/g;
const EXEMPT_TYPES = new Set(['hidden', 'checkbox', 'radio', 'file']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/** The element's opening tag: up to the first `>` outside braces and quotes. */
function openingTag(src, start) {
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
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** Strip `{/* … *\/}` and `// …` so a commented-out tag is not scanned. */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function fields(file) {
  const src = withoutComments(readFileSync(file, 'utf8'));
  const out = [];
  for (const m of src.matchAll(FIELD)) {
    const tag = openingTag(src, m.index);
    const type = /\btype="([^"]+)"/.exec(tag)?.[1];
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    out.push({
      kind: m[1],
      tag,
      type,
      name,
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

function exempt({ kind, tag, type }) {
  if (kind === 'input' && type && EXEMPT_TYPES.has(type)) return true;
  // The Select / DatePicker required-mirrors: invisible, untabbable, never typed in.
  if (kind === 'input' && /aria-hidden="true"/.test(tag) && /tabIndex=\{-1\}/.test(tag)) return true;
  return false;
}

test('every field a person types into or picks from has a placeholder', () => {
  const missing = [];
  let scanned = 0;
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    for (const f of fields(file)) {
      if (exempt(f)) continue;
      scanned += 1;
      if (/\bplaceholder=/.test(f.tag)) continue;
      missing.push(`${rel}:${f.line} <${f.kind}${f.name ? ` name="${f.name}"` : ''}>`);
    }
  }
  assert.ok(scanned >= 8, `only ${scanned} fields found — is the scan pointed at src/?`);
  assert.deepEqual(missing, []);
});

test('no placeholder is a literal in the markup — they come from the locale files', () => {
  const literal = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    for (const f of fields(file)) {
      const attr = /\bplaceholder=("([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/.exec(f.tag);
      if (!attr) continue;
      // `placeholder="…"`, or a quoted string inside the expression that is not
      // the key handed to a t() call: '0', '0.00', '••••••••'.
      const expr = attr[3] ?? '';
      const bareString = attr[2] !== undefined || /(^|[^(\w])(['"`])(?:(?!\2).)*\2/.test(expr.replace(/\w+\(\s*(['"`])[^'"`]*\1/g, ''));
      if (bareString) literal.push(`${rel}:${f.line} placeholder=${attr[1]}`);
    }
  }
  assert.deepEqual(literal, []);
});

// ── The strings themselves ────────────────────────────────────────────────
const en = JSON.parse(readFileSync(join(ROOT, 'i18n/locales/en.json'), 'utf8'));
const ar = JSON.parse(readFileSync(join(ROOT, 'i18n/locales/ar.json'), 'utf8'));

function flatten(tree, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(path, v);
    else flatten(v, path, out);
  }
  return out;
}

/** Keys that are placeholder text: the `placeholders` namespace, `…Placeholder`, and search boxes. */
const isPlaceholderKey = (path) =>
  path.startsWith('placeholders.') || /Placeholder$/.test(path) || /^catalogue\.search[A-Z]/.test(path);

const WEAK = [
  { why: 'empty', re: /^\s*$/ },
  { why: 'a bare zero', re: /^0([.,]0+)?$/ },
  { why: 'masked dots', re: /^[•.*]+$/ },
  { why: '"Select…"', re: /^select\s*(…|\.\.\.)?$/i },
  { why: 'a bare "Search"', re: /^search\s*(…|\.\.\.)?$/i },
  { why: 'starts "e.g."', re: /^e\.g\./i },
  { why: 'starts "Enter"', re: /^enter\b/i },
  { why: 'Arabic bare "search"', re: /^بحث\s*(…|\.\.\.)?$/ },
  { why: 'Arabic bare "choose"', re: /^اختر\s*(…|\.\.\.)?$/ },
  { why: 'Arabic "for example"', re: /^(مثال|مثلًا|مثلا)\b/ },
];

test('placeholder strings are real examples, in both languages', () => {
  const english = flatten(en);
  const arabic = flatten(ar);
  const bad = [];
  let checked = 0;
  for (const [path, text] of english) {
    if (!isPlaceholderKey(path)) continue;
    checked += 1;
    const translated = arabic.get(path);
    if (translated === undefined) bad.push(`${path}: missing from ar.json`);
    for (const [lang, value] of [['en', text], ['ar', translated ?? 'x']]) {
      const hit = WEAK.find((w) => w.re.test(value));
      if (hit) bad.push(`${lang} ${path}: ${hit.why} — "${value}"`);
    }
  }
  assert.ok(checked >= 10, `only ${checked} placeholder strings found`);
  assert.deepEqual(bad, []);
});

test('the shared Select has no built-in English placeholder to fall back on', () => {
  // It shipped with `placeholder = 'Select…'` and `searchPlaceholder = 'Search…'`:
  // English on an Arabic-first store, and the generic words the rule replaces.
  const select = readFileSync(join(ROOT, 'components/ui/select.tsx'), 'utf8');
  assert.ok(!/placeholder\s*=\s*['"]/i.test(select), 'select.tsx gives a placeholder a literal default');
});
