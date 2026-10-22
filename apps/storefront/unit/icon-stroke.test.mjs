/**
 * The icons' weight (owner 2026-10-22: "huge icons are a bit smaller than
 * lucide? ... make a bit bigger"). Hugeicons draws stroke 1.5; lucide, which
 * the screens were laid out with, drew 2 — measured, the extent matched and
 * only the ink was lighter. src/components/ui/icons.tsx sets 2 once for every
 * icon; this pins it so a refactor of `icon()` cannot drop back to 1.5. The
 * office pins the same value in its icons.test.tsx.
 *
 * Node cannot load .tsx, so the module is transpiled with the app's own
 * TypeScript, its package imports pointed at this app's node_modules, and
 * every export rendered with react-dom/server.
 *
 * Run with `npm run test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/ui/icons.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
// Bare specifiers resolve from here (this app's node_modules), not from the
// temporary directory the transpiled copy is loaded from.
const resolved = outputText.replace(/from ['"]([^'".][^'"]*)['"]/g, (_, spec) => `from '${import.meta.resolve(spec)}'`);
const dir = mkdtempSync(join(tmpdir(), 'sf-icons-'));
const file = join(dir, 'icons.mjs');
writeFileSync(file, resolved);
const Icons = await import(pathToFileURL(file).href);
rmSync(dir, { recursive: true, force: true });

const all = Object.entries(Icons).filter(([, v]) => v && typeof v === 'object' && 'displayName' in v);
const widths = (html) => [...html.matchAll(/<(?:path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*?stroke-width="([^"]+)"/g)].map((m) => m[1]);
const parts = (html) => [...html.matchAll(/<(?:path|circle|rect|line|polyline|polygon|ellipse)\b/g)].length;

test('covers the whole module', () => {
  assert.ok(all.length > 30, `only ${all.length} icons found`);
});

test('every icon draws every part at stroke 2, not the package 1.5', () => {
  for (const [name, Icon] of all) {
    const html = renderToStaticMarkup(createElement(Icon, { className: 'h-4 w-4' }));
    const w = widths(html);
    assert.equal(w.length, parts(html), `${name}: a part without a stroke width`);
    assert.deepEqual([...new Set(w)], ['2'], name);
  }
});

test('leaves the box alone: same 24 viewBox, the class sizes it', () => {
  const html = renderToStaticMarkup(createElement(Icons.Plus, { className: 'h-4 w-4' }));
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /class="icon icon-plus h-4 w-4"/);
});

test("a caller's own strokeWidth still wins (the install guide's 3)", () => {
  const html = renderToStaticMarkup(createElement(Icons.Check, { strokeWidth: 3 }));
  assert.deepEqual([...new Set(widths(html))], ['3']);
});
