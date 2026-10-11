/**
 * Who sees which menu entry (U4c). The menu does not decide permissions: each
 * entry shows a role exactly when the API endpoint its page lists from lets
 * that role in. So these tests read the `@Roles` straight out of the API's
 * controllers and compare — a controller narrowed or widened without the menu
 * following fails here, instead of showing up as a 403 on a page the menu
 * offered, or a page nobody can find (rule 11, rule 12).
 *
 * Run with `npm run test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  NAV_GROUPS,
  SYSTEM_ITEMS,
  navForRole,
  systemForRole,
  phoneBarItems,
} from '../src/components/layout/nav-model.ts';

const API = join(dirname(fileURLToPath(import.meta.url)), '../../api/src/modules');
const keys = (items) => items.map((i) => i.key);
const menuKeys = (role) => [
  ...navForRole(role).flatMap((g) => keys(g.items)),
  ...keys(systemForRole(role)),
];
const ALL = [...NAV_GROUPS.flatMap((g) => g.items), ...SYSTEM_ITEMS];

// ─── Reading @Roles out of a controller ─────────────────────────────────

/** The decorator lines touching line `i`, walking in `step` direction. */
function decoratorsFrom(lines, i, step) {
  const out = [];
  for (let j = i + step; j >= 0 && j < lines.length; j += step) {
    const l = lines[j].trim();
    if (!l.startsWith('@')) break;
    out.push(l);
  }
  return out;
}

/**
 * `@Roles('A', 'B')`, or `@Roles(...LIST)` with LIST a constant exported from a
 * file beside the controller (payments: `payment-roles.ts`, I2). The spread
 * read as no roles at all, so the test failed on a list that was correct.
 */
const rolesIn = (decorators, dir) => {
  const d = decorators.find((l) => l.startsWith('@Roles('));
  if (!d) return null;
  const roles = [...d.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  for (const [, name] of d.matchAll(/\.\.\.([A-Z_]+)/g)) roles.push(...constantRoles(dir, name));
  return roles.sort();
};

/** The string literals of `export const <name> = [...]` in any .ts file of `dir`. */
function constantRoles(dir, name) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const m = readFileSync(join(dir, f), 'utf8').match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
    if (m) return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  }
  assert.fail(`@Roles(...${name}): no "export const ${name} = [...]" beside the controller in ${dir}`);
}
const guarded = (decorators) =>
  decorators.some((l) => l.startsWith('@UseGuards(') && l.includes('RolesGuard'));

/**
 * The roles that may call `GET <route>` on class `cls` in `file`, as the
 * RolesGuard would decide them: the handler's `@Roles` over the class's, and
 * no roles at all (null — any signed-in account) when no RolesGuard is on
 * either, since `@Roles` without the guard enforces nothing.
 */
function endpointRoles(file, cls, route) {
  const lines = readFileSync(join(API, file), 'utf8').split('\n');
  const classLine = lines.findIndex((l) => l.startsWith(`export class ${cls} `));
  assert.ok(classLine >= 0, `${cls} not found in ${file}`);
  let end = lines.findIndex((l, i) => i > classLine && l.startsWith('export class '));
  if (end < 0) end = lines.length;

  const get = route ? `@Get('${route}')` : '@Get()';
  const getLine = lines.findIndex((l, i) => i > classLine && i < end && l.trim() === get);
  assert.ok(getLine >= 0, `${get} not found on ${cls}`);

  const onClass = decoratorsFrom(lines, classLine, -1);
  const onMethod = [...decoratorsFrom(lines, getLine, -1), ...decoratorsFrom(lines, getLine, 1)];
  if (!guarded(onClass) && !guarded(onMethod)) return null;
  const dir = dirname(join(API, file));
  return rolesIn(onMethod, dir) ?? rolesIn(onClass, dir);
}

/** Each entry's page, and the endpoint it lists from. */
const SOURCES = {
  // The part of the dashboard every role loads: an investor's dashboard lists
  // their cycles' profitability instead of the business-wide figures (R1).
  dashboard: ['analytics/analytics.controller.ts', 'AnalyticsController', 'cycle-profitability'],
  analytics: ['analytics/analytics.controller.ts', 'AnalyticsController', 'revenue-by-month'],
  cycles: ['cycles/cycles.controller.ts', 'CyclesController', ''],
  purchases: ['purchases/purchases.controller.ts', 'PurchasesController', ''],
  suppliers: ['suppliers/suppliers.controller.ts', 'SuppliersController', ''],
  shipments: ['shipping/shipping.controller.ts', 'ShippingController', 'legs'],
  providers: ['providers/providers.controller.ts', 'ProvidersController', ''],
  products: ['products/products.controller.ts', 'ProductsController', ''],
  categories: ['products/products.controller.ts', 'CategoriesController', ''],
  inventory: ['inventory/inventory.controller.ts', 'InventoryController', 'inventory'],
  orderRequests: ['portal/order-requests.controller.ts', 'OrderRequestsController', 'pending'],
  importRequests: ['portal/order-requests-imports.controller.ts', 'ImportRequestsAdminController', ''],
  sales: ['sales/sales.controller.ts', 'SalesController', ''],
  customers: ['customers/customers.controller.ts', 'CustomersController', ''],
  payments: ['payments/payments.controller.ts', 'PaymentsController', ''],
  paymentPlans: ['payment-plans/payment-plans.controller.ts', 'PaymentPlansController', ''],
  ledger: ['ledger/ledger.controller.ts', 'LedgerController', ''],
  partners: ['users/users.controller.ts', 'UsersController', 'participation'],
  settlements: ['settlements/settlements.controller.ts', 'SettlementsController', ''],
  notifications: ['notifications/notifications.controller.ts', 'NotificationsController', ''],
  auditLogs: ['audit/audit.controller.ts', 'AuditController', ''],
  settings: ['auth/auth.controller.ts', 'AuthController', 'profile'],
};

