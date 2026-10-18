import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { AuditChanges, auditChanges, humaniseKey } from './audit-changes';
import { AuditRecord } from './audit-record';

/**
 * The audit log's detail said what changed as two raw JSON dumps — ids,
 * "1500.00", "2026-10-18T00:00:00.000Z" (owner 2026-10-18). It now lists one
 * line per field that differs, in words, with money and dates formatted.
 */

const nav = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ locale: nav.locale }),
}));

afterEach(cleanup);

const UUID_A = '3f2a91c0-1111-4111-8111-111111111111';
const UUID_B = '3f2a91c0-2222-4222-8222-222222222222';

function show(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  nav.locale = locale;
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      {node}
    </NextIntlClientProvider>,
  );
}

/** Each line as the reader sees it: "Field|value text". */
const lines = () =>
  screen.queryAllByTestId('audit-change').map((row) => {
    const dt = row.querySelector('dt')!.textContent;
    const dd = row.querySelector('dd')!.textContent;
    return `${dt}|${dd}`;
  });

describe('auditChanges — which fields are listed', () => {
  it('an update lists only the fields that differ', () => {
    const changes = auditChanges(
      { name: 'Brake pad', sku: 'PRD-1', minStock: '10.000', status: 'ACTIVE' },
      { name: 'Brake pad, front', sku: 'PRD-1', minStock: 10, status: 'ACTIVE' },
    );
    // "10.000" from Prisma's Decimal and 10 are the same figure.
    expect(changes).toEqual([{ key: 'name', mode: 'changed', from: 'Brake pad', to: 'Brake pad, front' }]);
  });

  it('an update that changed nothing lists nothing', () => {
    expect(auditChanges({ status: 'DRAFT' }, { status: 'DRAFT' })).toEqual([]);
  });

  it('bookkeeping columns are never listed, even when they differ', () => {
    const changes = auditChanges(
      { version: 1, updatedAt: '2026-10-17T10:00:00Z', name: 'A' },
      { version: 2, updatedAt: '2026-10-18T10:00:00Z', name: 'A' },
    );
    expect(changes).toEqual([]);
  });

  it('a create lists what was set, without ids or empty fields', () => {
    const changes = auditChanges(undefined, {
      id: UUID_A,
      customerId: UUID_B,
      displayName: 'Nile Motors',
      phone: null,
      email: '',
      version: 1,
    });
    expect(changes).toEqual([{ key: 'displayName', mode: 'set', to: 'Nile Motors' }]);
  });

  it('a delete lists what was removed', () => {
    expect(auditChanges({ id: UUID_A, name: 'Brakes' }, null)).toEqual([
      { key: 'name', mode: 'removed', from: 'Brakes' },
    ]);
  });

  it('nothing on either side lists nothing', () => {
    expect(auditChanges(null, undefined)).toEqual([]);
  });
});

