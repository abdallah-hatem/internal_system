#!/usr/bin/env node
/**
 * Which tests does this change touch?
 *
 *   node scripts/affected-tests.mjs                 # vs dev, committed + uncommitted + untracked
 *   node scripts/affected-tests.mjs main            # vs another base ref
 *   node scripts/affected-tests.mjs --commit <sha>  # what one commit touched
 *   node scripts/affected-tests.mjs --files a b c   # a file list, no git diff
 *   node scripts/affected-tests.mjs --run           # also run the Jest part (never e2e)
 *   node scripts/affected-tests.mjs --json          # machine-readable
 *
 * Project rule (.claude/LEARNINGS.md, "How much of the suite to run"): run what the change
 * touches, not all of it — but run everything when the change is cross-cutting: a guard, a
 * shared component, an error code, anything in common/. This prints FULL for those.
 * e2e is never run from here: the owner runs it, or asks for it.
 *
 * How the e2e selection is derived, so no one has to reason about it:
 *  - an import graph of apps/web/src, apps/api/src, apps/storefront/src and apps/web/tests;
 *  - a web file reaches the pages (app/[locale]/<route>/) that import it, transitively;
 *    a file reaching WEB_WIDE_ROUTES or more pages is shared → FULL;
 *  - an API file reaches the controllers that import it; their @Controller prefixes are
 *    matched against `${API}/...` paths in specs and against the pages whose own files call
 *    them; reaching API_WIDE_PREFIXES or more prefixes → FULL;
 *  - a spec is picked for a route when it opens `/en/<route>` (or `/ar/`, `${locale}/`);
 *  - an i18n change: a removed key or changed shape → FULL; a changed or added value picks
 *    the specs whose text contains the old or new value, and the pages of the namespace;
 *  - scripts/affected-tests.overrides.json for the few links none of the above can see.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

export const WEB_WIDE_ROUTES = 8;
export const API_WIDE_PREFIXES = 8;
export const SUPPORT_WIDE_SPECS = 10;
export const WIDE_SHARE = 0.6; // a selection this share of all specs or more is FULL

const WEB_SRC = 'apps/web/src/';
const WEB_TESTS = 'apps/web/tests/';
const API_SRC = 'apps/api/src/';
const STORE_SRC = 'apps/storefront/src/';
const APP_DIR = 'apps/web/src/app/[locale]/';
const LOCALES = ['apps/web/src/i18n/locales/en.json', 'apps/web/src/i18n/locales/ar.json'];
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

// ── FULL by rule ─────────────────────────────────────────────────────────────
// Mirrors LEARNINGS: "a guard, a shared component, an error code, anything in common/".
// Each entry: [test, reason]. Checked before anything is derived.
const WIDE_RULES = [
  [(p) => p.startsWith('apps/api/src/common/'), 'anything in api common/ (guards, error codes, shared money rules)'],
  [(p) => p.startsWith('apps/api/prisma/'), 'prisma schema, migrations or seed — every test runs on that data'],
  [(p) => p === 'apps/api/prisma.config.ts', 'prisma config'],
  [(p) => p.startsWith('apps/api/src/modules/auth/'), 'auth — every spec logs in'],
  [(p) => /(^|\/)guards?\//.test(p) || /\.guard\.ts$/.test(p), 'a guard'],
  [(p) => /\.(filter|interceptor|middleware)\.ts$/.test(p) && p.startsWith(API_SRC), 'an API filter/interceptor/middleware'],
  [(p) => p.startsWith('apps/api/src/prisma/'), 'the Prisma service'],
  [(p) => ['apps/api/src/app.module.ts', 'apps/api/src/main.ts'].includes(p), 'API bootstrap'],
  [(p) => /^apps\/(api|web|storefront)\/(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(p), 'dependencies or compiler config'],
  [(p) => /^apps\/(web|storefront)\/next\.config\.ts$/.test(p), 'Next config'],
  [(p) => p === 'apps/web/playwright.config.ts', 'Playwright config'],
  [(p) => /^apps\/web\/tests\/support\/(global-setup|global-teardown|env|database|fixtures|gate)\.ts$/.test(p), 'e2e support every run goes through'],
  [(p) => p === 'apps/web/src/middleware.ts', 'web middleware — every request'],
  [(p) => /^apps\/web\/src\/app\/[^/]+\.(tsx?|css)$/.test(p) && p !== 'apps/web/src/app/manifest.ts', 'root layout or global CSS'],
  [(p) => /^apps\/web\/src\/app\/\[locale\]\/(layout|loading|error|not-found|template)\.tsx$/.test(p), 'the layout every page renders in'],
  [(p) => /^apps\/web\/src\/i18n\/(request|routing|navigation)\.ts$/.test(p), 'i18n wiring'],
  [(p) => p === 'docker-compose.yml', 'database container'],
];

// Changes that need no test at all.
const IGNORE = [
  (p) => p.startsWith('docs/'),
  (p) => p.endsWith('.md'),
  (p) => p.startsWith('.claude/'),
  (p) => /^[^/]+\.(pdf|docx)$/.test(p),
  (p) => /(^|\/)\.gitignore$/.test(p),
  (p) => /(^|\/)eslint(\.config\.mjs|-suppressions\.json)$/.test(p),
  (p) => /^apps\/[^/]+\/(AGENTS|CLAUDE|README)\.md$/.test(p),
];

// ── small helpers ────────────────────────────────────────────────────────────
const isCode = (p) => CODE_EXT.some((e) => p.endsWith(e)) && !p.endsWith('.d.ts');
const isWebUnitTest = (p) => p.startsWith(WEB_SRC) && /\.test\.tsx?$/.test(p);
const isApiSpec = (p) => p.startsWith(API_SRC) && p.endsWith('.spec.ts');
const isE2eSpec = (p) => p.startsWith(WEB_TESTS) && /^[^/]+\.spec\.ts$/.test(p.slice(WEB_TESTS.length));
const specName = (p) => p.slice(WEB_TESTS.length);

function gitOut(args, cwd = REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Default context: the real repo on disk. Tests swap any part of it. */
export function realContext(repo = REPO, base = null) {
  const cache = new Map();
  return {
    repo,
    listFiles: () =>
      [...new Set([
        ...gitOut(['ls-files'], repo).split('\n'),
        ...gitOut(['ls-files', '--others', '--exclude-standard'], repo).split('\n'),
      ])].filter((f) => f && fs.existsSync(path.join(repo, f))),
    exists: (p) => fs.existsSync(path.join(repo, p)),
    read: (p) => {
      if (!cache.has(p)) {
        try { cache.set(p, fs.readFileSync(path.join(repo, p), 'utf8')); } catch { cache.set(p, null); }
      }
      return cache.get(p);
    },
    readBase: (p) => {
      if (!base) return null;
      try { return gitOut(['show', `${base}:${p}`], repo); } catch { return null; }
    },
    overrides: JSON.parse(fs.readFileSync(path.join(HERE, 'affected-tests.overrides.json'), 'utf8')),
  };
}

