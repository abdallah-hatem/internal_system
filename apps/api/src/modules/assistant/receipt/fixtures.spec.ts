/**
 * Regression from a real image (plan W3; `fixtures/README.md`).
 *
 * `guangzhou-invoice.png` was read by Claude on 2026-10-11 and the extraction
 * below is exactly what `match_receipt` received from the live assistant. Two
 * things went wrong there: line 1 matched nothing although "Honda CBR Brake
 * Pad" was on file (plural + an extra word), and line 2 was auto-matched to
 * "Full Face Helmet" on a weak contains-match with no question at all.
 *
 * `gulf-freight-delivery-note.png` is a delivery (15 of 40 helmets, UAE →
 * Egypt), which goes through record_delivery, not the matcher — nothing of it
 * is matched by name, so it has no case here.
 */
import { analyzeReceipt } from './analyze-receipt';
import type { ReceiptExtraction, ReceiptSnapshot } from './receipt.types';

/** Verbatim from fixtures/README.md. */
const GUANGZHOU_INVOICE: ReceiptExtraction = {
  supplierName: 'Guangzhou Auto Parts Trading Co., Ltd',
  currency: 'USD',
  date: '2026-10-09',
  invoiceNumber: 'GZ-24-10-0917',
  lines: [
    {
      description: 'Honda CBR brake pads (front)',
      quantity: 120,
      unitPrice: 4.5,
      sku: null,
    },
    {
      description: 'Full face helmet, matt black, size L',
      quantity: 30,
      unitPrice: 18,
      sku: 'FFH-L',
    },
    {
      description: 'Chain kit 428H 132L',
      quantity: 40,
      unitPrice: 9.25,
      sku: 'CK-428-132',
    },
  ],
  charges: [{ kind: 'shipping', label: 'Inland freight to port', amount: 35 }],
  statedSubtotal: 1450,
  statedTotal: 1485,
};

/** What was on file when the image was tested. */
const SNAPSHOT: ReceiptSnapshot = {
  suppliers: [{ id: 'sup-gz', name: 'Guangzhou Auto Parts', country: 'China' }],
  products: [
    { id: 'p-pad', name: 'Honda CBR Brake Pad', sku: 'PRD-000001' },
    { id: 'p-helmet', name: 'Full Face Helmet', sku: 'PRD-000002' },
  ],
  openCycles: [
    {
      id: 'cyc-1',
      code: 'CYC-2026-010',
      originType: 'CHINA',
      currency: 'USD',
      status: 'PURCHASING',
    },
  ],
  draftOrders: [],
  fxRates: { USD: '48.5' },
  recordedInvoices: [],
};

describe('the Guangzhou invoice, as Claude read it from the real image', () => {
  const a = analyzeReceipt(
    GUANGZHOU_INVOICE,
    SNAPSHOT,
    new Date('2026-10-11T10:00:00Z'),
  );
  const q = (id: string) => a.questions.find((x) => x.id === id);

  it('line 1 "Honda CBR brake pads (front)" asks, offering "Honda CBR Brake Pad"', () => {
    expect(a.lines[0].status).toBe('candidates');
    expect(a.lines[0].match).toBeUndefined();
    expect(a.lines[0].candidates?.map((c) => c.name)).toEqual([
      'Honda CBR Brake Pad',
    ]);
    expect(q('LINE_NEW_OR_EXISTING:1')?.options).toEqual([
      { value: 'p-pad', label: 'Honda CBR Brake Pad (PRD-000001)' },
      { value: 'new', label: 'None of these — a new product' },
    ]);
  });

  it('line 2 "Full face helmet, matt black, size L" asks, offering "Full Face Helmet" — not auto-matched', () => {
    expect(a.lines[1].status).toBe('candidates');
    expect(a.lines[1].match).toBeUndefined();
    expect(a.lines[1].candidates?.map((c) => c.name)).toEqual([
      'Full Face Helmet',
    ]);
    expect(q('LINE_NEW_OR_EXISTING:2')?.blocking).toBe(true);
  });

  it('line 3 "Chain kit 428H 132L" is new, with no candidates', () => {
    expect(a.lines[2].status).toBe('unknown');
    expect(q('LINE_NEW_OR_EXISTING:3')?.options?.map((o) => o.value)).toEqual([
      'new',
    ]);
  });

  it('the totals are right: 540 + 540 + 370 = 1450, the stated subtotal', () => {
    expect(a.lines.map((l) => l.lineTotal)).toEqual([
      '540.00',
      '540.00',
      '370.00',
    ]);
    expect(a.findings.totals).toMatchObject({
      computedSubtotal: '1450.00',
      difference: '0.00',
      checkedAgainst: 'subtotal',
      chargesTotal: '35.00',
    });
    expect(q('TOTALS_MISMATCH')).toBeUndefined();
  });

  it('the freight is a CHARGES_WHERE question, not a line', () => {
    expect(q('CHARGES_WHERE')).toMatchObject({ blocking: false });
    expect(a.lines).toHaveLength(3);
  });

  it('exactly these questions, and nothing else', () => {
    expect(a.supplier.status).toBe('matched');
    expect(a.questions.map((x) => x.id).sort()).toEqual([
      'CHARGES_WHERE',
      'CYCLE_CONFIRM',
      'FX_RATE_CONFIRM',
      'LINE_NEW_OR_EXISTING:1',
      'LINE_NEW_OR_EXISTING:2',
      'LINE_NEW_OR_EXISTING:3',
    ]);
  });
});
