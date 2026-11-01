// node --test scripts/affected-tests.test.mjs
//
// Fixture change lists against the real source tree (the import graph and specs are read from
// disk; nothing here runs git diff). CLAUDE.md rule 0: the happy path once, then attempts to
// break it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  REPO, buildIndex, commands, diffLocale, format, isOverlayOnly, orphanSpecs, parseNameStatus, realContext, selectTests,
} from './affected-tests.mjs';

const base = realContext();
const index = buildIndex(base);
const sel = (changes, ctx = base) => selectTests(changes, ctx, index);
const M = (...paths) => paths.map((p) => ({ status: 'M', path: p }));
const T = (name) => `apps/web/tests/${name}`;
const EN = 'apps/web/src/i18n/locales/en.json';

// A real ledger component that few pages render, found rather than hard-coded, so a rename in
// the app fails the sanity test below instead of silently turning these tests into no-ops.
const ledgerOnly = index.files.find((f) => f.startsWith('apps/web/src/components/ledger/') && /\.tsx$/.test(f) && !/\.test\./.test(f)
  && index.routesOf(f).has('ledger') && index.routesOf(f).size <= 3);

test('fixture sanity: the index sees the app', () => {
  assert.ok(index.specs.length > 100, `only ${index.specs.length} specs found`);
  assert.ok(ledgerOnly, 'no ledger-only component found');
  assert.ok(index.controllers.size > 20);
});

test('happy path: a ledger component selects the ledger specs, not unrelated ones', () => {
  const r = sel(M(ledgerOnly));
  assert.equal(r.full, false);
  assert.ok(r.e2e.includes(T('10-ledger.spec.ts')), r.e2e.join(' '));
  assert.ok(!r.e2e.includes(T('54-storefront.spec.ts')));
  assert.ok(!r.e2e.includes(T('13-shipments.spec.ts')));
  assert.ok(!r.e2e.includes(T('14-providers.spec.ts')));
  assert.deepEqual(r.jest.files, []);
  assert.deepEqual(r.vitest.files, [ledgerOnly]);
  assert.match(commands(r).e2e, /^cd apps\/web && npx playwright test tests\/.*10-ledger\.spec\.ts/);
});

test('no changes → nothing to run', () => {
  const r = sel([]);
  assert.equal(r.full, false);
  assert.deepEqual(commands(r), {});
});

test('only docs changed → nothing to run', () => {
  const r = sel(M('docs/BUSINESS_LOGIC.md', 'docs/BUILD_LOG.md', 'README.md', '.claude/LEARNINGS.md', 'apps/web/AGENTS.md', 'Motorcycle_Parts_Business_BRD_V1.pdf'));
  assert.deepEqual(commands(r), {});
  assert.equal(r.ignored.length, 6);
  assert.deepEqual(r.unmapped, []);
});

test('an unknown file runs nothing, is not FULL, and is reported as unmapped', () => {
  for (const p of ['some/new/thing.xyz', 'package.json', '../../etc/passwd', 'scripts/dev.sh']) {
    const r = sel(M(p));
    assert.equal(r.full, false, p);
    assert.deepEqual(commands(r), {}, p);
    assert.equal(r.unmapped.length, 1, p);
    assert.equal(r.unmapped[0].path, p);
  }
});

test('a typo in an app path is reported, not silently dropped', () => {
  const r = sel(M('apps/web/src/components/ledger/does-not-exist.tsx'));
  assert.deepEqual(r.e2e, []);
  assert.match(r.notes.join('\n'), /not on disk/);
});

test('anything in api common/ → FULL, Jest included', () => {
  const r = sel(M('apps/api/src/common/money.ts'));
  assert.equal(r.full, true);
  assert.match(r.fullReasons[0], /common/);
  const c = commands(r);
  assert.equal(c.e2e, 'cd apps/web && npx playwright test');
  assert.equal(c.jest, 'cd apps/api && npx jest');
});

