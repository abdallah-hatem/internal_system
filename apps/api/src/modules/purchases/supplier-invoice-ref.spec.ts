import {
  SUPPLIER_INVOICE_REF_MAX,
  isSupplierInvoiceRefTooLong,
  normaliseSupplierInvoiceRef,
} from './supplier-invoice-ref';

describe('normaliseSupplierInvoiceRef', () => {
  it('trims and upper-cases, so " inv-001 " and "INV-001" are the same invoice', () => {
    expect(normaliseSupplierInvoiceRef(' inv-001 ')).toBe('INV-001');
    expect(normaliseSupplierInvoiceRef('INV-001')).toBe('INV-001');
  });

  it('an empty string is stored as absent', () => {
    expect(normaliseSupplierInvoiceRef('')).toBeNull();
  });

  it('whitespace only is stored as absent, not as an invoice called " "', () => {
    expect(normaliseSupplierInvoiceRef('   \t ')).toBeNull();
  });

  it('a missing field stays absent', () => {
    expect(normaliseSupplierInvoiceRef(undefined)).toBeNull();
    expect(normaliseSupplierInvoiceRef(null)).toBeNull();
  });

  it('keeps the inside of the number untouched', () => {
    expect(normaliseSupplierInvoiceRef(' a b/7 ')).toBe('A B/7');
  });

  it('is idempotent, so normalising twice (DTO then service) changes nothing', () => {
    const once = normaliseSupplierInvoiceRef(' inv-9 ');
    expect(normaliseSupplierInvoiceRef(once)).toBe(once);
  });
});

describe('isSupplierInvoiceRefTooLong', () => {
  it('64 characters is allowed', () => {
    expect(
      isSupplierInvoiceRefTooLong('X'.repeat(SUPPLIER_INVOICE_REF_MAX)),
    ).toBe(false);
  });

  it('an invoice number longer than 64 characters is refused', () => {
    expect(
      isSupplierInvoiceRefTooLong('X'.repeat(SUPPLIER_INVOICE_REF_MAX + 1)),
    ).toBe(true);
  });

  it('padding is not length: 64 characters wrapped in spaces is allowed', () => {
    const ref = normaliseSupplierInvoiceRef(
      `  ${'x'.repeat(SUPPLIER_INVOICE_REF_MAX)}  `,
    );
    expect(isSupplierInvoiceRefTooLong(ref)).toBe(false);
  });

  it('no number is never too long', () => {
    expect(isSupplierInvoiceRefTooLong(null)).toBe(false);
  });
});
