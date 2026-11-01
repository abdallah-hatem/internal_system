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
 *
 * Visual regression (apps/web/tests/visual*.spec.ts, opt-in with VISUAL=1) is its own section:
 *  - each visual test is read from the spec itself: its screen name ("sales list"), the route it
 *    ends on (page.goto, then any toHaveURL — "cycles/[id]"), its baseline name, whether it
 *    captures a dialog; the page files of that route are the screen's;
 *  - a web file selects the screens whose page files it reaches, the same import graph as above
 *    but exact per screen, so a component shared by many pages is not "all visual" unless it
 *    reaches every screen. A file that only renders inside an open dialog (every value it
 *    exports is a *Dialog* component) is a wall: what is reached only through it is never on a
 *    closed page's screenshot. A dialog screen also takes the files its dialog renders
 *    (overrides.visual: the roots, and everything they import);
 *  - the FULL rules, a wide API file and a structural i18n change select every visual test; the
 *    storefront selects the storefront visual spec; a changed visual spec selects all its tests,
 *    a changed baseline PNG the one test that owns it; i18n values select the screens of the
 *    namespace's files.
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
// Mirrors playwright.config.ts: `visual*.spec.ts` only runs with VISUAL=1, so it is not an e2e spec here.
const isVisualSpec = (p) => /^apps\/web\/tests\/visual[^/]*\.spec\.ts$/.test(p);
const isE2eSpec = (p) => p.startsWith(WEB_TESTS) && /^[^/]+\.spec\.ts$/.test(p.slice(WEB_TESTS.length)) && !isVisualSpec(p);
// A committed baseline: apps/web/tests/visual.spec.ts-snapshots/sales-ar-chromium-darwin.png
const VISUAL_PNG_RE = /^(apps\/web\/tests\/visual[^/]*\.spec\.ts)-snapshots\/(.+?)-[a-z0-9]+-(?:darwin|linux|win32)\.png$/;
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

  index.visual = buildVisual(ctx, files, imports, importers);
  return index;
}