test('a common/ file nothing imports yet is still FULL — the rule, not the graph, decides', () => {
  const r = sel([{ status: 'A', path: 'apps/api/src/common/brand-new-helper.ts' }]);
  assert.equal(r.full, true);
  assert.match(r.fullReasons[0], /common/);
});

test('a common/ change hidden among narrow ones still makes it FULL', () => {
  const r = sel(M(ledgerOnly, 'docs/x.md', 'apps/api/src/common/guards/roles.guard.ts'));
  assert.equal(r.full, true);
  assert.deepEqual(r.e2e, [], 'a FULL run lists no specs');
});

test('every wide trigger is FULL', () => {
  for (const p of [
    'apps/api/prisma/schema.prisma',
    'apps/api/prisma/migrations/20261101000000_x/migration.sql',
    'apps/api/prisma/seed.ts',
    'apps/api/src/modules/auth/auth.service.ts',
    'apps/api/src/modules/sales/orders-owner.guard.ts', // a guard outside common/
    'apps/api/src/app.module.ts',
    'apps/web/playwright.config.ts',
    'apps/web/tests/support/global-setup.ts',
    'apps/web/tests/support/fixtures.ts',
    'apps/web/src/app/[locale]/layout.tsx',
    'apps/web/src/app/globals.css',
    'apps/web/src/middleware.ts',
    'apps/web/src/components/ui/button.tsx', // derived: used by most pages
    'apps/web/src/lib/api.ts',
    'apps/web/package.json',
  ]) {
    assert.equal(sel(M(p)).full, true, p);
  }
});

test('a spec file itself changed → exactly that spec', () => {
  const r = sel(M(T('07-sales.spec.ts')));
  assert.deepEqual(r.e2e, [T('07-sales.spec.ts')]);
  assert.equal(r.full, false);
  assert.deepEqual(r.jest.files, []);
});

test('a deleted spec runs nothing; a deleted page runs its route', () => {
  const gone = sel([{ status: 'D', path: T('07-sales.spec.ts') }]);
  assert.deepEqual(gone.e2e, []);
  assert.match(gone.notes.join(), /was deleted/);

  const ctx = { ...base, exists: (p) => p !== 'apps/web/src/app/[locale]/ledger/page.tsx' && base.exists(p) };
  const page = selectTests([{ status: 'D', path: 'apps/web/src/app/[locale]/ledger/page.tsx' }], ctx, index);
  assert.ok(page.e2e.includes(T('10-ledger.spec.ts')), page.e2e.join(' '));
});

test('a deleted API file maps through its module and is not handed to Jest', () => {
  const r = sel([{ status: 'D', path: 'apps/api/src/modules/returns/old-helper.ts' }]);
  assert.deepEqual(r.jest.files, []);
  assert.ok(r.e2e.includes(T('22-returns.spec.ts')), r.e2e.join(' '));
});

test('a renamed spec runs under its new name only', () => {
  const r = sel([{ status: 'R', oldPath: T('07-sales-old.spec.ts'), path: T('07-sales.spec.ts') }]);
  assert.deepEqual(r.e2e, [T('07-sales.spec.ts')]);
});

test('a renamed component maps through its new path', () => {
  const r = sel([{ status: 'R', oldPath: 'apps/web/src/components/ledger/old-name.tsx', path: ledgerOnly }]);
  assert.ok(r.e2e.includes(T('10-ledger.spec.ts')));
});

test('an API service selects the specs that call its controller, and Jest gets the file', () => {
  const r = sel(M('apps/api/src/modules/returns/returns.service.ts'));
  assert.equal(r.full, false);
  assert.deepEqual(r.jest.files, ['apps/api/src/modules/returns/returns.service.ts']);
  assert.ok(r.e2e.includes(T('22-returns.spec.ts')));
  assert.ok(!r.e2e.includes(T('01-auth.spec.ts')));
});

test('an API unit spec changed → Jest only, no e2e', () => {
  const spec = index.files.find((f) => f.startsWith('apps/api/src/modules/') && f.endsWith('.spec.ts'));
  const r = sel(M(spec));
  assert.deepEqual(r.jest.files, [spec]);
  assert.deepEqual(r.e2e, []);
});

