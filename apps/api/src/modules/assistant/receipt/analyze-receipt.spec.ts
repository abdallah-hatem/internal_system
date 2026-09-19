/**
 * What `match_receipt` asks about, one case at a time.
 *
 * The baseline receipt below is fully settled — known supplier, known products,
 * one open cycle, EGP, lines that add up — so each test changes the one thing it
 * is about and asserts on the question that change must raise. A test that only
 * checked "some question came back" would pass for the wrong reason; these
 * assert on the id, whether it blocks, and the figures it carries.
 */
import { analyzeReceipt } from './analyze-receipt';
import { SIMILARITY_THRESHOLD, similarity, supplierKey } from './name-matching';
import type { ReceiptExtraction, ReceiptSnapshot } from './receipt.types';

const TODAY = new Date('2026-09-19T10:00:00Z');

function snapshot(overrides: Partial<ReceiptSnapshot> = {}): ReceiptSnapshot {
  return {
    suppliers: [
      { id: 'sup-gz', name: 'Guangzhou Parts', country: 'China' },
      { id: 'sup-dxb', name: 'Dubai Moto Trading', country: 'UAE' },
    ],
    products: [
      { id: 'p-pad-f', name: 'Brake pad front', sku: 'BP-220' },
      { id: 'p-pad-r', name: 'Brake pad rear', sku: 'BP-221' },
      { id: 'p-chain', name: 'Drive chain 428', sku: 'DC-428' },
      { id: 'p-plug', name: 'Spark plug', sku: null },
    ],
    openCycles: [
      {
        id: 'cyc-1',
        code: 'CYC-2026-007',
        originType: 'CHINA',
        currency: 'CNY',
        status: 'PURCHASING',
      },
    ],
    draftOrders: [],
    fxRates: { CNY: '6.85', USD: '48.5', AED: null },
    recordedInvoices: [],
    ...overrides,
  };
}

function receipt(
  overrides: Partial<ReceiptExtraction> = {},
): ReceiptExtraction {
  return {
    supplierName: 'Guangzhou Parts',
    invoiceNumber: 'INV-001',
    date: '2026-09-10',
    currency: 'EGP',
    lines: [
      {
        description: 'Brake pad front',
        sku: 'BP-220',
        quantity: 10,
        unitPrice: '12.50',
      },
      { description: 'Spark plug', quantity: 4, unitPrice: 3 },
    ],
    charges: [],
    statedSubtotal: '137.00',
    ...overrides,
  };
}

const analyze = (
  r: Partial<ReceiptExtraction> = {},
  s: Partial<ReceiptSnapshot> = {},
) => analyzeReceipt(receipt(r), snapshot(s), TODAY);
const ids = (a: ReturnType<typeof analyze>) =>
  a.questions.map((q) => q.id).sort();
const question = (a: ReturnType<typeof analyze>, id: string) =>
  a.questions.find((q) => q.id === id);

describe('analyzeReceipt — the baseline', () => {
  it('a fully known receipt asks only the non-blocking cycle confirmation', () => {
    const a = analyze();
    expect(ids(a)).toEqual(['CYCLE_CONFIRM']);
    expect(a.blocked).toBe(false);
    expect(a.computedSubtotal).toBe('137.00');
  });
});