// ── visual screens, read from the visual specs ───────────────────────────────
const TEST_RE = /\btest\(\s*(['"`])(.+?)\1\s*,/g;
const GOTO_RE = /\.goto\(\s*`\$\{\s*([A-Z]+)\s*\}([^`]*)`/g;
const URL_RE = /toHaveURL\(\s*\/(.+?)\/[a-z]*\s*\)/g;
const SNAP_RE = /\bsnap\(\s*page\s*,\s*(['"`])([^'"`]+)\1/g;
const LOCALE_VAR = '${locale}';

/** "/${locale}/sales?status=ALL" -> ["sales"]; the regex source "\/cycles\/[^/?]+" -> ["cycles", "[]"] */
function routeSegments(gotoPath, urlRegex) {
  if (urlRegex) {
    return urlRegex.split('\\/').filter(Boolean).map((seg) => (/^[a-z][a-z0-9-]*$/.test(seg) ? seg : '[]'));
  }
  return gotoPath.split('?')[0].split('/').filter(Boolean).filter((seg) => seg !== LOCALE_VAR && seg !== 'en' && seg !== 'ar');
}

/** True when nothing this file exports can render outside an open dialog. */
export function isOverlayOnly(src) {
  if (!src) return false;
  const names = [];
  for (const m of src.matchAll(/^export\s+(default\s+)?(?:async\s+)?(function\*?|const|let|var|class|type|interface|enum|\{|\*)\s*([A-Za-z_$][\w$]*)?/gm)) {
    if (m[1] || m[2] === '{' || m[2] === '*') return false; // a default or re-export: cannot tell
    if (m[2] === 'type' || m[2] === 'interface') continue;
    names.push(m[3]);
  }
  return names.length > 0 && names.every((n) => /^[A-Z]\w*Dialog\w*$/.test(n) || /^Dialog\w*$/.test(n));
}

function buildVisual(ctx, files, imports, importers) {
  const fileSet = new Set(files);
  const roots = ctx.overrides?.visual ?? {};
  const specs = files.filter(isVisualSpec).sort();
  const screens = [];
  const preconditions = new Map();
  for (const spec of specs) {
    const src = ctx.read(spec) ?? '';
    const locales = [...(src.match(/const LOCALES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "'en','ar'").matchAll(/['"](\w+)['"]/g)].map((m) => m[1]);
    const frozen = src.match(/FROZEN_NOW\s*=\s*new Date\(\s*['"]([^'"]+)['"]/)?.[1];
    // The message the spec fails with when the API was not started at FROZEN_NOW, word for word.
    const msg = src.match(/`[^`]*Start it at[^`]*`(?:\s*\+\s*`[^`]*`)*/)?.[0];
    if (msg && frozen) {
      const iso = new Date(frozen).toISOString();
      preconditions.set(spec, msg.split(/`\s*\+\s*`/).join('').replace(/^`|`$/g, '').replace(/^[\s\S]*?(?=Start it at)/, '').replace(/\$\{FROZEN_NOW\.toISOString\(\)\}/g, iso));
    }
    const heads = [...src.matchAll(TEST_RE)];
    const byName = new Map();
    heads.forEach((h, i) => {
      const body = src.slice(h.index, heads[i + 1]?.index ?? src.length);
      const title = h[2];
      const name = title.replace(/\s*·\s*(?:\$\{locale\}|en|ar)$/, '');
      const titleLocales = title.includes(LOCALE_VAR) ? locales : [title.match(/·\s*(en|ar)$/)?.[1] ?? null];
      const gotos = [...body.matchAll(GOTO_RE)];
      const last = gotos.at(-1);
      const url = [...body.matchAll(URL_RE)].filter((u) => !last || u.index > last.index).at(-1);
      const route = last ? routeSegments(last[2], url?.[1]) : [];
      const snapName = body.match(SNAP_RE)?.[0]?.match(/(['"`])([^'"`]+)\1/)?.[2] ?? null;
      const overlay = /getByRole\(\s*['"]dialog['"]/.test(body) && /target:\s*dialog/.test(body);
      if (!byName.has(name)) {
        byName.set(name, {
          spec, name, base: last?.[1] ?? null, route, overlay, tests: [],
          storefront: /storefront\.spec\.ts$/.test(spec),
        });
      }
      for (const loc of titleLocales) {
        byName.get(name).tests.push({
          spec, screen: name, locale: loc,
          title: loc ? title.replace(LOCALE_VAR, loc) : title,
          snapshot: snapName ? (loc ? snapName.replace(LOCALE_VAR, loc) : snapName) : null,
        });
      }
    });
    screens.push(...byName.values());
  }

  // Office screens: the page files of the route they end on.
  for (const s of screens) {
    s.pageFiles = new Set();
    if (s.storefront || s.base !== 'BASE') continue;
    let dir = APP_DIR;
    const chain = [];
    const names = [];
    let ok = true;
    for (const seg of s.route) {
      const prefix = dir;
      const next = seg === '[]'
        ? files.find((f) => f.startsWith(prefix) && /^\[[^/]+\]\//.test(f.slice(prefix.length)))?.slice(prefix.length).split('/')[0]
        : seg;
      if (!next || !files.some((f) => f.startsWith(`${prefix}${next}/`))) { ok = false; break; }
      chain.push(dir);
      names.push(next);
      dir = `${prefix}${next}/`;
    }
    s.resolved = ok && s.route.length > 0;
    s.routePath = (ok ? names : s.route).join('/');
    if (!s.resolved) continue;
    s.routeDir = dir;
    for (const f of files) {
      if (!f.startsWith(dir) || !isCode(f) || /\.test\./.test(f)) continue;
      if (!f.slice(dir.length).includes('/')) s.pageFiles.add(f);
    }
    // The layouts of the folders above it render around it too: what the root layouts import (the
    // app shell, the sidebar) is on every office screen, though no page imports it.
    for (const up of ['apps/web/src/app/', ...chain]) {
      for (const f of files) if (f.startsWith(up) && /^(layout|template|loading|error|not-found)\.tsx?$/.test(f.slice(up.length))) s.pageFiles.add(f);
    }
    // A dialog screen also shows what its dialog renders: overrides.visual names the roots.
    s.renders = new Set();
    for (const root of roots[s.name] ?? []) for (const f of bfs(root, imports)) if (fileSet.has(f)) s.renders.add(f);
  }

  const overlayCache = new Map();
  const overlayOnly = (f) => {
    if (!overlayCache.has(f)) overlayCache.set(f, /\.tsx$/.test(f) && f.startsWith(WEB_SRC) && isOverlayOnly(ctx.read(f)));
    return overlayCache.get(f);
  };

  /** Map(screen -> how) for an office web file that exists. */
  const screensOf = (f) => {
    // Up the importers, never through a dialog-only file: past it, things render only when it is open.
    const seen = new Set([f]);
    const queue = [f];
    while (queue.length) {
      const n = queue.shift();
      if (overlayOnly(n)) continue;
      for (const next of importers.get(n) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    const out = new Map();
    for (const s of screens) {
      if (!s.resolved) continue;
      const page = [...s.pageFiles].find((pf) => seen.has(pf));
      if (page) out.set(s, page === f ? `on /${s.routePath}` : `on /${s.routePath} via ${page.slice(APP_DIR.length)}`);
      else if (s.overlay && s.renders.has(f)) out.set(s, `rendered in the ${s.name}`);
    }
    return out;
  };

  return { specs, screens, preconditions, screensOf, overlayOnly };
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
  // Visual: tests picked by `${spec}\t${title}`, or every one of them.
  const V = index.visual;
  const vis = { all: [], picked: new Map() };
  const vPickScreen = (s, why) => { for (const t of s.tests) { const k = `${t.spec}\t${t.title}`; if (!vis.picked.has(k)) vis.picked.set(k, `${t.screen}: ${why}`); } };
  const vPickSpec = (spec, why) => { for (const s of V.screens) if (s.spec === spec) vPickScreen(s, why); };
  const vPickFile = (f, why) => { for (const [s, how] of V.screensOf(f)) vPickScreen(s, `${how} ← ${why}`); };
  const vPickRoute = (route, why) => { for (const s of V.screens) if (s.resolved && s.route[0] === route) vPickScreen(s, `on /${route} ← ${why}`); };
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
      if (hit(call)) for (const route of routes) { pickRoute(route, `page calls /${prefix} ← ${why}`); vPickRoute(route, `page calls /${prefix} ← ${why}`); }
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
      vis.all.push(`${p} — ${wide[1]}`);
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
        vis.all.push(`${p} — reaches ${prefixes.size} API controllers`);
        r.apiFullReasons.push(p);
        continue;
      }
      if (!prefixes.size) { r.unmapped.push({ path: p, note: 'no controller reaches it — unit tests only' }); continue; }
      for (const pre of prefixes) pickApiPrefix(pre, p);
      continue;
    }

    // ── e2e specs and their support ──
    if (p.startsWith(WEB_TESTS)) {
      if (isVisualSpec(p)) {
        if (deleted) r.notes.push(`${p} ${gone}; nothing to run for it`);
        else vPickSpec(p, 'the visual spec itself changed');
        continue;
      }
      const png = p.match(VISUAL_PNG_RE);
      if (png) {
        const owner = V.screens.flatMap((s) => s.tests).find((t) => t.spec === png[1] && t.snapshot === png[2]);
        if (owner) vis.picked.set(`${owner.spec}\t${owner.title}`, `${owner.screen}: its baseline ${png[2]}.png ${deleted ? 'was deleted' : 'changed'}`);
        else r.unmapped.push({ path: p, note: 'a visual baseline no test takes (stale, or a renamed test?)' });
        continue;
      }
      if (isE2eSpec(p)) {
        if (deleted) r.notes.push(`${p} ${gone}; nothing to run for it`);
        else pick(p, 'the spec itself changed');
        continue;
      }
      const reached = deleted ? new Set() : bfs(p, index.importers);
      const users = new Set([...reached].filter(isE2eSpec));
      if (users.size >= SUPPORT_WIDE_SPECS) {
        r.fullReasons.push(`${p} — e2e support used by ${users.size} specs`);
        vis.all.push(`${p} — e2e support used by ${users.size} specs`);
        continue;
      }
      const vUsers = [...reached].filter(isVisualSpec);
      for (const v of vUsers) vPickSpec(v, `imports ${specName(p)}`);
      if (!users.size && !vUsers.length) { r.unmapped.push({ path: p, note: 'e2e support no spec imports' }); continue; }
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
      if (d.wide) { r.fullReasons.push(`${p} — ${d.wide}`); vis.all.push(`${p} — ${d.wide}`); continue; }
      for (const { key, before, after } of d.changed) {
        for (const v of [literal(before), literal(after)].filter(Boolean)) {
          for (const [s, info] of index.specInfo) if (info.text.includes(v)) pick(s, `asserts "${v}" (${key})`);
        }
        // The pages that render this namespace, unless it is used everywhere.
        const parts = key.split('.');
        const users = new Set();
        for (let i = parts.length - 1; i >= 1; i--) for (const f of index.nsFiles.get(parts.slice(0, i).join('.')) ?? []) users.add(f);
        // Visual: the screens those files are on, both locales (the screen name matches both).
        for (const f of users) vPickFile(f, `renders ${key}`);
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
      for (const s of V.screens) if (s.storefront) vPickScreen(s, `storefront ← ${p}`);
      for (const s of overrides.storefront ?? []) pick(WEB_TESTS + s, 'storefront override');
      continue;
    }

    // ── office web app ──
    if (p.startsWith(WEB_SRC)) {
      pickOverrides(p);
      if (!deleted && isCode(p)) r.vitest.add(p);
      if (deleted) {
        const route = routeOfAppFile(p);
        if (route !== null) { pickRoute(route, `${p} (deleted)`); vPickRoute(route, `${p} (deleted)`); }
        else r.notes.push(`${p} ${gone}; its importers changed too and are mapped on their own`);
        continue;
      }
      const routes = index.routesOf(p);
      // Visual is exact per screen, so even a file shared by every page picks only the screens it reaches.
      vPickFile(p, p);
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
  return finish(r, visualSelection(vis, V));
}

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The visual tests picked, and the one command that runs exactly them. */
function visualSelection(vis, V) {
  const every = V.screens.flatMap((s) => s.tests);
  const full = vis.all.length > 0;
  const chosen = full ? every : every.filter((t) => vis.picked.has(`${t.spec}\t${t.title}`));
  const out = {
    full, fullReasons: vis.all,
    tests: chosen.map((t) => ({ spec: t.spec, title: t.title, why: full ? 'FULL' : vis.picked.get(`${t.spec}\t${t.title}`) })),
    command: null, precondition: null,
  };
  if (!chosen.length) return out;
  const set = new Set(chosen);
  const specs = V.specs.filter((sp) => chosen.some((t) => t.spec === sp));
  if (specs.length === V.specs.length && chosen.length === every.length) out.command = 'npm run test:visual';
  else {
    const whole = (sp) => every.filter((t) => t.spec === sp).every((t) => set.has(t));
    let grep = '';
    if (!specs.every(whole)) {
      // A screen with every locale picked is matched by its name (both locales), else by the test title.
      const pats = [];
      for (const s of V.screens) {
        if (!specs.includes(s.spec)) continue;
        if (s.tests.every((t) => set.has(t))) pats.push(escRe(s.name));
        else for (const t of s.tests) if (set.has(t)) pats.push(escRe(t.title));
      }
      grep = ` -g "${pats.join('|')}"`;
    }
    out.command = `cd apps/web && VISUAL=1 npx playwright test ${specs.map(webRel).join(' ')}${grep}`;
  }
  const pre = specs.map((sp) => V.preconditions.get(sp)).filter(Boolean);
  if (pre.length) out.precondition = pre[0];
  return out;
}

/** Specs nothing derived can select — they only run with FULL or through the overrides file. */
export function orphanSpecs(index) {
  return [...index.specInfo].filter(([, i]) => !i.routes.size && !i.apiPaths.size && !i.usesStore).map(([s]) => s);
}

function finish(r, visual) {
  const full = r.fullReasons.length > 0;
  return {
    visual,
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
  if (sel.visual?.command) cmds.visual = sel.visual.command;
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
  if (sel.visual.command) {
    const v = sel.visual;
    const screens = [...new Set(v.tests.map((t) => t.title.replace(/\s*·\s*(en|ar)$/, '')))];
    out.push(`Visual (VISUAL=1)${v.full ? ': FULL' : `: ${v.tests.length} test(s), ${screens.length} screen(s)`} — never run from here; only when the owner asks`);
    out.push(`  ${v.command}`);
    if (v.full) for (const why of v.fullReasons) out.push(`    FULL because ${why}`);
    else if (showWhy) for (const why of new Set(v.tests.map((t) => t.why))) out.push(`    · ${why}`);
    if (v.precondition) {
      out.push('  Needs the API started at the frozen clock — visual.spec.ts refuses to run otherwise:');
      out.push(`    ${v.precondition}`);
    }
    out.push('  (in an agent environment, with that environment\'s exports: scripts/agent-servers.sh)');
    out.push('');
  } else if (total > 0) {
    out.push('Visual: no visual screen shows this change — nothing to run.', '');
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