test('a unit spec inside common/ is Jest only — not FULL', () => {
  const r = sel(M('apps/api/src/common/samples.spec.ts'));
  assert.equal(r.full, false);
  assert.deepEqual(r.jest.files, ['apps/api/src/common/samples.spec.ts']);
  assert.deepEqual(r.e2e, []);
});

test('a view hosted on another page reaches the specs that open it by its own name', () => {
  // categories lives on the products page (lib/page-views.ts); its spec opens "categories".
  const r = sel(M('apps/web/src/components/views/categories-view.tsx'));
  assert.ok(r.e2e.includes(T('99-categories-collapse.spec.ts')), r.e2e.join(' '));
  assert.ok(r.e2e.includes(T('03-products.spec.ts')));
});

test('a service half the API imports is FULL', () => {
  assert.equal(sel(M('apps/api/src/modules/audit/audit.service.ts')).full, true);
});

test('i18n: a changed value picks the specs asserting it, a removed key is FULL, broken JSON is FULL', () => {
  const before = fs.readFileSync(path.join(REPO, EN), 'utf8');
  const json = JSON.parse(before);
  const ctxWith = (after) => ({ ...base, read: (p) => (p === EN ? after : base.read(p)), readBase: (p) => (p === EN ? before : null) });

  const changed = structuredClone(json);
  const oldTitle = json.ledger?.title;
  assert.ok(typeof oldTitle === 'string', 'ledger.title missing from en.json');
  changed.ledger.title = 'Cash book';
  const r = selectTests(M(EN), ctxWith(JSON.stringify(changed)), index);
  assert.equal(r.full, false);
  assert.ok(r.e2e.includes(T('40-wizard-i18n.spec.ts')), 'i18n override');
  assert.ok(r.e2e.length > 1);
  assert.equal(r.vitest.full, true, 'the vocabulary checks read every key');

  const removed = structuredClone(json);
  delete removed.ledger.title;
  const r2 = selectTests(M(EN), ctxWith(JSON.stringify(removed)), index);
  assert.equal(r2.full, true);
  assert.match(r2.fullReasons[0], /removed: ledger\.title/);

  assert.equal(selectTests(M(EN), ctxWith('{ "oops": '), index).full, true);
  assert.equal(selectTests([{ status: 'D', path: EN }], ctxWith(null), index).full, true);
});

test('diffLocale: added keys are values, not structure; a string becoming an object is structure', () => {
  assert.deepEqual(diffLocale('{"a":{"b":"x"}}', '{"a":{"b":"x","c":"y"}}'), { wide: null, changed: [{ key: 'a.c', before: null, after: 'y' }] });
  assert.match(diffLocale('{"a":{"b":"x"}}', '{"a":{"b":{"c":"x"}}}').wide, /shape: a\.b/);
  assert.deepEqual(diffLocale('{"a":"x"}', '{"a":"x"}'), { wide: null, changed: [] });
});

test('the root locale page uses the overrides file', () => {
  const r = sel(M('apps/web/src/app/[locale]/page.tsx'));
  assert.ok(r.e2e.includes(T('45-client-navigation.spec.ts')));
});

test('storefront changes pick the specs that drive the storefront', () => {
  const f = index.files.find((x) => x.startsWith('apps/storefront/src/') && x.endsWith('.tsx'));
  const r = sel(M(f));
  assert.ok(r.e2e.includes(T('54-storefront.spec.ts')));
  assert.ok(!r.e2e.includes(T('10-ledger.spec.ts')));
});

test('a selection that is most of the suite becomes FULL', () => {
  const pages = index.files.filter((f) => /^apps\/web\/src\/app\/\[locale\]\/[^/]+\/page\.tsx$/.test(f));
  const r = sel(M(...pages));
  assert.equal(r.full, true);
  assert.match(r.fullReasons.at(-1), /of \d+ specs/);
});

test('changing this script runs its own tests and nothing else', () => {
  const r = sel(M('scripts/affected-tests.mjs', 'scripts/affected-tests.overrides.json'));
  assert.deepEqual(commands(r), { self: 'node --test scripts/affected-tests.test.mjs' });
});

