/**
 * Which roles may take which action — the buttons' counterpart of the menu's
 * `nav-model.ts`. The UI does not decide permissions, it mirrors them: each
 * entry is copied from the `@Roles` on the endpoint the action calls, and
 * `unit/can-roles.test.mjs` reads those decorators out of the controllers and
 * fails when the two differ (rule 11, rule 12). A button an investor can see
 * and the server refuses is a dead end that ends in a ROLE_NOT_ALLOWED toast.
 *
 * This file imports nothing on purpose: the unit test loads it into Node.
 * `useCan` (lib/can.ts) is the hook pages use.
 */

const PARTNERS = ['CORE_PARTNER'] as const;
const BOOKS_READERS = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;

export const ACTION_ROLES = {
  // Cycles — CyclesController
  'cycle.create': PARTNERS, //            POST /cycles (the wizard)
  'cycle.transition': PARTNERS, //        POST /cycles/:id/transition
  'cycle.addParticipant': PARTNERS, //    POST /cycles/:id/participants
  'cycle.editParticipant': PARTNERS, //   PUT  /cycles/participants/:id (contributions)
  // Shipment panel — ShippingController, PurchasesController
  'shipment.recordDeparture': PARTNERS, // POST  /shipping/legs/:id/departures (L8)
  'shipment.undoDeparture': PARTNERS, //  DELETE /shipping/departures/:id (L8)
  'shipment.recordDelivery': PARTNERS, // POST   /shipping/legs/:id/deliveries
  'shipment.deleteDelivery': PARTNERS, // DELETE /shipping/deliveries/:id
  'shipment.markLost': PARTNERS, //       POST   /shipping/legs/:id/losses
  'shipment.takeBack': PARTNERS, //       DELETE /shipping/losses/:id
  'shipment.recordRefund': PARTNERS, //   POST   /shipping/losses/:id/refunds
  'shipment.undoRefund': PARTNERS, //     POST   /purchases/refunds/:id/reverse
  // Receiving into stock — InventoryController
  'inventory.receive': PARTNERS, //       POST /receipts/verify
  // Settlements — SettlementsController
  'settlement.calculate': PARTNERS, //    POST /settlements/calculate/:cycleId
  'settlement.approve': PARTNERS, //      POST /settlements/:id/approve
  'settlement.pay': PARTNERS, //          POST /settlements/:id/pay
  'settlement.reverse': PARTNERS, //      POST /settlements/:id/reverse
  // Catalogue — ProductsController, CategoriesController, FilesController (R1c)
  'product.create': PARTNERS, //          POST /products
  'product.edit': PARTNERS, //            PUT  /products/:id
  'product.setPrice': PARTNERS, //        POST /products/:id/prices
  'product.setStatus': PARTNERS, //       PUT  /products/:id/status (§3, 2026-10-14)
  'product.addPhoto': PARTNERS, //        POST   /files/products/:productId
  'product.deletePhoto': PARTNERS, //     DELETE /files/:id
  'category.create': PARTNERS, //         POST   /categories
  'category.edit': PARTNERS, //           PUT    /categories/:id
  'category.delete': PARTNERS, //         DELETE /categories/:id
  // SuppliersController, ProvidersController
  'supplier.create': PARTNERS, //         POST   /suppliers
  'supplier.edit': PARTNERS, //           PUT    /suppliers/:id
  'supplier.delete': PARTNERS, //         DELETE /suppliers/:id
  'provider.create': PARTNERS, //         POST   /providers
  'provider.edit': PARTNERS, //           PUT    /providers/:id
  'provider.delete': PARTNERS, //         DELETE /providers/:id
  // Purchases — CyclePurchasesController, PurchasesController
  'purchase.create': PARTNERS, //         POST /cycles/:cycleId/purchases
  'purchase.recordRefund': PARTNERS, //   POST /purchases/:id/refunds
  // Shipping legs — CycleShippingController, ShippingController
  'shippingLeg.create': PARTNERS, //      POST /cycles/:cycleId/shipping-legs
  'shippingLeg.edit': PARTNERS, //        PUT  /shipping/legs/:id
  // A friend who paid a supplier (§18) — LendersController and its siblings
  'lender.create': PARTNERS, //           POST /lenders
  'lender.edit': PARTNERS, //             PUT  /lenders/:id
  'lender.delete': PARTNERS, //           DELETE /lenders/:id
  'lender.finance': PARTNERS, //          POST /purchases/:id/financings
  'lender.removeFinancing': PARTNERS, //  POST /lender-financings/:id/remove
  'lender.repay': PARTNERS, //            POST /lender-financings/:id/repayments
  'lender.plan': PARTNERS, //             POST /lender-financings/:id/plan
  'lender.reverseRepayment': PARTNERS, // POST /lender-repayments/:id/reverse
  'lender.cancelPlan': PARTNERS, //       POST /lender-plans/:id/cancel
  // Leftovers moved to another cycle at cost (§8, L5) — CycleTransfersController, StockTransfersController
  'stockTransfer.create': PARTNERS, //    POST /cycles/:id/transfers
  'stockTransfer.undo': PARTNERS, //      POST /stock-transfers/:id/undo
  // The exchange-rate page (§22) — CurrencyRatesController
  'fxRate.edit': PARTNERS, //             PUT  /currency-rates/:code
  'fxRate.add': PARTNERS, //              POST /currency-rates
  // A sale's instalment contract (§7, 2026-10-16) — SaleContractController
  'sale.contractPlan': PARTNERS, //      POST /sales/orders/:id/contract-plan
  // Samples a shop kept or lost (§4, samples at shops) — SalesController
  'sale.samplesWriteOff': PARTNERS, //   POST /sales/orders/:id/samples/write-off
  // Lowering a confirmed sale's price (§4, 2026-10-22) — SalesController
  'sale.adjustPrice': PARTNERS, //       POST /sales/orders/:id/price-adjustments
  // Reads a page makes on the side — UsersController
  'users.list': BOOKS_READERS, //         GET /users (the participant picker)
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof ACTION_ROLES;

/** Whether `role` may take `action`. An unknown or still-loading role may not:
 *  a button that appears a moment late is better than one that is refused. */
export function can(role: string | undefined | null, action: Action): boolean {
  if (!role) return false;
  return (ACTION_ROLES[action] as readonly string[]).includes(role);
}