// ─── The menu mirrors the API ───────────────────────────────────────────

test('every menu entry names the endpoint its page lists from', () => {
  assert.deepEqual(keys(ALL).sort(), Object.keys(SOURCES).sort());
});

for (const item of ALL) {
  test(`${item.key}: the menu shows it to exactly the roles its endpoint lets in`, () => {
    const [file, cls, route] = SOURCES[item.key];
    const api = endpointRoles(file, cls, route);
    const menu = item.roles ? [...item.roles].sort() : null;
    assert.deepEqual(menu, api, `${item.key} → ${cls} GET ${route || '/'}`);
  });
}

// ─── What each role is offered ──────────────────────────────────────────

test('a core partner sees all 22 entries', () => {
  assert.equal(menuKeys('CORE_PARTNER').length, 22);
});

test('admin support sees all 22 entries — every restricted endpoint lets them read', () => {
  assert.deepEqual(menuKeys('ADMIN_SUPPORT'), menuKeys('CORE_PARTNER'));
});

// R1 (owner, 2026-10-10): an investor sees only their own cycles — the
// importing and catalogue pages (each scoped by the API) and their cycles'
// settlements. No analytics, customers or payment plans.
const INVESTOR_MENU = [
  'dashboard',
  'cycles', 'purchases', 'suppliers', 'shipments', 'providers',
  'products', 'categories', 'inventory',
  'settlements',
  'notifications', 'settings',
];

/** What any signed-in role is offered: the entries naming no roles. */
const OPEN_MENU = INVESTOR_MENU.filter((k) => k !== 'settlements');

test('a temporary investor sees only the entries whose endpoints let them in', () => {
  assert.deepEqual(menuKeys('TEMP_INVESTOR'), INVESTOR_MENU);
});

test('a temporary investor is not offered analytics, customers, sales, money, partners or the audit log', () => {
  const seen = menuKeys('TEMP_INVESTOR');
  for (const k of ['analytics', 'orderRequests', 'importRequests', 'sales', 'customers',
    'payments', 'paymentPlans', 'ledger', 'partners', 'auditLogs']) {
    assert.ok(!seen.includes(k), k);
  }
});

test('the partners group keeps only Settlements for an investor, and no group is left empty', () => {
  const partners = navForRole('TEMP_INVESTOR').find((g) => g.key === 'partners');
  assert.deepEqual(keys(partners.items), ['settlements']);
  for (const g of navForRole('TEMP_INVESTOR')) assert.ok(g.items.length > 0, g.key);
});

test("an investor's phone bar drops Sales and Customers and closes the gap", () => {
  assert.deepEqual(keys(phoneBarItems('TEMP_INVESTOR')), [
    'dashboard', 'inventory', 'cycles',
  ]);
});

test('a shop account is offered nothing an endpoint refuses it', () => {
  // The office login refuses SHOP_OWNER_PORTAL outright; this is the second
  // line, should a portal token ever reach the shell.
  for (const k of menuKeys('SHOP_OWNER_PORTAL')) {
    const item = ALL.find((i) => i.key === k);
    assert.ok(!item.roles, k);
  }
});

test('every role, and a role still loading, keeps the Dashboard and Settings', () => {
  for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', 'SOMETHING_NEW', undefined]) {
    const seen = menuKeys(role);
    assert.ok(seen.includes('dashboard'), String(role));
    assert.ok(seen.includes('settings'), String(role));
  }
});

test('a role the app has never heard of sees no restricted entry', () => {
  assert.deepEqual(menuKeys('SOMETHING_NEW'), OPEN_MENU);
  assert.deepEqual(menuKeys(undefined), OPEN_MENU);
});

test('for every role the phone bar is a subset of that role\'s menu', () => {
  for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', undefined]) {
    const menu = menuKeys(role);
    for (const k of keys(phoneBarItems(role))) assert.ok(menu.includes(k), `${role}: ${k}`);
  }
});