test('parseNameStatus reads renames, copies, deletions and blank lines', () => {
  assert.deepEqual(parseNameStatus('M\ta.ts\nR087\told.ts\tnew.ts\nD\tgone.ts\nC100\tsrc.ts\tcopy.ts\n\n'), [
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'D', path: 'gone.ts' },
    { status: 'A', path: 'copy.ts', oldPath: undefined },
  ]);
});

test('every spec is reachable by some derived rule (a new spec nothing can select fails here)', () => {
  assert.deepEqual(orphanSpecs(index), []);
});

test('the overrides file names only files that exist', () => {
  const o = base.overrides;
  const specs = [...Object.values(o.paths).flat(), ...o.i18n, ...o.storefront];
  for (const s of specs) assert.ok(index.fileSet.has(T(s)), `overrides name a missing spec: ${s}`);
  for (const p of Object.keys(o.paths)) assert.ok(index.fileSet.has(p), `overrides name a missing path: ${p}`);
});

// ── visual regression ────────────────────────────────────────────────────────
const VIS = 'apps/web/tests/visual.spec.ts';
const VIS_STORE = 'apps/web/tests/visual-storefront.spec.ts';
const vtitles = (r) => r.visual.tests.map((t) => t.title).sort();
const both = (...screens) => screens.flatMap((s) => [`${s} · ar`, `${s} · en`]).sort();
const OFFICE = ['dashboard', 'analytics', 'sales list', 'sale detail dialog', 'products', 'customers', 'cycles list', 'cycle detail', 'payments', 'ledger'];
const allVisual = () => index.visual.screens.flatMap((s) => s.tests.map((t) => t.title)).sort();

test('visual fixture sanity: every screen is read from the specs and lands on a real page', () => {
  const office = index.visual.screens.filter((s) => s.spec === VIS);
  assert.deepEqual(office.map((s) => s.name), OFFICE);
  for (const s of office) {
    assert.ok(s.resolved, `${s.name}: route ${s.route.join('/')} has no page folder`);
    assert.deepEqual(s.tests.map((t) => t.locale), ['en', 'ar'], s.name);
  }
  // The one screen that ends on another URL than it opened: derived from its toHaveURL.
  const detail = office.find((s) => s.name === 'cycle detail');
  assert.deepEqual([...detail.pageFiles].filter((f) => f.endsWith('/page.tsx')), ['apps/web/src/app/[locale]/cycles/[cycleId]/page.tsx']);
  assert.ok(!office.find((s) => s.name === 'cycles list').pageFiles.has('apps/web/src/app/[locale]/cycles/[cycleId]/page.tsx'));
  // Around every office screen: the root layouts (and so whatever they import).
  for (const s of office) assert.ok(s.pageFiles.has('apps/web/src/app/[locale]/layout.tsx'), s.name);
  // Dialog screens need the overrides entry, or a component inside the dialog reaches nothing.
  for (const s of office.filter((x) => x.overlay)) assert.ok(base.overrides.visual?.[s.name]?.length, `overrides.visual has no entry for ${s.name}`);
  assert.deepEqual(office.filter((x) => x.overlay).map((x) => x.name), ['sale detail dialog']);
  assert.deepEqual(index.visual.screens.filter((s) => s.storefront).map((s) => s.name), ['storefront catalogue', 'storefront product', 'storefront sign-in']);
});

test('visual: every baseline PNG belongs to a test and every test has a baseline', () => {
  const owned = new Set(index.visual.screens.flatMap((s) => s.tests.map((t) => `${t.spec}-snapshots/${t.snapshot}`)));
  const pngs = index.files.filter((f) => /^apps\/web\/tests\/visual[^/]*\.spec\.ts-snapshots\/.+\.png$/.test(f));
  assert.ok(pngs.length >= 24, `only ${pngs.length} baselines`);
  for (const f of pngs) assert.ok(owned.has(f.replace(/-[a-z0-9]+-darwin\.png$/, '')), `no test takes ${f}`);
  for (const k of owned) assert.ok(pngs.some((f) => f.startsWith(`${k}-`)), `no baseline for ${k}`);
});