// ── the index: import graph, routes, controllers, specs ──────────────────────
const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveImport(from, spec, fileSet) {
  let target;
  if (spec.startsWith('@/')) {
    const app = from.match(/^(apps\/[^/]+)\//)?.[1];
    if (!app) return null;
    target = `${app}/src/${spec.slice(2)}`;
  } else if (spec.startsWith('.')) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  } else return null;
  const tries = [target, ...CODE_EXT.map((e) => target + e), ...CODE_EXT.map((e) => `${target}/index${e}`)];
  if (/\.js$/.test(target)) tries.push(target.replace(/\.js$/, '.ts'));
  return tries.find((t) => fileSet.has(t)) ?? null;
}

function bfs(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of edges.get(queue.shift()) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

const routeOfAppFile = (p) => {
  if (!p.startsWith(APP_DIR)) return null;
  const rest = p.slice(APP_DIR.length);
  if (!rest.includes('/')) return rest.startsWith('page.') ? '' : null;
  return rest.split('/')[0];
};

// String literals that call the API from web code: api.get('/sales/orders/...')
const WEB_API_CALL_RE = /\bapi\w*\.(?:get|post|put|patch|delete)\s*(?:<[^>]*>)?\(\s*['"`]\/([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)/g;
// What a spec opens: /en/sales, /ar/cycles/new, ${locale}/customers
const SPEC_ROUTE_RE = /(?:\/(?:en|ar)|\$\{\s*(?:locale|loc|lang)\s*\})\/([a-z][a-z-]*)/g;
// What a spec opens through the support helpers: openView(page, 'settlements'), go(page, 'partners'),
// openNav(page, m.nav.customers), openCustomer(...)
const SPEC_VIEW_RE = /\b(?:openView|go)\(\s*page\s*,\s*['"`]([a-z][a-z-]*)['"`]/g;
const SPEC_NAV_RE = /\bnav\.([a-zA-Z]+)\b/g;
// What a spec calls: ${API}/sales/orders, ${ROOT}/mcp, '/sales' passed to a helper
const SPEC_API_RE = /\$\{\s*(?!BASE\b|WEB\b|OFFICE\b|STORE\b)[A-Z][A-Z_]*\s*\}\/([a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9-]*)*)|['"`]\/(?!en\/|ar\/)([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)/g;
const NS_RE = /\b(?:useTranslations|getTranslations)\(\s*(?:\{\s*namespace:\s*)?['"]([A-Za-z0-9_.]+)['"]/g;

export function buildIndex(ctx) {
  const files = ctx.listFiles();
  const fileSet = new Set(files);
  // Unit test files stay out of the graph: a component a unit test imports is not rendered by
  // the page that test sits beside.
  const graphed = files.filter((f) => isCode(f) && !/\.test\.[jt]sx?$/.test(f)
    && (f.startsWith(WEB_SRC) || f.startsWith(API_SRC) || f.startsWith(STORE_SRC) || f.startsWith(WEB_TESTS)));
  const importers = new Map(); // file -> files that import it
  const imports = new Map();
  for (const f of graphed) {
    const src = ctx.read(f) ?? '';
    const deps = new Set();
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveImport(f, m[1] ?? m[2] ?? m[3] ?? m[4], fileSet);
      if (r && r !== f) deps.add(r);
    }
    imports.set(f, deps);
    for (const d of deps) {
      if (!importers.has(d)) importers.set(d, new Set());
      importers.get(d).add(f);
    }
  }

  const knownRoutes = new Set(files.map(routeOfAppFile).filter((r) => r));

  // Specs and what they open/call.
  const specs = files.filter(isE2eSpec).sort();
  const specInfo = new Map();
  for (const s of specs) {
    const src = ctx.read(s) ?? '';
    const routes = new Set([...src.matchAll(SPEC_ROUTE_RE)].map((m) => m[1]));
    for (const m of src.matchAll(SPEC_VIEW_RE)) routes.add(m[1]);
    for (const m of src.matchAll(SPEC_NAV_RE)) {
      const r = m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (knownRoutes.has(r)) routes.add(r);
    }
    if (/\bopenCustomer\(/.test(src)) routes.add('customers');
    const apiPaths = new Set([...src.matchAll(SPEC_API_RE)].map((m) => m[1] ?? m[2]));
    const usesStore = /\bSTORE\b/.test(src);
    specInfo.set(s, { routes, apiPaths, usesStore, text: src.toLowerCase() });
  }

  // Controllers and their prefixes.
  const controllers = new Map();
  for (const f of graphed) {
    if (!f.startsWith(API_SRC) || !f.endsWith('.controller.ts')) continue;
    const prefixes = [...(ctx.read(f) ?? '').matchAll(/@Controller\(\s*['"`]([^'"`]*)['"`]/g)].map((m) => m[1]).filter(Boolean);
    controllers.set(f, prefixes);
  }

  const index = { files, fileSet, imports, importers, specs, specInfo, controllers, ctx };
  index.routesOf = (f) => {
    const routes = new Map(); // route -> one page file that reaches it
    for (const g of bfs(f, importers)) {
      const r = routeOfAppFile(g);
      if (r !== null && !routes.has(r)) routes.set(r, g);
    }
    return routes;
  };

  // Which routes call which API prefixes — only through files that belong to few pages,
  // so a shared client (lib/api.ts, the notifications bell) does not tie every page to every call.
  const apiToRoutes = new Map();
  for (const f of graphed) {
    if (!f.startsWith(WEB_SRC)) continue;
    const calls = [...(ctx.read(f) ?? '').matchAll(WEB_API_CALL_RE)].map((m) => m[1]);
    if (!calls.length) continue;
    const routes = index.routesOf(f);
    if (routes.size >= WEB_WIDE_ROUTES) continue;
    for (const c of calls) {
      if (!apiToRoutes.has(c)) apiToRoutes.set(c, new Set());
      for (const r of routes.keys()) apiToRoutes.get(c).add(r);
    }
  }
  index.apiToRoutes = apiToRoutes;

  // i18n namespace -> files that use it
  const nsFiles = new Map();
  for (const f of graphed) {
    if (!f.startsWith(WEB_SRC)) continue;
    for (const m of (ctx.read(f) ?? '').matchAll(NS_RE)) {
      if (!nsFiles.has(m[1])) nsFiles.set(m[1], new Set());
      nsFiles.get(m[1]).add(f);
    }
  }
  index.nsFiles = nsFiles;

  // Pages holding several views as tabs: cycles hosts purchases and shipments, products hosts
  // categories… A spec that opens `?view=categories` or the old /categories is on the products page.
  const views = new Map();
  const pv = ctx.read('apps/web/src/lib/page-views.ts') ?? '';
  const block = pv.match(/PAGE_VIEWS\s*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const m of block.matchAll(/([a-z][\w-]*)\s*:\s*\[([^\]]*)\]/g)) {
    views.set(m[1], [...m[2].matchAll(/slug:\s*['"]([a-z-]+)['"]/g)].map((s) => s[1]).filter((s) => s !== m[1]));
  }
  index.views = views;
  return index;
}

// ── i18n diff ────────────────────────────────────────────────────────────────
function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) { out.set(key, '{object}'); flatten(v, key, out); }
    else out.set(key, v);
  }
  return out;
}

/** { wide: reason|null, changed: [{key, before, after}] } */
export function diffLocale(beforeText, afterText) {
  let before, after;
  try { before = beforeText == null ? {} : JSON.parse(beforeText); } catch { return { wide: 'locale file did not parse at base', changed: [] }; }
  if (afterText == null) return { wide: 'locale file deleted', changed: [] };
  try { after = JSON.parse(afterText); } catch { return { wide: 'locale file does not parse', changed: [] }; }
  const b = flatten(before), a = flatten(after);
  const changed = [];
  for (const [k, v] of b) {
    if (!a.has(k)) return { wide: `i18n key removed: ${k}`, changed: [] };
    const nv = a.get(k);
    if ((v === '{object}') !== (nv === '{object}')) return { wide: `i18n key changed shape: ${k}`, changed: [] };
    if (v !== nv) changed.push({ key: k, before: v, after: nv });
  }
  for (const [k, v] of a) if (!b.has(k) && v !== '{object}') changed.push({ key: k, before: null, after: v });
  return { wide: null, changed };
}

// The longest literal run of a message, without ICU placeholders: "Paid {amount} of {total}" -> "Paid "
function literal(msg) {
  if (typeof msg !== 'string') return null;
  const parts = msg.split(/\{[^}]*\}/).map((s) => s.trim()).sort((x, y) => y.length - x.length);
  return parts[0] && parts[0].length >= 4 ? parts[0].toLowerCase() : null;
}

// ── the selection ────────────────────────────────────────────────────────────
/**
 * changes: [{ status: 'A'|'M'|'D'|'R', path, oldPath? }]
 * Returns { full: bool, fullReasons, jest: {files, full}, vitest: {files, full}, nodeUnit: [...],
 *           e2e: Map(spec -> reason), self: bool, unmapped: [{path, note}], ignored: [...], notes: [...] }
 */
export function selectTests(changes, ctx, index = buildIndex(ctx)) {
  const r = {
    fullReasons: [], apiFullReasons: [], jest: new Set(), vitest: new Set(), webUnitAll: false,
    nodeUnit: new Set(), e2e: new Map(), self: false, unmapped: [], ignored: [], notes: [],
  };
  const pick = (spec, why) => { if (!r.e2e.has(spec)) r.e2e.set(spec, why); };
  const pickRoute = (route, why) => {
    // A page that hosts several views (lib/page-views.ts) is also reached as each of them.
    for (const name of [route, ...(index.views.get(route) ?? [])]) {
      for (const [s, info] of index.specInfo) if (info.routes.has(name)) pick(s, `opens /${name} ← ${why}`);
    }
  };
  const pickApiPrefix = (prefix, why) => {
    const hit = (p) => p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}?`);
    for (const [s, info] of index.specInfo) if ([...info.apiPaths].some(hit)) pick(s, `calls /${prefix} ← ${why}`);
    for (const [call, routes] of index.apiToRoutes) {
      if (hit(call)) for (const route of routes) pickRoute(route, `page calls /${prefix} ← ${why}`);
    }
  };
  const overrides = ctx.overrides ?? {};
  const pickOverrides = (p) => {
    for (const [prefix, list] of Object.entries(overrides.paths ?? {})) {
      if (p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
        for (const s of list) pick(WEB_TESTS + s, `override for ${prefix}`);
      }
    }
  };

  // A rename is the old path going away and the new one arriving.
  const flat = [];
  for (const c of changes) {
    if (c.status === 'R' && c.oldPath) { flat.push({ status: 'D', path: c.oldPath }); flat.push({ status: 'A', path: c.path }); }
    else flat.push(c);
  }

  for (const { status, path: p } of flat) {
    const deleted = status === 'D' || !ctx.exists(p);
    const gone = status === 'D' ? 'was deleted' : 'is not on disk (deleted, or a typo?)';
    if (IGNORE.some((t) => t(p))) { r.ignored.push(p); continue; }

    if (p.startsWith('scripts/affected-tests')) { r.self = true; continue; }

    // A unit spec, even one in common/, is run by Jest and changes nothing e2e depends on.
    if (isApiSpec(p)) { if (!deleted) r.jest.add(p); continue; }

    const wide = WIDE_RULES.find(([t]) => t(p));
    if (wide) {
      r.fullReasons.push(`${p} — ${wide[1]}`);
      if (p.startsWith('apps/api/')) r.apiFullReasons.push(p);
      if (p.startsWith('apps/web/') && !p.startsWith(WEB_TESTS) && p !== 'apps/web/playwright.config.ts') r.webUnitAll = true;
      continue;
    }

    // ── API ──
    if (p.startsWith('apps/api/')) {
      if (!p.startsWith(API_SRC)) { r.unmapped.push({ path: p, note: 'API file outside src/ (no unit or e2e rule)' }); continue; }
      if (!deleted && /\.(ts|js)$/.test(p)) r.jest.add(p);
      if (isApiSpec(p)) continue; // a unit spec changed: Jest runs it, e2e does not care
      if (p.startsWith('apps/api/src/one-off/')) continue;
      let ctrls;
      if (deleted) {
        // Gone from the graph: fall back to the controllers of its own module.
        const mod = p.match(/^apps\/api\/src\/modules\/[^/]+\//)?.[0];
        ctrls = mod ? [...index.controllers.keys()].filter((c) => c.startsWith(mod)) : [];
        r.notes.push(`${p} ${gone}; mapped through its module's controllers`);
      } else {
        ctrls = [...bfs(p, index.importers)].filter((f) => index.controllers.has(f));
      }
      const prefixes = new Set(ctrls.flatMap((c) => index.controllers.get(c)));
      if (prefixes.size >= API_WIDE_PREFIXES) {
        r.fullReasons.push(`${p} — reaches ${prefixes.size} API controllers (${[...prefixes].slice(0, 6).join(', ')}, …)`);
        r.apiFullReasons.push(p);
        continue;
      }
      if (!prefixes.size) { r.unmapped.push({ path: p, note: 'no controller reaches it — unit tests only' }); continue; }
      for (const pre of prefixes) pickApiPrefix(pre, p);
      continue;
    }

    // ── e2e specs and their support ──
    if (p.startsWith(WEB_TESTS)) {
      if (isE2eSpec(p)) {
        if (deleted) r.notes.push(`${p} ${gone}; nothing to run for it`);
        else pick(p, 'the spec itself changed');
        continue;
      }
      const users = deleted ? new Set() : new Set([...bfs(p, index.importers)].filter(isE2eSpec));
      if (users.size >= SUPPORT_WIDE_SPECS) { r.fullReasons.push(`${p} — e2e support used by ${users.size} specs`); continue; }
      if (!users.size) { r.unmapped.push({ path: p, note: 'e2e support no spec imports' }); continue; }
      for (const s of users) pick(s, `imports ${specName(p) || p}`);
      continue;
    }

    // ── web unit tests (source-scanning node tests and vitest) ──
    if (p.startsWith('apps/web/unit/') || p.startsWith('apps/storefront/unit/')) {
      if (!deleted) r.nodeUnit.add(p);
      continue;
    }
    if (isWebUnitTest(p)) { if (!deleted) r.vitest.add(p); continue; }

    // ── i18n ──
    if (LOCALES.includes(p)) {
      const d = diffLocale(ctx.readBase(p), deleted ? null : ctx.read(p));
      for (const s of overrides.i18n ?? []) pick(WEB_TESTS + s, 'i18n override');
      r.webUnitAll = true; // vocabulary/placeholder checks read every key
      if (d.wide) { r.fullReasons.push(`${p} — ${d.wide}`); continue; }
      for (const { key, before, after } of d.changed) {
        for (const v of [literal(before), literal(after)].filter(Boolean)) {
          for (const [s, info] of index.specInfo) if (info.text.includes(v)) pick(s, `asserts "${v}" (${key})`);
        }
        // The pages that render this namespace, unless it is used everywhere.
        const parts = key.split('.');
        const users = new Set();
        for (let i = parts.length - 1; i >= 1; i--) for (const f of index.nsFiles.get(parts.slice(0, i).join('.')) ?? []) users.add(f);
        const routes = new Map();
        for (const f of users) for (const [rt, pg] of index.routesOf(f)) routes.set(rt, pg);
        if (routes.size && routes.size < WEB_WIDE_ROUTES) for (const rt of routes.keys()) pickRoute(rt, `renders ${key}`);
      }
      continue;
    }

    // ── storefront ──
    if (p.startsWith('apps/storefront/')) {
      if (!p.startsWith(STORE_SRC)) { r.unmapped.push({ path: p, note: 'storefront file outside src/' }); continue; }
      for (const [s, info] of index.specInfo) if (info.usesStore) pick(s, `drives the storefront ← ${p}`);
      for (const s of overrides.storefront ?? []) pick(WEB_TESTS + s, 'storefront override');
      continue;
    }

    // ── office web app ──
    if (p.startsWith(WEB_SRC)) {
      pickOverrides(p);
      if (!deleted && isCode(p)) r.vitest.add(p);
      if (deleted) {
        const route = routeOfAppFile(p);
        if (route !== null) pickRoute(route, `${p} (deleted)`);
        else r.notes.push(`${p} ${gone}; its importers changed too and are mapped on their own`);
        continue;
      }
      const routes = index.routesOf(p);
      if (routes.size >= WEB_WIDE_ROUTES) {
        r.fullReasons.push(`${p} — shared by ${routes.size} pages`);
        r.webUnitAll = true;
        continue;
      }
      if (!routes.size) {
        if (![...(overrides.paths ? Object.keys(overrides.paths) : [])].some((o) => p.startsWith(o))) {
          r.unmapped.push({ path: p, note: 'no page imports it' });
        }
        continue;
      }
      for (const [route, page] of routes) pickRoute(route, page === p ? p : `${p} via ${page.slice(APP_DIR.length)}`);
      continue;
    }

    if (p.startsWith('apps/web/')) {
      pickOverrides(p);
      if (!Object.keys(overrides.paths ?? {}).some((o) => p.startsWith(o))) r.unmapped.push({ path: p, note: 'web file outside src/ with no rule' });
      continue;
    }

    r.unmapped.push({ path: p, note: 'no rule for this path' });
  }

  const live = [...r.e2e.keys()].filter((s) => index.specInfo.has(s));
  if (!r.fullReasons.length && live.length >= Math.ceil(index.specs.length * WIDE_SHARE)) {
    r.fullReasons.push(`the selection is ${live.length} of ${index.specs.length} specs — run them all`);
  }
  return finish(r);
}

/** Specs nothing derived can select — they only run with FULL or through the overrides file. */
export function orphanSpecs(index) {
  return [...index.specInfo].filter(([, i]) => !i.routes.size && !i.apiPaths.size && !i.usesStore).map(([s]) => s);
}

function finish(r) {
  const full = r.fullReasons.length > 0;
  return {
    full,
    fullReasons: r.fullReasons,
    jest: { full: r.apiFullReasons.length > 0, files: [...r.jest].sort() },
    vitest: { full: r.webUnitAll, files: [...r.vitest].sort() },
    nodeUnit: [...r.nodeUnit].sort(),
    e2e: full ? [] : [...r.e2e.keys()].sort(),
    e2eReasons: Object.fromEntries([...r.e2e].sort()),
    self: r.self,
    unmapped: r.unmapped,
    ignored: r.ignored,
    notes: r.notes,
  };
}

// ── git input ────────────────────────────────────────────────────────────────
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [st, a, b] = line.split('\t');
    const s = st[0];
    if (s === 'R' || s === 'C') out.push({ status: s === 'R' ? 'R' : 'A', path: b, oldPath: s === 'R' ? a : undefined });
    else out.push({ status: s, path: a });
  }
  return out;
}

export function gitChanges({ base = 'dev', commit = null, repo = REPO } = {}) {
  if (commit) {
    return { label: `commit ${commit}`, changes: parseNameStatus(gitOut(['diff', '--name-status', '-M', `${commit}^`, commit], repo)), baseRef: `${commit}^` };
  }
  const mb = gitOut(['merge-base', base, 'HEAD'], repo).trim();
  const changes = parseNameStatus(gitOut(['diff', '--name-status', '-M', mb], repo));
  const seen = new Set(changes.map((c) => c.path));
  for (const f of gitOut(['ls-files', '--others', '--exclude-standard'], repo).split('\n')) {
    if (f && !seen.has(f)) changes.push({ status: 'A', path: f });
  }
  return { label: `${base} (merge-base ${mb.slice(0, 7)}), including uncommitted and untracked`, changes, baseRef: mb };
}

// ── output ───────────────────────────────────────────────────────────────────
const apiRel = (p) => p.slice('apps/api/'.length);
const webRel = (p) => p.slice('apps/web/'.length);

export function commands(sel) {
  const cmds = {};
  if (sel.jest.full) cmds.jest = 'cd apps/api && npx jest';
  else if (sel.jest.files.length) cmds.jest = `cd apps/api && npx jest --findRelatedTests ${sel.jest.files.map(apiRel).join(' ')}`;
  if (sel.vitest.full) cmds.vitest = 'cd apps/web && npx vitest run && node --test unit/*.test.mjs';
  else if (sel.vitest.files.length) cmds.vitest = `cd apps/web && npx vitest related --run ${sel.vitest.files.map(webRel).join(' ')}`;
  if (sel.nodeUnit.length) cmds.nodeUnit = sel.nodeUnit.map((f) => { const [, app, rest] = f.match(/^apps\/([^/]+)\/(.*)$/); return `(cd apps/${app} && node --test ${rest})`; }).join(' && ');
  if (sel.self) cmds.self = 'node --test scripts/affected-tests.test.mjs';
  if (sel.full) cmds.e2e = 'cd apps/web && npx playwright test';
  else if (sel.e2e.length) cmds.e2e = `cd apps/web && npx playwright test ${sel.e2e.map(webRel).join(' ')}`;
  return cmds;
}

function jestList(sel, repo) {
  const bin = path.join(repo, 'apps/api/node_modules/.bin/jest');
  if (!sel.jest.files.length || sel.jest.full || !fs.existsSync(bin)) return null;
  const res = spawnSync(bin, ['--listTests', '--findRelatedTests', ...sel.jest.files.map(apiRel)], { cwd: path.join(repo, 'apps/api'), encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.split('\n').filter(Boolean).map((f) => path.relative(path.join(repo, 'apps/api'), f)).sort();
}

export function format(sel, { label, total, jestSpecs, showWhy = true }) {
  const c = commands(sel);
  const out = [`Changed: ${total} file(s) vs ${label}`, ''];
  if (!Object.keys(c).length) {
    out.push('Nothing to run.');
  }
  if (c.jest) {
    out.push(`API unit (Jest)${sel.jest.full ? ': FULL' : jestSpecs ? `: ${jestSpecs.length} spec(s)` : ''}`);
    out.push(`  ${c.jest}`);
    if (jestSpecs) for (const s of jestSpecs) out.push(`    · ${s}`);
    else if (!sel.jest.full) out.push('    (apps/api/node_modules missing — the command still picks the related specs when run)');
    out.push('');
  }
  if (c.vitest || c.nodeUnit) {
    out.push(`Web unit${sel.vitest.full ? ': FULL' : ''}`);
    if (c.vitest) out.push(`  ${c.vitest}`);
    if (c.nodeUnit) out.push(`  ${c.nodeUnit}`);
    out.push('');
  }
  if (c.self) out.push('This script\'s own tests', `  ${c.self}`, '');
  if (c.e2e) {
    out.push(`E2E (Playwright)${sel.full ? ': FULL' : `: ${sel.e2e.length} spec(s)`} — never run from here; only when the owner asks`);
    out.push(`  ${c.e2e}`);
    if (sel.full) for (const why of sel.fullReasons) out.push(`    FULL because ${why}`);
    else if (showWhy) for (const [s, why] of Object.entries(sel.e2eReasons)) out.push(`    · ${specName(s)}: ${why}`);
    out.push('');
  }
  if (sel.unmapped.length) {
    out.push('Unmapped (no rule covers these — decide yourself):');
    for (const u of sel.unmapped) out.push(`  ${u.path} — ${u.note}`);
    out.push('');
  }
  for (const n of sel.notes) out.push(`Note: ${n}`);
  if (sel.ignored.length) out.push(`Ignored (docs/config with no tests): ${sel.ignored.length} file(s)`);
  return out.join('\n').trimEnd();
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const opt = (f) => { const i = args.indexOf(f); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } return null; };
  if (flag('--help') || flag('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    return 0;
  }
  const run = flag('--run');
  const json = flag('--json');
  const quiet = flag('--quiet');
  const commit = opt('--commit');
  let changes, label, baseRef;
  const fi = args.indexOf('--files');
  if (fi >= 0) {
    changes = args.slice(fi + 1).map((p) => ({ status: 'M', path: p }));
    label = 'the given file list';
    baseRef = 'HEAD';
  } else {
    ({ changes, label, baseRef } = gitChanges({ base: args[0] ?? 'dev', commit }));
  }
  const ctx = realContext(REPO, baseRef);
  const sel = selectTests(changes, ctx);
  const jestSpecs = jestList(sel, REPO);
  if (json) console.log(JSON.stringify({ ...sel, jestSpecs, commands: commands(sel) }, null, 2));
  else console.log(format(sel, { label, total: changes.length, jestSpecs, showWhy: !quiet }));

  if (run) {
    const c = commands(sel);
    if (!c.jest) { console.log('\n--run: no Jest tests to run.'); return 0; }
    console.log(`\n--run: ${c.jest}  (e2e is never run from here)\n`);
    const jestArgs = sel.jest.full ? [] : ['--findRelatedTests', ...sel.jest.files.map(apiRel)];
    const res = spawnSync('npx', ['jest', ...jestArgs], { cwd: path.join(REPO, 'apps/api'), stdio: 'inherit' });
    return res.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
