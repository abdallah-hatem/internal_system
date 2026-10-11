/**
 * Who sees which action button (R1b). Like the menu (nav-roles.test.mjs), the
 * buttons do not decide permissions: each action in `lib/permissions.ts` is
 * shown exactly to the roles the endpoint it calls lets in. These tests read
 * the `@Roles` straight out of the API's controllers and compare, so a
 * controller narrowed or widened without the map following fails here instead
 * of showing an investor a button that ends in ROLE_NOT_ALLOWED (rule 11, 12).
 *
 * Run with `npm run test:unit`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTION_ROLES, can } from '../src/lib/permissions.ts';

const API = join(dirname(fileURLToPath(import.meta.url)), '../../api/src/modules');

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
 * The shared role lists a controller spreads into `@Roles(...X_ROLES)` —
 * `payments/payment-roles.ts`, `lenders/lender-roles.ts` — read from their
 * `*-roles.ts` files, so a list shared with the assistant (§16) is checked
 * like a literal one.
 */
const SHARED_ROLES = Object.fromEntries(
  readdirSync(API, { recursive: true })
    .filter((f) => String(f).endsWith('-roles.ts'))
    .flatMap((f) =>
      [...readFileSync(join(API, String(f)), 'utf8').matchAll(/export const (\w+) = \[([^\]]*)\]/g)].map((m) => [
        m[1],
        [...m[2].matchAll(/'([A-Z_]+)'/g)].map((r) => r[1]),
      ]),
    ),
);
const rolesIn = (decorators) => {
  const d = decorators.find((l) => l.startsWith('@Roles('));
  if (!d) return null;
  const spread = [...d.matchAll(/\.\.\.(\w+)/g)].map((m) => {
    assert.ok(SHARED_ROLES[m[1]], `${m[1]} is not an exported role list in a *-roles.ts file`);
    return SHARED_ROLES[m[1]];
  });
  return [...[...d.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]), ...spread.flat()].sort();
};
const guarded = (decorators) =>
  decorators.some((l) => l.startsWith('@UseGuards(') && l.includes('RolesGuard'));

/**
 * The roles that may call `<verb> <route>` on class `cls` in `file`, as the
 * RolesGuard decides them: the handler's `@Roles` over the class's, and null
 * (any signed-in account) when no RolesGuard is on either.
 */
function endpointRoles(file, cls, verb, route) {
  const lines = readFileSync(join(API, file), 'utf8').split('\n');
  const classLine = lines.findIndex((l) => l.startsWith(`export class ${cls} `));
  assert.ok(classLine >= 0, `${cls} not found in ${file}`);
  let end = lines.findIndex((l, i) => i > classLine && l.startsWith('export class '));
  if (end < 0) end = lines.length;

  const dec = route ? `@${verb}('${route}')` : `@${verb}()`;
  const at = lines.findIndex((l, i) => i > classLine && i < end && l.trim() === dec);
  assert.ok(at >= 0, `${dec} not found on ${cls}`);

  const onClass = decoratorsFrom(lines, classLine, -1);
  const onMethod = [...decoratorsFrom(lines, at, -1), ...decoratorsFrom(lines, at, 1)];
  if (!guarded(onClass) && !guarded(onMethod)) return null;
  return rolesIn(onMethod) ?? rolesIn(onClass);
}

