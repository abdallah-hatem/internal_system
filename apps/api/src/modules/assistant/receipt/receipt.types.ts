/**
 * The shapes `analyzeReceipt` reads and returns.
 *
 * Plain data on both sides: the extraction is what Claude read off the paper,
 * the snapshot is what the `match_receipt` tool loads from the database. Nothing
 * here knows about Prisma rows or Nest, so every case is a unit test.
 *
 * Numbers arrive as `number | string` because a model's JSON may carry either;
 * they are turned into decimals before any arithmetic, and money leaves as a
 * two-decimal string so no float ever stands in for an amount.
 */

export type Numeric = number | string;

export interface ReceiptLineExtraction {
  description: string;
  sku?: string | null;
  quantity: Numeric;
  unitPrice: Numeric;
  /** Percent off this line, 0–100. */
  discountPercent?: Numeric | null;
}

export type ReceiptChargeKind = 'shipping' | 'fee' | 'tax' | 'other';

export interface ReceiptChargeExtraction {
  kind: ReceiptChargeKind;
  label: string;
  amount: Numeric;
}

export interface ReceiptExtraction {
  supplierName: string;
  invoiceNumber?: string | null;
  /** yyyy-mm-dd, as printed. */
  date?: string | null;
  /** ISO 4217 code. */
  currency: string;
  lines: ReceiptLineExtraction[];
  charges?: ReceiptChargeExtraction[];
  statedSubtotal?: Numeric | null;
  statedTotal?: Numeric | null;
}

export interface SnapshotSupplier {
  id: string;
  name: string;
  country: string;
}

export interface SnapshotProduct {
  id: string;
  name: string;
  sku: string | null;
}

export type CycleOrigin = 'CHINA' | 'UAE_DIRECT';

/**
 * A cycle that can still take a purchase order. Which statuses those are is
 * the purchases service's rule; the tool wrapper loads them with it, and this
 * function does not keep a second copy.
 */
export interface SnapshotCycle {
  id: string;
  code: string;
  originType: CycleOrigin;
  currency: string;
  status: string;
}

export interface SnapshotDraftOrder {
  id: string;
  reference: string;
  cycleId: string;
  supplierId: string;
}

export interface SnapshotRecordedInvoice {
  supplierId: string;
  /** Already normalised by the loader; normalised again here regardless. */
  invoiceRef: string;
  purchaseOrderReference: string;
  cycleCode: string;
}

export interface ReceiptSnapshot {
  suppliers: SnapshotSupplier[];
  products: SnapshotProduct[];
  openCycles: SnapshotCycle[];
  draftOrders: SnapshotDraftOrder[];
  /** Rate to EGP per currency code; null when none is on file. */
  fxRates: Record<string, Numeric | null>;
  recordedInvoices: SnapshotRecordedInvoice[];
}

export type MatchStatus = 'matched' | 'candidates' | 'unknown';

export interface SupplierCandidate {
  id: string;
  name: string;
  country: string;
  /** 0–1; 1 is the same name once case, spacing and punctuation are ignored. */
  score: number;
}

export interface ProductCandidate {
  id: string;
  name: string;
  sku: string | null;
  via: 'sku' | 'name' | 'name-contains' | 'name-similar';
  score: number;
}

export interface SupplierAnalysis {
  status: MatchStatus;
  match?: SupplierCandidate;
  candidates?: SupplierCandidate[];
}

export interface LineAnalysis {
  /** 1-based, as a person would count the lines on the paper. */
  line: number;
  description: string;
  status: MatchStatus;
  match?: ProductCandidate;
  candidates?: ProductCandidate[];
  /** quantity × unit price less the line discount, 2 dp; null when the line cannot be priced. */
  lineTotal: string | null;
}

export interface QuestionOption {
  value: string;
  label: string;
}

export interface ReceiptQuestion {
  /** Unique within one analysis: the kind, plus `:<line>` for a per-line question. */
  id: string;
  kind: QuestionKind;
  blocking: boolean;
  /** Plain English; the model rephrases it. */
  text: string;
  options?: QuestionOption[];
  context?: Record<string, unknown>;
}

export type QuestionKind =
  | 'RECEIPT_NO_LINES'
  | 'SUPPLIER_WHICH'
  | 'SUPPLIER_NEW'
  | 'DUPLICATE_INVOICE'
  | 'LINE_NEW_OR_EXISTING'
  | 'LINE_WHICH'
  | 'LINE_QTY_INVALID'
  | 'LINE_PRICE_INVALID'
  | 'LINE_DISCOUNT_INVALID'
  | 'TOTALS_MISMATCH'
  | 'CHARGES_WHERE'
  | 'CURRENCY_UNREADABLE'
  | 'FX_RATE_NEEDED'
  | 'FX_RATE_CONFIRM'
  | 'CYCLE_NEW'
  | 'CYCLE_CONFIRM'
  | 'CYCLE_WHICH'
  | 'ADD_OR_SEPARATE'
  | 'DATE_UNREADABLE'
  | 'FUTURE_DATE';

export interface ReceiptFindings {
  invoiceNumber: string | null;
  duplicateOf?: { purchaseOrderReference: string; cycleCode: string };
  totals: {
    computedSubtotal: string | null;
    statedSubtotal: string | null;
    statedTotal: string | null;
    chargesTotal: string;
    /** computed − stated, on whichever stated figure was checked. */
    difference: string | null;
    checkedAgainst: 'subtotal' | 'total' | null;
  };
  charges: { kind: ReceiptChargeKind; label: string; amount: string | null }[];
  fx: {
    currency: string;
    rate: string | null;
    source: 'base' | 'stored' | 'none';
  };
  cycles: {
    suggested: { id: string; code: string } | null;
    open: { id: string; code: string; originType: CycleOrigin }[];
  };
  draftOrders: {
    id: string;
    reference: string;
    cycleId: string;
    cycleCode: string;
  }[];
}

export interface ReceiptAnalysis {
  supplier: SupplierAnalysis;
  lines: LineAnalysis[];
  computedSubtotal: string | null;
  findings: ReceiptFindings;
  questions: ReceiptQuestion[];
  /** True when any question must be answered before a purchase order can be previewed. */
  blocked: boolean;
}
