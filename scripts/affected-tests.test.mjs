// node --test scripts/affected-tests.test.mjs
//
// Fixture change lists against the real source tree (the import graph and specs are read from
// disk; nothing here runs git diff). CLAUDE.md rule 0: the happy path once, then attempts to
// break it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO, buildIndex, commands, diffLocale, orphanSpecs, parseNameStatus, realContext, selectTests,
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