test('visual: no screen name, used as a grep, matches another screen\'s test', () => {
  const titles = index.visual.screens.flatMap((s) => s.tests.map((t) => ({ screen: s.name, full: `office · ${t.locale} ${t.title}` })));
  for (const s of index.visual.screens) {
    const hits = titles.filter((t) => t.full.includes(s.name)).map((t) => t.screen);
    assert.deepEqual([...new Set(hits)], [s.name], `-g "${s.name}" also runs ${hits.join(', ')}`);
  }
});

test('visual happy path: a sales component → sales list + sale detail dialog, both locales, nothing else', () => {
  const r = sel(M('apps/web/src/components/sales/order-history.tsx'));
  assert.deepEqual(vtitles(r), both('sale detail dialog', 'sales list'));
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts -g "sales list|sale detail dialog"');
  assert.equal(commands(r).visual, r.visual.command);
  assert.ok(!r.e2e.some((s) => /visual/.test(s)), 'visual specs never join the e2e list (they need VISUAL=1)');
});

test('visual: the shared dialog primitive → only the screen that captures an open dialog', () => {
  const r = sel(M('apps/web/src/components/ui/dialog.tsx'));
  assert.equal(r.full, true, 'e2e still treats it as shared');
  assert.equal(r.visual.full, false);
  assert.deepEqual(vtitles(r), both('sale detail dialog'));
});

test('visual: a dialog no captured screen opens → no visual test; one with page-level exports → its pages', () => {
  for (const f of ['apps/web/src/components/sales/return-samples-dialog.tsx', 'apps/web/src/components/shipment/MarkLostDialog.tsx', 'apps/web/src/components/settlements/leave-in-dialog.tsx']) {
    const r = sel(M(f));
    assert.deepEqual(vtitles(r), [], f);
    assert.equal(r.visual.command, null, f);
  }
  // RecordPaymentDialog.tsx also exports canTakePayment, which the list pages call: not dialog-only.
  // The customers list is not among them — only a customer's own page renders it.
  const r = sel(M('apps/web/src/components/payments/RecordPaymentDialog.tsx'));
  assert.deepEqual(vtitles(r), both('payments', 'sale detail dialog', 'sales list'));
});

test('visual: what is reached only through a dialog-only file stays behind it', () => {
  const helper = 'apps/web/src/components/shipment/mark-lost-helper.ts';
  const dlg = 'apps/web/src/components/shipment/MarkLostDialog.tsx';
  const ctx = {
    ...base,
    listFiles: () => [...base.listFiles(), helper],
    exists: (p) => p === helper || base.exists(p),
    read: (p) => (p === helper ? 'export const x = 1;\n' : p === dlg ? `import { x } from './mark-lost-helper';\n${base.read(dlg)}` : base.read(p)),
  };
  const idx = buildIndex(ctx);
  assert.ok(idx.routesOf(helper).has('cycles'), 'the e2e graph does reach the cycles page');
  assert.deepEqual(selectTests(M(helper), ctx, idx).visual.tests, []);
});

test('isOverlayOnly: only files whose every value export is a *Dialog* component', () => {
  assert.equal(isOverlayOnly('export interface P {}\nexport function MarkLostDialog() {}'), true);
  assert.equal(isOverlayOnly('export function Dialog() {}\nexport function DialogAlert() {}\nexport type S = 1;'), true);
  assert.equal(isOverlayOnly('export function RecordPaymentDialog() {}\nexport function canTakePayment() {}'), false);
  assert.equal(isOverlayOnly('export const PAID = 1;\nexport function LedgerEntryDialog() {}'), false);
  assert.equal(isOverlayOnly('export default function FooDialog() {}'), false, 'a default export cannot be told apart');
  assert.equal(isOverlayOnly("export { FooDialog } from './x';"), false);
  assert.equal(isOverlayOnly('export type A = 1;\nexport interface B {}'), false, 'types only: nothing says it is a dialog');
  assert.equal(isOverlayOnly(''), false);
  assert.equal(isOverlayOnly(null), false);
});

