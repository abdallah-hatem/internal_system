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
