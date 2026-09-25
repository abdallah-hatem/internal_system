/**
 * A supplier's own invoice number, in the one form it is stored and compared in.
 *
 * BUSINESS_LOGIC.md §15: the same supplier invoice cannot become two purchase
 * orders. ` inv-001 ` and `INV-001` are the same piece of paper, so the number is
 * trimmed and upper-cased before it is checked or written — the unique index on
 * (supplier, number) only holds if every writer goes through here.
 *
 * Blank means "this receipt has no number": it becomes null, which the index
 * never compares, so any number of such orders are allowed.
 */
export const SUPPLIER_INVOICE_REF_MAX = 64;

export function normaliseSupplierInvoiceRef(
  raw: string | null | undefined,
): string | null {
  if (raw === undefined || raw === null) return null;
  const ref = raw.trim().toUpperCase();
  return ref === '' ? null : ref;
}

/** Measured after normalising: padding a number with spaces does not make it too long. */
export function isSupplierInvoiceRefTooLong(ref: string | null): boolean {
  return ref !== null && ref.length > SUPPLIER_INVOICE_REF_MAX;
}