test('visual: a storefront page → the storefront visual spec only', () => {
  const f = index.files.find((x) => x.startsWith('apps/storefront/src/app/') && x.endsWith('page.tsx'));
  const r = sel(M(f));
  assert.deepEqual(vtitles(r), index.visual.screens.filter((s) => s.storefront).flatMap((s) => s.tests.map((t) => t.title)).sort());
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual-storefront.spec.ts');
  assert.equal(r.visual.precondition, null, 'the storefront spec checks no API clock');
});

test('visual: FULL rules select every visual test', () => {
  for (const p of ['apps/api/src/common/money.ts', 'apps/web/src/app/globals.css', 'apps/web/src/app/[locale]/layout.tsx', 'apps/api/prisma/seed.ts', 'apps/web/playwright.config.ts', 'apps/api/src/modules/audit/audit.service.ts']) {
    const r = sel(M(p));
    assert.equal(r.visual.full, true, p);
    assert.deepEqual(vtitles(r), allVisual(), p);
    assert.equal(r.visual.command, 'npm run test:visual', p);
  }
});

test('visual: a component on every office page is every office screen — and not the storefront', () => {
  const r = sel(M('apps/web/src/components/ui/button.tsx'));
  assert.equal(r.visual.full, false);
  assert.deepEqual(vtitles(r), both(...OFFICE));
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts');
});

test('visual: the app shell no page imports is still on every office screen (the layout renders it)', () => {
  const r = sel(M('apps/web/src/components/layout/app-shell.tsx'));
  assert.deepEqual(vtitles(r), both(...OFFICE));
  assert.ok(r.unmapped.length === 1, 'e2e still reports it unmapped — the e2e map is per page');
});

test('visual: docs only → none, and the output says so', () => {
  const r = sel(M('docs/BUILD_LOG.md', 'README.md', '.claude/LEARNINGS.md'));
  assert.deepEqual(r.visual.tests, []);
  assert.equal(r.visual.command, null);
  const text = format(r, { label: 'x', total: 3 });
  assert.match(text, /Visual: no visual screen shows this change/);
  assert.doesNotMatch(text, /VISUAL=1/);
});

test('visual: a page with no visual screen → none', () => {
  for (const p of ['apps/web/src/app/[locale]/lenders/page.tsx', 'apps/web/src/app/[locale]/settlements/page.tsx', 'apps/web/src/app/[locale]/page.tsx']) {
    assert.ok(index.fileSet.has(p), p);
    assert.deepEqual(sel(M(p)).visual.tests, [], p);
  }
});

test('visual: a changed baseline PNG → exactly its test, one locale', () => {
  const r = sel(M(`${VIS}-snapshots/ledger-ar-chromium-darwin.png`));
  assert.deepEqual(vtitles(r), ['ledger · ar']);
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts -g "ledger · ar"');
  assert.deepEqual(r.unmapped, []);
  assert.deepEqual(r.e2e, []);

  const linux = sel([{ status: 'A', path: `${VIS}-snapshots/sale-detail-en-chromium-linux.png` }]);
  assert.deepEqual(vtitles(linux), ['sale detail dialog · en']);
  const gone = sel([{ status: 'D', path: `${VIS_STORE}-snapshots/store-home-en-storefront-darwin.png` }]);
  assert.deepEqual(vtitles(gone), ['storefront catalogue · en']);

  // A sales-list baseline must not pick the sale detail one (sales-ar vs sale-detail-ar).
  assert.deepEqual(vtitles(sel(M(`${VIS}-snapshots/sales-ar-chromium-darwin.png`))), ['sales list · ar']);

  const stale = sel(M(`${VIS}-snapshots/nothing-en-chromium-darwin.png`));
  assert.deepEqual(stale.visual.tests, []);
  assert.match(stale.unmapped[0].note, /no test takes/);
});

