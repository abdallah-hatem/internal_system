/**
 * The record types the audit log can be narrowed to.
 *
 * Exactly the `entityType`s the API's services write
 * (`grep -rn "entityType: '" apps/api/src`). The list used to offer `Cycle`,
 * `Shipment`, `User` and `LedgerEntry`, which nothing writes — a cycle is logged as
 * `ImportCycle`, a ledger entry as `FinancialTransaction` — so picking one of
 * them always showed an empty log. `audit-entity-types.test.ts` reads the API
 * sources and fails when the two drift.
 */
export const AUDIT_ENTITY_TYPES = [
  // Selling
  'SaleOrder', 'SaleReturn', 'Payment', 'PaymentPlan', 'Customer', 'CustomerBranch',
  // Buying and shipping
  'ImportCycle', 'CycleParticipant', 'PurchaseOrder', 'PurchaseOrderItem', 'SupplierRefund',
  'ShippingLeg', 'ShipmentDeparture', 'ShipmentDelivery', 'ShipmentLoss',
  // Stock
  'InventoryBatch', 'StockTransfer',
  // Money
  'FinancialTransaction', 'Settlement', 'Lender', 'LenderFinancing', 'LenderRepayment', 'LenderPlan',
  'CurrencyRate', 'PartnerAccountMovement',
  // Catalogue and contacts
  'Product', 'Category', 'Supplier', 'Provider',
  // The office chat
  'AssistantChat',
] as const;
