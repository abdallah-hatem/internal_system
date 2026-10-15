/**
 * One dialog, and no native scrollbar (owner, 2026-10-15).
 *
 * The New Product dialog's scrollbar ran down its rounded right edge and past
 * the corner, a grey native track, and Cancel and Create scrolled away with the
 * form. Behind it were twenty dialogs written by hand — a local `Modal` in
 * eleven pages, a portal of its own in seven components — so the fix was the
 * same edit twenty times, and the next dialog would have been the
 * twenty-first copy.
 *
 * This reads every TSX source in the office app and the storefront and fails
 * when:
 *
 *   - a file outside `components/ui` draws its own modal: a `fixed inset-0`
 *     layer (the scrim and the card's overlay) or a `createPortal`. Dialogs and
 *     sheets come from the shared one — `components/ui/dialog.tsx` in the
 *     office, `components/ui/sheet.tsx` and `dialog.tsx` in the storefront.
 *   - an element scrolls (`overflow-auto`, `overflow-y-auto`, `overflow-x-auto`
 *     or `-scroll`) without `scrollbar-clean`, which draws the thin themed bar
 *     instead of the platform's (building-frontends, "Scrollbar").
 *
 * `ALLOW` holds the exceptions, each with its reason. Run with
 * `npm run test:unit`. Set DS_SCAN_ROOTS (comma-separated src/ paths) to scan
 * another checkout — how this was shown to fail on the code before the change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = (process.env.DS_SCAN_ROOTS
  ? process.env.DS_SCAN_ROOTS.split(',')
  : [join(HERE, '../src'), join(HERE, '../../storefront/src')]
).filter((r) => existsSync(r));

/**
 * `file.tsx#token: reason` — a file allowed to draw a modal layer (`#overlay`)
 * or an unstyled scroll (`#overflow-y-auto`). Empty: nothing needs one.
 */
const ALLOW = {};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip comments so a sentence that names a class is not scanned as markup. */
function withoutComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/[^\n]/g, ' '));
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const inUiKit = (file) => file.split(sep).join('/').includes('/components/ui/');

/** The JSX opening tag that holds `index`, or null when it is not inside one. */
function enclosingTag(src, index) {
  for (let i = index; i >= 0 && index - i < 4000; i--) {
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      let depth = 0;
      let quote = null;
      for (let j = i + 1; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '>' && depth === 0 && src[j - 1] !== '=') {
          return j >= index ? src.slice(i, j + 1) : null;
        }
      }
      return null;
    }
  }
  return null;
}

/** The string literal that holds `index`. */
function enclosingLiteral(src, index) {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  const lineEnd = src.indexOf('\n', index);
  const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const at = index - lineStart;
  for (const m of line.matchAll(/(["'`])((?:(?!\1).)*)\1/g)) {
    if (m.index <= at && at < m.index + m[0].length) return m[2];
  }
  return line;
}

const SCROLL = /(?<![\w:-])overflow(?:-[xy])?-(?:auto|scroll)(?![\w-])/g;
const MODAL = /(?<![\w-])fixed\s+inset-0(?![\w-])|createPortal\s*\(/g;

function scan() {
  const modals = [];
  const bars = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = withoutComments(readFileSync(file, 'utf8'));
      const where = (i) => `${relative(join(root, '..', '..'), file)}:${lineOf(src, i)}`;
      const base = file.split(sep).pop();

      if (!inUiKit(file)) {
        for (const m of src.matchAll(MODAL)) {
          if (ALLOW[`${base}#overlay`] && /fixed/.test(m[0])) continue;
          modals.push(`${where(m.index)}  ${m[0].trim()}`);
        }
      }

      for (const m of src.matchAll(SCROLL)) {
        const literal = enclosingLiteral(src, m.index);
        if (/(?<![\w-])scrollbar-clean(?![\w-])/.test(literal)) continue;
        const tag = enclosingTag(src, m.index);
        if (tag && /(?<![\w-])scrollbar-clean(?![\w-])/.test(tag)) continue;
        if (ALLOW[`${base}#${m[0]}`]) continue;
        bars.push(`${where(m.index)}  ${m[0]}`);
      }
    }
  }
  return { modals, bars };
}

const { modals, bars } = scan();

test('the scan reads the sources it is meant to', () => {
  assert.ok(ROOTS.length > 0, 'no src/ directory found to scan');
});

test('no page or component draws its own modal — dialogs come from components/ui', () => {
  assert.deepEqual(
    modals,
    [],
    `Hand-written modal markup outside components/ui (use the shared Dialog):\n  ${modals.join('\n  ')}`,
  );
});

test('every scroll container carries scrollbar-clean', () => {
  assert.deepEqual(
    bars,
    [],
    `A scroll container with the platform's scrollbar (add scrollbar-clean):\n  ${bars.join('\n  ')}`,
  );
});