test('visual: a PNG and a screen together grep by name for the screen and by title for the PNG', () => {
  const r = sel(M(`${VIS}-snapshots/ledger-ar-chromium-darwin.png`, 'apps/web/src/components/sales/order-history.tsx'));
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts -g "sales list|sale detail dialog|ledger · ar"');
});

test('visual: a changed visual spec → all its tests, never the e2e list', () => {
  const r = sel(M(VIS));
  assert.deepEqual(vtitles(r), both(...OFFICE));
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts');
  assert.deepEqual(r.e2e, []);
  assert.equal(sel(M(VIS, VIS_STORE)).visual.command, 'npm run test:visual');
  assert.deepEqual(sel([{ status: 'D', path: VIS }]).visual.tests, []);
});

test('visual: a storefront change and an office screen together → one command over both specs', () => {
  const store = index.files.find((x) => x.startsWith('apps/storefront/src/app/') && x.endsWith('page.tsx'));
  const r = sel(M(store, 'apps/web/src/components/sales/order-history.tsx'));
  assert.equal(r.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual-storefront.spec.ts tests/visual.spec.ts -g "storefront catalogue|storefront product|storefront sign-in|sales list|sale detail dialog"');
});

test('visual: an i18n value picks the screens of its namespace, both locales; a removed key is every test', () => {
  const before = fs.readFileSync(path.join(REPO, EN), 'utf8');
  const json = JSON.parse(before);
  const ctxWith = (after) => ({ ...base, read: (p) => (p === EN ? after : base.read(p)), readBase: (p) => (p === EN ? before : null) });
  const changed = structuredClone(json);
  changed.ledger.title = 'Cash book';
  const r = selectTests(M(EN), ctxWith(JSON.stringify(changed)), index);
  assert.ok(vtitles(r).includes('ledger · en') && vtitles(r).includes('ledger · ar'), vtitles(r).join(', '));
  assert.ok(!vtitles(r).includes('sales list · en'), 'the sales screens do not render ledger.*');
  const removed = structuredClone(json);
  delete removed.ledger.title;
  assert.equal(selectTests(M(EN), ctxWith(JSON.stringify(removed)), index).visual.command, 'npm run test:visual');
});

test('visual: an API service → the screens of the pages that call it', () => {
  const r = sel(M('apps/api/src/modules/returns/returns.service.ts'));
  assert.ok(vtitles(r).includes('sales list · en'));
  assert.ok(!vtitles(r).includes('ledger · en'));
});

test('visual: the precondition is the one visual.spec.ts fails with, copied from it', () => {
  const src = fs.readFileSync(path.join(REPO, VIS), 'utf8');
  const iso = new Date(src.match(/FROZEN_NOW = new Date\('([^']+)'\)/)[1]).toISOString();
  const r = sel(M('apps/web/src/components/sales/order-history.tsx'));
  assert.equal(r.visual.precondition, `Start it at ${iso} (AGENT_CLOCK=${iso} scripts/agent-servers.sh <name> start) and restart it every 12 hours.`);
  assert.ok(format(r, { label: 'x', total: 1 }).includes(`AGENT_CLOCK=${iso} scripts/agent-servers.sh <name> start`));
});

test('visual: --json carries a visual field', () => {
  const out = execFileSync('node', [path.join(REPO, 'scripts/affected-tests.mjs'), '--files', 'apps/web/src/components/ui/dialog.tsx', '--json'], { cwd: REPO, encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.visual.command, 'cd apps/web && VISUAL=1 npx playwright test tests/visual.spec.ts -g "sale detail dialog"');
  assert.equal(j.commands.visual, j.visual.command);
  assert.equal(j.visual.tests.length, 2);
});

test('the visual overrides name only screens and files that exist', () => {
  for (const [screen, files] of Object.entries(base.overrides.visual ?? {})) {
    assert.ok(index.visual.screens.some((s) => s.name === screen), `overrides.visual names no screen: ${screen}`);
    for (const f of files) assert.ok(index.fileSet.has(f), `overrides.visual names a missing file: ${f}`);
  }
});
