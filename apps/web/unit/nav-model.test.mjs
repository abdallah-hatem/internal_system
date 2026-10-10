/**
 * The navigation model: what the phone bar offers, and that it never offers a
 * page the role's own menu hides. Run with `npm run test:unit` (Node's own
 * runner — the module imports nothing, so it loads without a bundler).
 *
 * The restricted cases near the top build their own menu to prove the bar
 * follows a restriction. The real menu's restrictions are checked per role in
 * `nav-roles.test.mjs`, against the API controllers they mirror.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_GROUPS,
  SYSTEM_ITEMS,
  PHONE_BAR_KEYS,
  navForRole,
  phoneBarItems,
  systemForRole,
  isActiveHref,
  isMoreActive,
} from '../src/components/layout/nav-model.ts';

const keys = (items) => items.map((i) => i.key);
const allKeys = (groups) => groups.flatMap((g) => keys(g.items));

test('the phone bar is Dashboard, Sales, Customers, Inventory, Cycles, in that order', () => {
  assert.deepEqual(keys(phoneBarItems('CORE_PARTNER')), [
    'dashboard', 'sales', 'customers', 'inventory', 'cycles',
  ]);
  assert.equal(phoneBarItems('CORE_PARTNER').find((i) => i.key === 'cycles').href, '/cycles');
});

test('every phone-bar key is a real menu entry — a renamed key cannot vanish silently', () => {
  for (const k of PHONE_BAR_KEYS) assert.ok(allKeys(NAV_GROUPS).includes(k), k);
});

test('"More" holds the whole menu, grouped as the sidebar is, bar entries included', () => {
  const groups = navForRole('CORE_PARTNER');
  assert.deepEqual(groups.map((g) => g.key), NAV_GROUPS.map((g) => g.key));
  assert.equal(allKeys(groups).length, 22 - SYSTEM_ITEMS.length);
  assert.equal(allKeys(groups).length + systemForRole('CORE_PARTNER').length, 22);
});

const restricted = [
  { key: 'overview', items: [{ key: 'dashboard', href: '/dashboard' }] },
  {
    key: 'selling',
    items: [
      { key: 'sales', href: '/sales', roles: ['CORE_PARTNER'] },
      { key: 'customers', href: '/customers', roles: ['CORE_PARTNER'] },
    ],
  },
  { key: 'catalogue', items: [{ key: 'inventory', href: '/inventory' }] },
  { key: 'importing', items: [{ key: 'cycles', href: '/cycles', roles: ['CORE_PARTNER', 'TEMP_INVESTOR'] }] },
];

test('an investor is not offered a bar entry their menu hides', () => {
  assert.deepEqual(keys(phoneBarItems('TEMP_INVESTOR', restricted)), ['dashboard', 'inventory', 'cycles']);
});

test('the bar is always a subset of the menu, for every role', () => {
  for (const role of ['CORE_PARTNER', 'TEMP_INVESTOR', 'SHOP', undefined]) {
    const menu = allKeys(navForRole(role, restricted));
    for (const k of keys(phoneBarItems(role, restricted))) assert.ok(menu.includes(k), `${role}: ${k}`);
  }
});

test('a group emptied by the role disappears rather than showing a bare heading', () => {
  assert.deepEqual(navForRole('TEMP_INVESTOR', restricted).map((g) => g.key), ['overview', 'catalogue', 'importing']);
});

test('no role yet (still loading) sees nothing restricted', () => {
  assert.deepEqual(keys(phoneBarItems(undefined, restricted)), ['dashboard', 'inventory']);
});

test('a role the menu does not know sees only unrestricted entries', () => {
  assert.deepEqual(keys(phoneBarItems('SOMETHING_NEW', restricted)), ['dashboard', 'inventory']);
});

test('active state matches whole path segments: /sales/x lights Sales, /salesman does not', () => {
  assert.ok(isActiveHref('/sales/abc', '/sales'));
  assert.ok(!isActiveHref('/salesman', '/sales'));
});

test('"More" is lit only on a page the bar does not reach', () => {
  const bar = phoneBarItems('CORE_PARTNER');
  assert.ok(!isMoreActive('/customers/123', bar));
  assert.ok(isMoreActive('/payments', bar));
  assert.ok(isMoreActive('/settings', bar));
});