describe('analyzeReceipt — supplier', () => {
  it('Supplier exact, ignoring case and spacing → matched, no question', () => {
    const a = analyze({ supplierName: '  guangzhou   PARTS ' });
    expect(a.supplier.status).toBe('matched');
    expect(a.supplier.match?.id).toBe('sup-gz');
    expect(a.questions.filter((q) => q.kind.startsWith('SUPPLIER'))).toEqual(
      [],
    );
  });

  it('Supplier exact once legal-form words and punctuation are ignored → matched', () => {
    const a = analyze({ supplierName: 'GUANGZHOU-PARTS Co., Ltd.' });
    expect(a.supplier.status).toBe('matched');
    expect(a.supplier.match?.id).toBe('sup-gz');
  });

  it('Supplier near-miss (Guangzou Parts vs Guangzhou Parts) → candidates, SUPPLIER_WHICH, blocking', () => {
    const a = analyze({ supplierName: 'Guangzou Parts' });
    expect(a.supplier.status).toBe('candidates');
    expect(a.supplier.candidates?.map((c) => c.id)).toEqual(['sup-gz']);
    const q = question(a, 'SUPPLIER_WHICH');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(['sup-gz', 'new']);
    expect(a.blocked).toBe(true);
  });

  it('two suppliers with the same name on file → candidates, never a silent pick', () => {
    const a = analyze(
      {},
      {
        suppliers: [
          { id: 'a', name: 'Guangzhou Parts', country: 'China' },
          { id: 'b', name: 'guangzhou parts', country: 'UAE' },
        ],
      },
    );
    expect(a.supplier.status).toBe('candidates');
    expect(question(a, 'SUPPLIER_WHICH')?.blocking).toBe(true);
  });

  it('Supplier unknown → SUPPLIER_NEW asking for the country, blocking', () => {
    const a = analyze({ supplierName: 'Ningbo Motor Works' });
    expect(a.supplier.status).toBe('unknown');
    const q = question(a, 'SUPPLIER_NEW');
    expect(q?.blocking).toBe(true);
    expect(q?.text).toMatch(/country/);
    expect(q?.context).toMatchObject({
      name: 'Ningbo Motor Works',
      needs: ['country'],
    });
  });

  it('a short name one letter from another business is not offered (below the threshold)', () => {
    // "Moto Parts" / "Auto Parts" — two real shops, not a misreading.
    expect(
      similarity(supplierKey('Moto Parts'), supplierKey('Auto Parts')),
    ).toBeLessThan(SIMILARITY_THRESHOLD);
    const a = analyze(
      { supplierName: 'Auto Parts' },
      { suppliers: [{ id: 'm', name: 'Moto Parts', country: 'Egypt' }] },
    );
    expect(a.supplier.status).toBe('unknown');
  });

  it('a blank supplier name is unknown, not a match to anything', () => {
    const a = analyze({ supplierName: ' .. ' });
    expect(a.supplier.status).toBe('unknown');
    expect(question(a, 'SUPPLIER_NEW')?.blocking).toBe(true);
  });
});

describe('analyzeReceipt — duplicate invoice (§15)', () => {
  const recorded = [
    {
      supplierId: 'sup-gz',
      invoiceRef: 'INV-001',
      purchaseOrderReference: 'PO-2026-031',
      cycleCode: 'CYC-2026-005',
    },
  ];

  it('Same supplier + invoice already recorded → DUPLICATE_INVOICE, blocking, names the existing order', () => {
    const a = analyze({}, { recordedInvoices: recorded });
    const q = question(a, 'DUPLICATE_INVOICE');
    expect(q?.blocking).toBe(true);
    expect(q?.text).toContain('PO-2026-031');
    expect(q?.context).toMatchObject({
      purchaseOrderReference: 'PO-2026-031',
      cycleCode: 'CYC-2026-005',
    });
    expect(a.findings.duplicateOf?.purchaseOrderReference).toBe('PO-2026-031');
  });

  it('the same number typed differently (" inv-001 ") is still the same invoice', () => {
    const a = analyze(
      { invoiceNumber: ' inv-001 ' },
      { recordedInvoices: recorded },
    );
    expect(question(a, 'DUPLICATE_INVOICE')).toBeDefined();
  });

  it('the same number from a different supplier is not a duplicate', () => {
    const a = analyze(
      { supplierName: 'Dubai Moto Trading' },
      { recordedInvoices: recorded },
    );
    expect(question(a, 'DUPLICATE_INVOICE')).toBeUndefined();
  });

  it('no invoice number is never a duplicate', () => {
    const a = analyze(
      { invoiceNumber: '  ' },
      { recordedInvoices: [{ ...recorded[0], invoiceRef: '' }] },
    );
    expect(question(a, 'DUPLICATE_INVOICE')).toBeUndefined();
    expect(a.findings.invoiceNumber).toBeNull();
  });
});

