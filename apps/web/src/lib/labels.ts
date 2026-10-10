import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The families of codes the API sends that a reader should see in words.
 * Each one is a sub-object of the `codes` namespace in en.json / ar.json, keyed
 * by the code exactly as the API sends it (`PARTIALLY_PAID`, `CORE_PARTNER`…).
 *
 * Sources: `apps/api/prisma/schema.prisma` enums (OrderStatus, CycleStatus,
 * UserRole, ShippingCostBasis, CustomerType), plus the string columns whose
 * values the services set — Payment.status (RECORDED/REVERSED), ShipmentLeg.status
 * (PENDING/IN_TRANSIT/PARTLY_ARRIVED/ARRIVED), Payment.method and SaleOrder.channel.
 */
export type CodeKind =
  | 'orderStatus'
  | 'paymentStatus'
  | 'cycleStatus'
  | 'legStatus'
  | 'role'
  | 'paymentMethod'
  | 'costBasis'
  | 'customerType'
  | 'channel'
  // Added by U5's sweep — codes that were still printed raw somewhere.
  | 'poStatus' // PurchaseOrder.status (a string column)
  | 'settlementStatus' // SettlementStatus
  | 'originType' // CycleOriginType
  | 'verificationStatus' // VerificationStatus, and a customer's UNVERIFIED
  | 'movementType' // InventoryMovementType
  | 'referenceType' // InventoryMovement.referenceType
  | 'auditAction' // AuditLog.action
  | 'entityType'; // AuditLog.entityType

/**
 * Translate an API code for display.
 *
 *   const codeLabel = useCodeLabel();
 *   codeLabel('orderStatus', order.status)     // "Partially paid" / "مدفوع جزئياً"
 *
 * Lookup is exact first, then upper-cased (older payments stored `bank_transfer`).
 * A code with no translation comes back as the code itself — never an empty
 * string — so a new value shows something readable while its key is added.
 * `null`/`undefined`/`''` returns `'—'`.
 */
export function useCodeLabel(): (kind: CodeKind, code: string | null | undefined) => string {
  const t = useTranslations('codes');
  return useCallback(
    (kind: CodeKind, code: string | null | undefined) => {
      if (!code) return '—';
      for (const candidate of [code, code.toUpperCase()]) {
        const key = `${kind}.${candidate}`;
        if (t.has(key)) return t(key);
      }
      return code;
    },
    [t],
  );
}