describe('AuditChanges — what the reader sees', () => {
  it('Field: old → new, with the field name translated', () => {
    show(<AuditChanges entityType="Product" before={{ name: 'Brake pad' }} after={{ name: 'Brake pad, front' }} />);
    // The arrow is an icon, so the text runs old value straight into new.
    expect(lines()).toEqual(['Name|Brake padBrake pad, front']);
    expect(screen.getByLabelText('changed to')).toBeTruthy();
  });

  it('money is formatted in the record’s currency, and *Egp fields in pounds', () => {
    show(
      <AuditChanges
        entityType="SaleOrder"
        after={{ orderNo: 'ORD-2026-00003', currency: 'EGP', total: '1500', discount: '0.5', cogs: 980 }}
      />,
    );
    expect(lines()).toContain('Total|1,500.00 EGP');
    expect(lines()).toContain('Discount|0.50 EGP');
    expect(lines()).toContain('Cost of goods|980.00 EGP');
  });

  it('a refund in pounds says so even on a record in dollars', () => {
    show(<AuditChanges entityType="SaleReturn" after={{ currency: 'USD', refundEgp: '2400.5' }} />);
    expect(lines()).toContain('Refund|2,400.50 EGP');
  });

  it('Arabic: field names in Arabic, figures in Latin digits', () => {
    show(<AuditChanges entityType="SaleOrder" before={{ total: '1500', currency: 'EGP' }} after={{ total: '1750', currency: 'EGP' }} />, 'ar');
    expect(lines()).toEqual(['الإجمالي|1,500.00 EGP1,750.00 EGP']);
  });

  it('a status is said in words, by the record’s own kind of status', () => {
    show(<AuditChanges entityType="SaleOrder" before={{ status: 'DRAFT' }} after={{ status: 'CONFIRMED' }} />);
    expect(lines()).toEqual(['Status|DraftConfirmed']);
  });

  it('a calendar day is a date, a moment is a date and time', () => {
    show(
      <AuditChanges
        entityType="Payment"
        after={{ receivedOn: '2026-10-18T00:00:00.000Z', approvedAt: '2026-10-18T09:30:00.000Z' }}
      />,
    );
    expect(lines()).toContain('Received on|Oct 18, 2026');
    expect(lines().find((l) => l.startsWith('Approved at|'))).toMatch(/^Approved at\|Oct 18, 2026, \d{1,2}:30 (AM|PM)$/);
  });

  it('a phone number, a SKU or a reference is text, not a figure', () => {
    show(
      <AuditChanges
        entityType="Customer"
        before={{ phone: '01000000000', sku: '12345', barcode: '0042' }}
        after={{ phone: '01000000001', sku: '12346', barcode: '42' }}
      />,
    );
    // Seen on the real screen: "1,000,000,000 → 1,000,000,001" for a phone.
    // And "0042" → "42" is a different barcode, not the same number.
    expect(lines()).toEqual(['Phone|0100000000001000000001', 'SKU|1234512346', 'Barcode|004242']);
  });

  it('a field nobody named is shown under a readable name, not dropped', () => {
    show(<AuditChanges entityType="Product" after={{ shelfLocation: 'B-12' }} />);
    expect(lines()).toEqual(['Shelf location|B-12']);
  });

  it('an id that changed says so without printing either id', () => {
    const { container } = show(
      <AuditChanges entityType="Product" before={{ categoryId: UUID_A }} after={{ categoryId: UUID_B }} />,
    );
    expect(lines()).toEqual(['Category id|Changed to another record']);
    expect(container.textContent).not.toContain('3f2a91c0');
  });

  it('a list inside the record is counted, and a nested record named', () => {
    show(
      <AuditChanges
        entityType="SaleOrder"
        after={{ items: [{ qty: 1 }, { qty: 2 }], customer: { id: UUID_A, displayName: 'Nile Motors' } }}
      />,
    );
    expect(lines()).toEqual(['Items|2 items', 'Customer|Nile Motors']);
  });

  it('true and false read as yes and no', () => {
    show(<AuditChanges entityType="SaleOrder" after={{ walkIn: true }} />);
    expect(lines()).toEqual(['Walk-in sale|Yes']);
  });

  it('renders nothing when nothing changed', () => {
    const { container } = show(<AuditChanges entityType="SaleOrder" before={{ status: 'DRAFT' }} after={{ status: 'DRAFT' }} />);
    expect(container.textContent).toBe('');
  });
});

describe('humaniseKey', () => {
  it.each([
    ['unitWeightKg', 'Unit weight kg'],
    ['shelfLocation', 'Shelf location'],
    ['batch_count', 'Batch count'],
    ['totalEGPValue', 'Total egp value'],
  ])('%s → %s', (key, expected) => {
    expect(humaniseKey(key)).toBe(expected);
  });
});

describe('AuditRecord — the record by name, never by id', () => {
  it('a named record is linked to its page under the reader’s locale', () => {
    show(
      <AuditRecord
        log={{ entityType: 'SaleOrder', entityLabel: 'ORD-2026-00003', entityHref: `/sales/${UUID_A}/invoice` }}
      />,
    );
    const link = screen.getByRole('link', { name: 'ORD-2026-00003' });
    expect(link.getAttribute('href')).toBe(`/en/sales/${UUID_A}/invoice`);
  });

  it('money without a number reads as the shop and the sum', () => {
    show(
      <AuditRecord
        log={{ entityType: 'Payment', entityLabel: 'Nile Motors', entityAmount: { value: '1500', currency: 'EGP' } }}
      />,
    );
    expect(screen.getByText('Nile Motors · 1,500.00 EGP')).toBeTruthy();
  });

  it('a deleted record reads as its type, with no link and no id', () => {
    const { container } = show(
      <AuditRecord log={{ entityType: 'Category', entityLabel: null, entityHref: `/categories/${UUID_A}` }} />,
    );
    expect(container.textContent).toBe('Category');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('the Arabic name is used on an Arabic screen', () => {
    show(
      <AuditRecord log={{ entityType: 'Product', entityLabel: 'Brake pad (PRD-1)', entityLabelAr: 'تيل فرامل (PRD-1)' }} />,
      'ar',
    );
    expect(screen.getByText('تيل فرامل (PRD-1)')).toBeTruthy();
  });

  it('an unknown type reads as its type name', () => {
    const { container } = show(<AuditRecord log={{ entityType: 'SomethingNew' }} />);
    expect(container.textContent).toBe('SomethingNew');
  });
});