/** Each action, and the endpoint it calls. */
const ENDPOINTS = {
  'cycle.create': ['cycles/cycles.controller.ts', 'CyclesController', 'Post', ''],
  'cycle.transition': ['cycles/cycles.controller.ts', 'CyclesController', 'Post', ':id/transition'],
  'cycle.addParticipant': ['cycles/cycles.controller.ts', 'CyclesController', 'Post', ':id/participants'],
  'cycle.editParticipant': ['cycles/cycles.controller.ts', 'CyclesController', 'Put', 'participants/:id'],
  'shipment.recordDeparture': ['shipping/shipping.controller.ts', 'ShippingController', 'Post', 'legs/:id/departures'],
  'shipment.undoDeparture': ['shipping/shipping.controller.ts', 'ShippingController', 'Delete', 'departures/:id'],
  'shipment.recordDelivery': ['shipping/shipping.controller.ts', 'ShippingController', 'Post', 'legs/:id/deliveries'],
  'shipment.deleteDelivery': ['shipping/shipping.controller.ts', 'ShippingController', 'Delete', 'deliveries/:id'],
  'shipment.markLost': ['shipping/shipping.controller.ts', 'ShippingController', 'Post', 'legs/:id/losses'],
  'shipment.takeBack': ['shipping/shipping.controller.ts', 'ShippingController', 'Delete', 'losses/:id'],
  'shipment.recordRefund': ['shipping/shipping.controller.ts', 'ShippingController', 'Post', 'losses/:id/refunds'],
  'shipment.undoRefund': ['purchases/purchases.controller.ts', 'PurchasesController', 'Post', 'refunds/:id/reverse'],
  'inventory.receive': ['inventory/inventory.controller.ts', 'InventoryController', 'Post', 'receipts/verify'],
  'settlement.calculate': ['settlements/settlements.controller.ts', 'SettlementsController', 'Post', 'calculate/:cycleId'],
  'settlement.approve': ['settlements/settlements.controller.ts', 'SettlementsController', 'Post', ':id/approve'],
  'settlement.pay': ['settlements/settlements.controller.ts', 'SettlementsController', 'Post', ':id/pay'],
  'settlement.reverse': ['settlements/settlements.controller.ts', 'SettlementsController', 'Post', ':id/reverse'],
  'product.create': ['products/products.controller.ts', 'ProductsController', 'Post', ''],
  'product.edit': ['products/products.controller.ts', 'ProductsController', 'Put', ':id'],
  'product.setPrice': ['products/products.controller.ts', 'ProductsController', 'Post', ':id/prices'],
  'product.addPhoto': ['files/files.controller.ts', 'FilesController', 'Post', 'products/:productId'],
  'product.deletePhoto': ['files/files.controller.ts', 'FilesController', 'Delete', ':id'],
  'category.create': ['products/products.controller.ts', 'CategoriesController', 'Post', ''],
  'category.edit': ['products/products.controller.ts', 'CategoriesController', 'Put', ':id'],
  'category.delete': ['products/products.controller.ts', 'CategoriesController', 'Delete', ':id'],
  'supplier.create': ['suppliers/suppliers.controller.ts', 'SuppliersController', 'Post', ''],
  'supplier.edit': ['suppliers/suppliers.controller.ts', 'SuppliersController', 'Put', ':id'],
  'supplier.delete': ['suppliers/suppliers.controller.ts', 'SuppliersController', 'Delete', ':id'],
  'provider.create': ['providers/providers.controller.ts', 'ProvidersController', 'Post', ''],
  'provider.edit': ['providers/providers.controller.ts', 'ProvidersController', 'Put', ':id'],
  'provider.delete': ['providers/providers.controller.ts', 'ProvidersController', 'Delete', ':id'],
  'purchase.create': ['purchases/purchases.controller.ts', 'CyclePurchasesController', 'Post', ':cycleId/purchases'],
  'purchase.recordRefund': ['purchases/purchases.controller.ts', 'PurchasesController', 'Post', ':id/refunds'],
  'shippingLeg.create': ['shipping/shipping.controller.ts', 'CycleShippingController', 'Post', ':cycleId/shipping-legs'],
  'shippingLeg.edit': ['shipping/shipping.controller.ts', 'ShippingController', 'Put', 'legs/:id'],
  'lender.create': ['lenders/lenders.controller.ts', 'LendersController', 'Post', ''],
  'lender.finance': ['lenders/lenders.controller.ts', 'PurchaseFinancingController', 'Post', ':id/financings'],
  'lender.removeFinancing': ['lenders/lenders.controller.ts', 'LenderMoneyController', 'Post', 'lender-financings/:id/remove'],
  'lender.repay': ['lenders/lenders.controller.ts', 'LenderMoneyController', 'Post', 'lender-financings/:id/repayments'],
  'lender.plan': ['lenders/lenders.controller.ts', 'LenderMoneyController', 'Post', 'lender-financings/:id/plan'],
  'lender.reverseRepayment': ['lenders/lenders.controller.ts', 'LenderMoneyController', 'Post', 'lender-repayments/:id/reverse'],
  'lender.cancelPlan': ['lenders/lenders.controller.ts', 'LenderMoneyController', 'Post', 'lender-plans/:id/cancel'],
  'users.list': ['users/users.controller.ts', 'UsersController', 'Get', ''],
};

test('every action names the endpoint it calls', () => {
  assert.deepEqual(Object.keys(ACTION_ROLES).sort(), Object.keys(ENDPOINTS).sort());
});

for (const [action, roles] of Object.entries(ACTION_ROLES)) {
  test(`${action}: offered to exactly the roles its endpoint lets in`, () => {
    const [file, cls, verb, route] = ENDPOINTS[action];
    const api = endpointRoles(file, cls, verb, route);
    // Every action here moves something, so none may be open to any account.
    assert.notEqual(api, null, `${action}: ${cls} ${verb} ${route} has no RolesGuard`);
    assert.deepEqual([...roles].sort(), api, `${action} → ${cls} ${verb} ${route || '/'}`);
  });
}

test('a temporary investor may take none of these actions — they read, they do not act', () => {
  for (const action of Object.keys(ACTION_ROLES)) assert.equal(can('TEMP_INVESTOR', action), false, action);
});

test('a core partner may take every one of them', () => {
  for (const action of Object.keys(ACTION_ROLES)) assert.equal(can('CORE_PARTNER', action), true, action);
});

test('a role still loading, missing or unheard of may take nothing', () => {
  for (const role of [undefined, null, '', 'SOMETHING_NEW', 'SHOP_OWNER_PORTAL']) {
    for (const action of Object.keys(ACTION_ROLES)) assert.equal(can(role, action), false, `${role} ${action}`);
  }
});

test('admin support reads users but does not write', () => {
  assert.equal(can('ADMIN_SUPPORT', 'users.list'), true);
  assert.equal(can('ADMIN_SUPPORT', 'settlement.approve'), false);
});