describe('analyzeReceipt — lines', () => {
  it('Line matches a product by SKU → matched', () => {
    const a = analyze({
      lines: [
        {
          description: 'Pastiglie freno',
          sku: 'bp 220',
          quantity: 1,
          unitPrice: 5,
        },
      ],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('matched');
    expect(a.lines[0].match).toMatchObject({ id: 'p-pad-f', via: 'sku' });
  });

  it('Line matches by name → matched', () => {
    const a = analyze({
      lines: [{ description: 'SPARK-PLUG', quantity: 1, unitPrice: 5 }],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('matched');
    expect(a.lines[0].match).toMatchObject({ id: 'p-plug', via: 'name' });
  });

  it('Line matches by name with extra words on the receipt → matched', () => {
    const a = analyze({
      lines: [
        {
          description: 'Drive chain 428 heavy duty, gold',
          quantity: 1,
          unitPrice: 5,
        },
      ],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('matched');
    expect(a.lines[0].match).toMatchObject({
      id: 'p-chain',
      via: 'name-contains',
    });
  });

  it('Line matches by name → candidates when several', () => {
    const a = analyze({
      lines: [{ description: 'Brake pad', quantity: 1, unitPrice: 5 }],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('candidates');
    expect(a.lines[0].candidates?.map((c) => c.id).sort()).toEqual([
      'p-pad-f',
      'p-pad-r',
    ]);
  });

  it('Line matches several → LINE_WHICH, blocking', () => {
    const a = analyze({
      lines: [{ description: 'Brake pad', quantity: 1, unitPrice: 5 }],
      statedSubtotal: 5,
    });
    const q = question(a, 'LINE_WHICH:1');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(
      expect.arrayContaining(['p-pad-f', 'p-pad-r', 'new']),
    );
  });

  it('two products sharing one SKU → LINE_WHICH, not the first one found', () => {
    const a = analyze(
      {
        lines: [{ description: 'x', sku: 'BP-220', quantity: 1, unitPrice: 5 }],
        statedSubtotal: 5,
      },
      {
        products: [
          { id: 'a', name: 'Pad A', sku: 'BP-220' },
          { id: 'b', name: 'Pad B', sku: 'bp220' },
        ],
      },
    );
    expect(question(a, 'LINE_WHICH:1')?.blocking).toBe(true);
  });

  it('Line matches nothing → LINE_NEW_OR_EXISTING, blocking', () => {
    const a = analyze({
      lines: [{ description: 'Handlebar grips', quantity: 1, unitPrice: 5 }],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('unknown');
    const q = question(a, 'LINE_NEW_OR_EXISTING:1');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(['new']);
  });

  it('a near-miss name is offered, not assumed → LINE_NEW_OR_EXISTING with the candidate', () => {
    const a = analyze({
      lines: [{ description: 'Sparck plug', quantity: 1, unitPrice: 5 }],
      statedSubtotal: 5,
    });
    expect(a.lines[0].status).toBe('candidates');
    expect(
      question(a, 'LINE_NEW_OR_EXISTING:1')?.options?.map((o) => o.value),
    ).toEqual(['p-plug', 'new']);
  });

  it('a SKU nobody has falls back to the name', () => {
    const a = analyze({
      lines: [
        { description: 'Spark plug', sku: 'ZZZ-9', quantity: 1, unitPrice: 5 },
      ],
      statedSubtotal: 5,
    });
    expect(a.lines[0].match).toMatchObject({ id: 'p-plug', via: 'name' });
  });

  it('per-line questions carry the line number, so two unknown lines are two questions', () => {
    const a = analyze({
      lines: [
        { description: 'Handlebar grips', quantity: 1, unitPrice: 5 },
        { description: 'Mirror set', quantity: 1, unitPrice: 5 },
      ],
      statedSubtotal: 10,
    });
    expect(ids(a)).toEqual([
      'CYCLE_CONFIRM',
      'LINE_NEW_OR_EXISTING:1',
      'LINE_NEW_OR_EXISTING:2',
    ]);
  });
});

describe('analyzeReceipt — line values', () => {
  it.each([0, -3, '0', 'abc', Number.NaN])(
    'Line quantity zero or negative → LINE_QTY_INVALID, blocking (%p)',
    (quantity) => {
      const a = analyze({
        lines: [{ description: 'Spark plug', quantity, unitPrice: 5 }],
      });
      expect(question(a, 'LINE_QTY_INVALID:1')?.blocking).toBe(true);
      expect(a.lines[0].lineTotal).toBeNull();
      expect(a.computedSubtotal).toBeNull();
    },
  );

  it('Line unit price negative → LINE_PRICE_INVALID, blocking', () => {
    const a = analyze({
      lines: [{ description: 'Spark plug', quantity: 2, unitPrice: -1 }],
    });
    expect(question(a, 'LINE_PRICE_INVALID:1')?.blocking).toBe(true);
    expect(a.lines[0].lineTotal).toBeNull();
  });

  it('a zero unit price is a free item, not an error', () => {
    const a = analyze({
      lines: [{ description: 'Spark plug', quantity: 2, unitPrice: 0 }],
      statedSubtotal: 0,
    });
    expect(question(a, 'LINE_PRICE_INVALID:1')).toBeUndefined();
    expect(a.lines[0].lineTotal).toBe('0.00');
  });

  it.each([100.01, 150, -5])(
    'A line discount larger than the line → LINE_DISCOUNT_INVALID, blocking (%p%)',
    (discountPercent) => {
      const a = analyze({
        lines: [
          {
            description: 'Spark plug',
            quantity: 2,
            unitPrice: 50,
            discountPercent,
          },
        ],
      });
      expect(question(a, 'LINE_DISCOUNT_INVALID:1')?.blocking).toBe(true);
      expect(a.lines[0].lineTotal).toBeNull();
      // An invalid line must never produce a negative subtotal.
      expect(a.computedSubtotal).toBeNull();
      expect(question(a, 'TOTALS_MISMATCH')).toBeUndefined();
    },
  );

  it('a 100% discount is a free line, worth exactly zero', () => {
    const a = analyze({
      lines: [
        {
          description: 'Spark plug',
          quantity: 2,
          unitPrice: 50,
          discountPercent: 100,
        },
      ],
      statedSubtotal: 0,
    });
    expect(a.lines[0].lineTotal).toBe('0.00');
    expect(a.blocked).toBe(false);
  });

  it('Fractional quantity (2.5) → accepted', () => {
    const a = analyze({
      lines: [
        { description: 'Drive chain 428', quantity: 2.5, unitPrice: '4.10' },
      ],
      statedSubtotal: '10.25',
    });
    expect(question(a, 'LINE_QTY_INVALID:1')).toBeUndefined();
    expect(a.lines[0].lineTotal).toBe('10.25');
    expect(a.blocked).toBe(false);
  });
});

describe('analyzeReceipt — totals', () => {
  it('Lines ≠ stated subtotal by more than 0.01 → TOTALS_MISMATCH, blocking, carrying both figures', () => {
    const a = analyze({ statedSubtotal: '137.02' });
    const q = question(a, 'TOTALS_MISMATCH');
    expect(q?.blocking).toBe(true);
    expect(q?.context).toMatchObject({
      computed: '137.00',
      stated: '137.02',
      difference: '-0.02',
      checkedAgainst: 'subtotal',
    });
  });

  it('a difference of exactly 0.01 is rounding, not a mismatch', () => {
    expect(
      question(analyze({ statedSubtotal: '137.01' }), 'TOTALS_MISMATCH'),
    ).toBeUndefined();
  });

  it('Lines = subtotal once line discounts are applied → no question', () => {
    // 3 × 19.99 less 15% = 50.9745 → 50.97;  7 × 0.1 = 0.70;  sum 51.67.
    // Floats give 0.1 × 7 = 0.7000000000000001 — decimals give 0.70.
    const a = analyze({
      lines: [
        {
          description: 'Brake pad rear',
          quantity: 3,
          unitPrice: 19.99,
          discountPercent: 15,
        },
        { description: 'Spark plug', quantity: 7, unitPrice: 0.1 },
      ],
      statedSubtotal: 51.67,
    });
    expect(a.lines.map((l) => l.lineTotal)).toEqual(['50.97', '0.70']);
    expect(a.computedSubtotal).toBe('51.67');
    expect(question(a, 'TOTALS_MISMATCH')).toBeUndefined();
  });

  it('the same lines without applying the discount would not add up — the discount is what reconciles them', () => {
    const a = analyze({
      lines: [{ description: 'Brake pad rear', quantity: 3, unitPrice: 19.99 }],
      statedSubtotal: 50.97,
    });
    expect(question(a, 'TOTALS_MISMATCH')?.context).toMatchObject({
      computed: '59.97',
      stated: '50.97',
    });
  });

  it('with no stated subtotal, the lines plus charges are checked against the stated total', () => {
    const charges = [
      { kind: 'shipping' as const, label: 'Freight', amount: 20 },
    ];
    expect(
      question(
        analyze({ statedSubtotal: null, statedTotal: 157, charges }),
        'TOTALS_MISMATCH',
      ),
    ).toBeUndefined();
    const q = question(
      analyze({ statedSubtotal: null, statedTotal: 150, charges }),
      'TOTALS_MISMATCH',
    );
    expect(q?.context).toMatchObject({
      computed: '157.00',
      stated: '150.00',
      checkedAgainst: 'total',
    });
  });

  it('no stated figure at all → nothing to check, no question', () => {
    const a = analyze({ statedSubtotal: null, statedTotal: null });
    expect(question(a, 'TOTALS_MISMATCH')).toBeUndefined();
    expect(a.findings.totals.checkedAgainst).toBeNull();
  });
});

describe('analyzeReceipt — charges', () => {
  it('Shipping / fees / tax present → CHARGES_WHERE, not blocking', () => {
    const a = analyze({
      charges: [
        { kind: 'shipping', label: 'Freight to Yiwu', amount: '30.00' },
        { kind: 'fee', label: 'Bank fee', amount: 5 },
        { kind: 'tax', label: 'VAT', amount: '1.50' },
      ],
    });
    const q = question(a, 'CHARGES_WHERE');
    expect(q?.blocking).toBe(false);
    expect(q?.context).toMatchObject({ total: '36.50' });
    expect(a.findings.charges).toHaveLength(3);
    // Charges are not goods: the subtotal is the lines alone.
    expect(a.computedSubtotal).toBe('137.00');
    expect(a.blocked).toBe(false);
  });

  it('no charges → no CHARGES_WHERE', () => {
    expect(question(analyze(), 'CHARGES_WHERE')).toBeUndefined();
  });
});

describe('analyzeReceipt — currency', () => {
  it('Currency with no stored rate → FX_RATE_NEEDED, blocking', () => {
    for (const currency of ['AED', 'EUR']) {
      const a = analyze({ currency });
      expect(question(a, 'FX_RATE_NEEDED')?.blocking).toBe(true);
      expect(a.findings.fx).toEqual({ currency, rate: null, source: 'none' });
    }
  });

  it('a stored rate of zero is no rate', () => {
    expect(
      question(
        analyze({ currency: 'CNY' }, { fxRates: { CNY: 0 } }),
        'FX_RATE_NEEDED',
      )?.blocking,
    ).toBe(true);
  });

  it('Currency with a stored rate → FX_RATE_CONFIRM with the rate, not blocking', () => {
    const a = analyze({ currency: ' cny ' });
    const q = question(a, 'FX_RATE_CONFIRM');
    expect(q?.blocking).toBe(false);
    expect(q?.context).toEqual({ currency: 'CNY', rate: '6.85' });
    expect(a.findings.fx).toEqual({
      currency: 'CNY',
      rate: '6.85',
      source: 'stored',
    });
  });

  it('Currency EGP → no FX question, rate 1', () => {
    const a = analyze({ currency: 'EGP' });
    expect(a.questions.filter((q) => q.kind.startsWith('FX_'))).toEqual([]);
    expect(a.findings.fx).toEqual({
      currency: 'EGP',
      rate: '1',
      source: 'base',
    });
  });

  it('a currency that is not a code → CURRENCY_UNREADABLE, blocking', () => {
    const a = analyze({ currency: '¥' });
    expect(question(a, 'CURRENCY_UNREADABLE')?.blocking).toBe(true);
    expect(question(a, 'FX_RATE_NEEDED')).toBeUndefined();
  });
});

describe('analyzeReceipt — cycle and draft orders', () => {
  it('No cycle open for purchasing → CYCLE_NEW offering the two routes (CHINA, UAE_DIRECT), blocking', () => {
    const a = analyze({}, { openCycles: [] });
    const q = question(a, 'CYCLE_NEW');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(['CHINA', 'UAE_DIRECT']);
    expect(a.findings.cycles.suggested).toBeNull();
  });

  it('Exactly one open cycle → suggested, CYCLE_CONFIRM, not blocking', () => {
    const a = analyze();
    const q = question(a, 'CYCLE_CONFIRM');
    expect(q?.blocking).toBe(false);
    expect(q?.context).toEqual({ cycleId: 'cyc-1', cycleCode: 'CYC-2026-007' });
    expect(a.findings.cycles.suggested).toEqual({
      id: 'cyc-1',
      code: 'CYC-2026-007',
    });
  });

  it('Several open cycles → CYCLE_WHICH, blocking', () => {
    const a = analyze(
      {},
      {
        openCycles: [
          {
            id: 'cyc-1',
            code: 'CYC-2026-007',
            originType: 'CHINA',
            currency: 'CNY',
            status: 'PURCHASING',
          },
          {
            id: 'cyc-2',
            code: 'CYC-2026-008',
            originType: 'UAE_DIRECT',
            currency: 'AED',
            status: 'FUNDING',
          },
        ],
      },
    );
    const q = question(a, 'CYCLE_WHICH');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(['cyc-1', 'cyc-2']);
    expect(a.findings.cycles.suggested).toBeNull();
  });

  it('A draft order from this supplier on an open cycle → ADD_OR_SEPARATE, blocking', () => {
    const a = analyze(
      {},
      {
        draftOrders: [
          {
            id: 'po-9',
            reference: 'PO-2026-040',
            cycleId: 'cyc-1',
            supplierId: 'sup-gz',
          },
        ],
      },
    );
    const q = question(a, 'ADD_OR_SEPARATE');
    expect(q?.blocking).toBe(true);
    expect(q?.options?.map((o) => o.value)).toEqual(['po-9', 'separate']);
    expect(q?.text).toContain('PO-2026-040');
  });

  it('a draft from another supplier, or on a cycle no longer open, is not offered', () => {
    const a = analyze(
      {},
      {
        draftOrders: [
          {
            id: 'po-1',
            reference: 'PO-1',
            cycleId: 'cyc-1',
            supplierId: 'sup-dxb',
          },
          {
            id: 'po-2',
            reference: 'PO-2',
            cycleId: 'cyc-closed',
            supplierId: 'sup-gz',
          },
        ],
      },
    );
    expect(question(a, 'ADD_OR_SEPARATE')).toBeUndefined();
    expect(a.findings.draftOrders).toEqual([]);
  });
});

describe('analyzeReceipt — date', () => {
  it('Receipt date in the future → FUTURE_DATE, blocking', () => {
    const q = question(analyze({ date: '2026-09-20' }), 'FUTURE_DATE');
    expect(q?.blocking).toBe(true);
    expect(q?.context).toEqual({ date: '2026-09-20', today: '2026-09-19' });
  });

  it('today is not the future', () => {
    expect(
      question(analyze({ date: '2026-09-19' }), 'FUTURE_DATE'),
    ).toBeUndefined();
  });

  it('"today" is Cairo\'s day: 00:30 Cairo on the 20th accepts a receipt dated the 20th', () => {
    const lateUtc = new Date('2026-09-19T21:30:00Z'); // 00:30 on the 20th in Cairo
    const a = analyzeReceipt(
      receipt({ date: '2026-09-20' }),
      snapshot(),
      lateUtc,
    );
    expect(a.questions.find((q) => q.kind === 'FUTURE_DATE')).toBeUndefined();
  });

  it('a date that does not exist → DATE_UNREADABLE, blocking', () => {
    for (const date of ['2026-02-30', '10/09/2026']) {
      expect(question(analyze({ date }), 'DATE_UNREADABLE')?.blocking).toBe(
        true,
      );
    }
  });
});

describe('analyzeReceipt — no lines', () => {
  it('No lines → refused with a single blocking RECEIPT_NO_LINES question', () => {
    const a = analyze({ lines: [] });
    expect(ids(a)).toEqual(['RECEIPT_NO_LINES']);
    expect(a.blocked).toBe(true);
    expect(a.computedSubtotal).toBeNull();
  });
});

describe('analyzeReceipt — a realistic receipt, end to end', () => {
  it('two supplier candidates, five lines, freight, CNY → exactly the expected questions', () => {
    const a = analyzeReceipt(
      {
        supplierName: 'GUANGZHOU PART CO., LTD',
        invoiceNumber: 'GZ-88121',
        date: '2026-09-15',
        currency: 'CNY',
        lines: [
          {
            description: 'Brake pad front',
            sku: 'BP-220',
            quantity: 40,
            unitPrice: '8.60',
          }, // 344.00 — by SKU
          {
            description: 'Brake pad',
            quantity: 20,
            unitPrice: '8.60',
            discountPercent: 5,
          }, // 163.40 — front or rear?
          {
            description: 'Drive chain 428 gold',
            quantity: 12.5,
            unitPrice: '21.00',
          }, // 262.50 — contains the name
          {
            description: 'Handlebar grip rubber',
            quantity: 30,
            unitPrice: '2.35',
          }, // 70.50 — unknown
          {
            description: 'Spark plug',
            quantity: 100,
            unitPrice: '1.10',
            discountPercent: 10,
          }, // 99.00 — by name
        ],
        charges: [
          {
            kind: 'shipping',
            label: 'Freight to Yiwu warehouse',
            amount: '120.00',
          },
        ],
        statedSubtotal: '939.40',
        statedTotal: '1059.40',
      },
      snapshot({
        suppliers: [
          { id: 'sup-gz', name: 'Guangzhou Parts', country: 'China' },
          { id: 'sup-gz2', name: 'Guangzhou Party', country: 'China' },
          { id: 'sup-dxb', name: 'Dubai Moto Trading', country: 'UAE' },
        ],
        recordedInvoices: [
          {
            supplierId: 'sup-dxb',
            invoiceRef: 'GZ-88121',
            purchaseOrderReference: 'PO-1',
            cycleCode: 'C-1',
          },
        ],
      }),
      TODAY,
    );

    expect(a.supplier.status).toBe('candidates');
    expect(a.supplier.candidates?.map((c) => c.id).sort()).toEqual([
      'sup-gz',
      'sup-gz2',
    ]);
    expect(a.lines.map((l) => l.status)).toEqual([
      'matched',
      'candidates',
      'matched',
      'unknown',
      'matched',
    ]);
    expect(a.lines.map((l) => l.lineTotal)).toEqual([
      '344.00',
      '163.40',
      '262.50',
      '70.50',
      '99.00',
    ]);
    expect(a.computedSubtotal).toBe('939.40');

    expect(ids(a)).toEqual([
      'CHARGES_WHERE',
      'CYCLE_CONFIRM',
      'FX_RATE_CONFIRM',
      'LINE_NEW_OR_EXISTING:4',
      'LINE_WHICH:2',
      'SUPPLIER_WHICH',
    ]);
    expect(
      a.questions
        .filter((q) => q.blocking)
        .map((q) => q.id)
        .sort(),
    ).toEqual(['LINE_NEW_OR_EXISTING:4', 'LINE_WHICH:2', 'SUPPLIER_WHICH']);
    expect(a.blocked).toBe(true);
    expect(a.findings.totals).toMatchObject({
      difference: '0.00',
      checkedAgainst: 'subtotal',
      chargesTotal: '120.00',
    });
  });
});
