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
  const groups = navForRole('CORE_PARTNER', NAV_GROUPS, ['requests']);
  assert.deepEqual(groups.map((g) => g.key), NAV_GROUPS.map((g) => g.key));
  assert.equal(allKeys(groups).length, 14 - SYSTEM_ITEMS.length);
  assert.equal(allKeys(groups).length + systemForRole('CORE_PARTNER').length, 14);
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

// Instalment plans are the second tab of Payments (owner, 2026-10-16), not an
// entry of their own: no role's menu lists them, and no entry links to the old page.
test('no menu lists Payment Plans; Payments is still there for the roles that read the books', () => {
  const everything = [...allKeys(NAV_GROUPS), ...keys(SYSTEM_ITEMS)];
  assert.ok(!everything.includes('paymentPlans'));
  const hrefs = [...NAV_GROUPS.flatMap((g) => g.items), ...SYSTEM_ITEMS].map((i) => i.href);
  assert.ok(!hrefs.some((h) => h.startsWith('/payment-plans')), hrefs.join(' '));
  for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR']) {
    assert.ok(!allKeys(navForRole(role)).includes('paymentPlans'), role);
  }
  assert.ok(allKeys(navForRole('CORE_PARTNER')).includes('payments'));
});

// Order requests and import requests are two tabs of one Requests page (owner,
// 2026-10-17), hidden in production for now (lib/features.ts).
test('with Requests switched on, the menu has one Requests entry and neither of the two it replaced', () => {
  const menu = allKeys(navForRole('CORE_PARTNER', NAV_GROUPS, ['requests']));
  assert.deepEqual(menu.filter((k) => /requests/i.test(k)), ['requests']);
  const hrefs = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href);
  assert.ok(!hrefs.some((h) => h.startsWith('/order-requests') || h.startsWith('/import-requests')), hrefs.join(' '));
  // First in Sales & Customers, where Order requests stood.
  const selling = navForRole('CORE_PARTNER', NAV_GROUPS, ['requests']).find((g) => g.key === 'selling');
  assert.equal(selling.items[0].key, 'requests');
  assert.equal(selling.items[0].href, '/requests');
});

test('with Requests switched off, no role is offered it', () => {
  for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR', undefined]) {
    assert.ok(!allKeys(navForRole(role, NAV_GROUPS, [])).includes('requests'), String(role));
  }
});

test('a caller that passes no features gets the switched-off menu, not the full one', () => {
  // Forgetting the features must hide a page production is meant not to have,
  // never show it.
  assert.ok(!allKeys(navForRole('CORE_PARTNER')).includes('requests'));
  assert.ok(!keys(phoneBarItems('CORE_PARTNER')).includes('requests'));
});

test('switching Requests on does not lift its role restriction: an investor still does not see it', () => {
  assert.ok(!allKeys(navForRole('TEMP_INVESTOR', NAV_GROUPS, ['requests'])).includes('requests'));
});

test('switching Requests on or off leaves the phone bar alone', () => {
  assert.deepEqual(keys(phoneBarItems('CORE_PARTNER', NAV_GROUPS, ['requests'])), keys(phoneBarItems('CORE_PARTNER')));
});

test('the Requests entry is lit on its page, whichever tab is open', () => {
  assert.ok(isActiveHref('/requests', '/requests'));
  assert.ok(!isActiveHref('/requestsx', '/requests'));
});
