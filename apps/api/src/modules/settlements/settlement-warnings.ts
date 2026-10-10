import type { Prisma } from '@prisma/client';

/**
 * What a settlement calculation wants the partner to notice before approving.
 *
 * These used to be English sentences written here, which the settlements page
 * printed as they came — English on an Arabic page (CLAUDE.md rule 9). Each is
 * now a code and the numbers it needs; the web says it under
 * `settlementsPage.warnings.<code>` in the reader's language.
 *
 * Params are numbers only. A unit count or an amount is formatted by the
 * client, never here: a string formatted on the server ("1,234.50") is one
 * more thing the client cannot put into another language's sentence.
 */
export const SETTLEMENT_WARNING_CODES = [
  /** Units are still in stock; their cost stays with the cycle, so the profit covers sold units only. */
  'UNSOLD_STOCK',
  /** Nothing from this cycle has been sold yet. */
  'NO_REALISED_SALES',
] as const;

export type SettlementWarningCode = (typeof SETTLEMENT_WARNING_CODES)[number];

export interface SettlementWarning {
  code: SettlementWarningCode;
  params: Record<string, number>;
}

export function settlementWarnings(input: {
  fullySold: boolean;
  unitsRemaining: Prisma.Decimal;
  unsoldValue: Prisma.Decimal;
  hasAllocations: boolean;
}): SettlementWarning[] {
  const warnings: SettlementWarning[] = [];
  if (!input.fullySold) {
    warnings.push({
      code: 'UNSOLD_STOCK',
      params: {
        units: input.unitsRemaining.toNumber(),
        valueEgp: input.unsoldValue.toDecimalPlaces(2).toNumber(),
      },
    });
  }
  if (!input.hasAllocations) {
    warnings.push({ code: 'NO_REALISED_SALES', params: {} });
  }
  return warnings;
}
