import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { CONTRACT_TEXT } from '@/components/sales/contract-text';
import type { SaleContract } from '@/components/sales/contract-document';
import SaleContractPage from './page';

/**
 * The printed contract (BUSINESS_LOGIC §7, 2026-10-16), built from the sale and
 * its plan: Arabic by default whatever the app's language, English on the switch.
 */

const state = vi.hoisted(() => ({
  locale: 'en',
  contract: null as unknown,
  refuse: false,
}));

const pdf = vi.hoisted(() => ({
  canShare: false,
  canPrint: true,
  documentToPdf: vi.fn(),
  downloadBlob: vi.fn(),
  sharePdf: vi.fn(),
  printPdf: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/document-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-pdf')>()),
  canSharePdf: () => pdf.canShare,
  canPrintPdf: () => pdf.canPrint,
  documentToPdf: pdf.documentToPdf,
  downloadBlob: pdf.downloadBlob,
  sharePdf: pdf.sharePdf,
  printPdf: pdf.printPdf,
}));
vi.mock('@/components/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toast')>()),
  toast: { error: pdf.toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ id: 'sale-1', locale: state.locale }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/${state.locale}/sales/sale-1/contract`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span data-testid="logo">{alt}</span>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url !== '/sales/orders/sale-1/contract') return Promise.reject(new Error(url));
      if (state.refuse) {
        return Promise.reject({
          response: { data: { error: { code: 'SALE_HAS_NO_PLAN', message: 'x', params: { order: 'ORD-2026-00001' } } } },
        });
      }
      return Promise.resolve({ data: { data: state.contract } });
    },
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const CONTRACT: SaleContract = {
  saleId: 'sale-1',
  orderNo: 'ORD-2026-00001',
  number: 'CT-ORD-2026-00001',
  date: '2026-10-16',
  currency: 'EGP',
  customer: { id: 'c-1', displayName: 'Al Nour Motors', phone: '01125550198' },
  lines: [
    { id: 'l1', product: 'Q58 Max Intercom', productAr: 'إنتركم Q58', sku: 'Q58', quantity: '10', unitPrice: '1250.00', discount: '0.00', lineTotal: '12500.00' },
    { id: 'l2', product: 'Y20 Headset', productAr: null, sku: 'Y20', quantity: '15', unitPrice: '980.00', discount: '0.00', lineTotal: '14700.00' },
  ],
  total: '35200.00',
  paidAtSigning: '10000.00',
  remaining: '25200.00',
  plan: {
    id: 'plan-1',
    reference: 'PLAN-2026-0001',
    status: 'ACTIVE',
    instalments: [
      { id: 'i1', sequence: 1, dueOn: '2026-11-16', amount: '8400.00' },
      { id: 'i2', sequence: 2, dueOn: '2026-12-16', amount: '8400.00' },
      { id: 'i3', sequence: 3, dueOn: '2027-01-16', amount: '8400.00' },
    ],
  },
};

function renderPage(locale: 'en' | 'ar') {
  state.locale = locale;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <SaleContractPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.contract = CONTRACT;
  state.refuse = false;
  pdf.canShare = false;
  pdf.canPrint = true;
  for (const fn of [pdf.documentToPdf, pdf.downloadBlob, pdf.sharePdf, pdf.printPdf, pdf.toastError]) fn.mockReset();
  pdf.documentToPdf.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
  pdf.sharePdf.mockResolvedValue(true);
  pdf.printPdf.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const text = (id: string) => screen.getByTestId(id).textContent;

describe('the contract page', () => {
  for (const appLocale of ['en', 'ar'] as const) {
    it(`opens in Arabic, right to left, even when the app is in ${appLocale}`, async () => {
      renderPage(appLocale);
      const doc = await screen.findByTestId('contract');
      expect(doc.getAttribute('dir')).toBe('rtl');
      expect(doc.getAttribute('lang')).toBe('ar');
      expect(text('contract-title')).toBe('عقد بيع بالتقسيط');
      expect(text('contract-number')).toBe('CT-ORD-2026-00001');
      expect(text('contract-date')).toBe('16/10/2026');
      expect(doc.textContent).toContain('القاهرة');
      // The font is named on the page, Arabic first (not the app's Latin-first stack).
      expect(doc.style.fontFamily.startsWith("'IBM Plex Sans Arabic'") || doc.style.fontFamily.startsWith('"IBM Plex Sans Arabic"')).toBe(true);
    });
  }

  it('in Arabic: the buyer, the goods by their Arabic names, the totals at signing, the schedule and the five terms', async () => {
    renderPage('en');
    await screen.findByTestId('contract');
    const buyer = screen.getByTestId('contract-buyer');
    expect(buyer.textContent).toContain('Al Nour Motors');
    expect(buyer.textContent).toContain('01125550198');

    const lines = screen.getAllByTestId('contract-line');
    expect(lines.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['1', 'إنتركم Q58', '10', '1,250.00 EGP', '12,500.00 EGP'],
      // No Arabic name: the English one, as everywhere else (§3).
      ['2', 'Y20 Headset', '15', '980.00 EGP', '14,700.00 EGP'],
    ]);
    expect([text('contract-total'), text('contract-paid'), text('contract-remaining')]).toEqual([
      '35,200.00 EGP', '10,000.00 EGP', '25,200.00 EGP',
    ]);
    const rows = screen.getAllByTestId('contract-instalment');
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['1', '16/11/2026', '8,400.00 EGP', ''],
      ['2', '16/12/2026', '8,400.00 EGP', ''],
      ['3', '16/01/2027', '8,400.00 EGP', ''],
    ]);
    const terms = within(screen.getByTestId('contract-terms')).getAllByRole('listitem');
    expect(terms.map((li) => li.textContent)).toEqual([...CONTRACT_TEXT.ar.clauses]);
    expect(screen.getByTestId('contract').textContent).toContain(CONTRACT_TEXT.ar.copies);
  });

  it('the switch turns the document to English, left to right, and back', async () => {
    renderPage('ar');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-lang-en'));

    const doc = screen.getByTestId('contract');
    expect(doc.getAttribute('dir')).toBe('ltr');
    // Aligned to its own start: the Arabic app's [dir=rtl] rule (globals.css)
    // otherwise right-aligned every English heading on the sheet.
    expect(doc.className).toContain('text-start');
    expect(text('contract-title')).toBe('Instalment Sale Contract');
    expect(doc.textContent).toContain('Cairo');
    expect(within(screen.getAllByTestId('contract-line')[0]).getAllByRole('cell')[1].textContent).toBe('Q58 Max Intercom');
    const terms = within(screen.getByTestId('contract-terms')).getAllByRole('listitem');
    expect(terms.map((li) => li.textContent)).toEqual([...CONTRACT_TEXT.en.clauses]);
    expect(text('contract-remaining')).toBe('25,200.00 EGP');
    expect(screen.getByTestId('contract-lang-en').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('contract-lang-ar'));
    expect(screen.getByTestId('contract').getAttribute('dir')).toBe('rtl');
  });

  it('the English terms are as many as the Arabic ones — a faithful version, clause for clause', () => {
    expect(CONTRACT_TEXT.en.clauses).toHaveLength(5);
    expect(CONTRACT_TEXT.ar.clauses).toHaveLength(5);
  });

  it('Print prints the PDF where the browser can — no browser header or footer on the sheet', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderPage('en');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-print'));
    await waitFor(() => expect(pdf.printPdf).toHaveBeenCalledOnce());
    expect(pdf.printPdf.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByTestId('contract-print').closest('.print\\:hidden')).not.toBeNull();
    expect(screen.getByTestId('contract').hasAttribute('data-print-doc')).toBe(true);
  });

  it('Print falls back to the page print where a PDF cannot be printed (Safari, phones)', async () => {
    pdf.canPrint = false;
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderPage('en');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-print'));
    expect(print).toHaveBeenCalledOnce();
    expect(pdf.documentToPdf).not.toHaveBeenCalled();
  });

  it('Download PDF: drawn from an A4-wide sheet in the chosen language, saved under the contract number', async () => {
    renderPage('ar');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-lang-en'));
    fireEvent.click(screen.getByTestId('contract-download'));

    await waitFor(() => expect(pdf.downloadBlob).toHaveBeenCalledOnce());
    const [sheet, options] = pdf.documentToPdf.mock.calls[0] as [HTMLElement, { dir: string; pageLabel: (n: number, t: number) => string }];
    expect(sheet.getAttribute('dir')).toBe('ltr');
    expect(sheet.style.width).toBe('794px');
    expect(sheet.textContent).toContain('Instalment Sale Contract');
    expect(options.dir).toBe('ltr');
    expect(options.pageLabel(2, 3)).toBe('Page 2 of 3');
    expect(pdf.downloadBlob.mock.calls[0][1]).toBe('CT-ORD-2026-00001.pdf');
    // The sheet exists only while the PDF is being made, so the page never holds two contracts.
    await waitFor(() => expect(screen.getAllByTestId('contract')).toHaveLength(1));
  });

  it('a second press while the PDF is being made does nothing — every button is busy until it is done', async () => {
    let release!: () => void;
    pdf.documentToPdf.mockImplementationOnce(() => new Promise<Blob>((r) => (release = () => r(new Blob(['%PDF'])))));
    renderPage('en');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-download'));
    await waitFor(() => expect(pdf.documentToPdf).toHaveBeenCalledOnce());

    expect(screen.getByTestId('contract-download').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('contract-print').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('contract-download'));
    fireEvent.click(screen.getByTestId('contract-print'));
    expect(pdf.documentToPdf).toHaveBeenCalledOnce();

    release();
    await waitFor(() => expect(screen.getByTestId('contract-download').hasAttribute('disabled')).toBe(false));
    expect(pdf.downloadBlob).toHaveBeenCalledOnce();
    expect(pdf.printPdf).not.toHaveBeenCalled();
  });

  it('Share PDF appears only where the browser can share a file, and hands over the PDF', async () => {
    renderPage('en');
    await screen.findByTestId('contract');
    expect(screen.queryByTestId('contract-share')).toBeNull();
    cleanup();

    pdf.canShare = true;
    renderPage('en');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-share'));
    await waitFor(() => expect(pdf.sharePdf).toHaveBeenCalledOnce());
    expect(pdf.sharePdf.mock.calls[0][1]).toBe('CT-ORD-2026-00001.pdf');
    expect(pdf.sharePdf.mock.calls[0][2]).toBe('عقد بيع بالتقسيط CT-ORD-2026-00001');
  });

  it('a PDF that cannot be made says so, and the buttons come back', async () => {
    pdf.documentToPdf.mockRejectedValueOnce(new Error('canvas'));
    renderPage('en');
    await screen.findByTestId('contract');
    fireEvent.click(screen.getByTestId('contract-download'));
    await waitFor(() => expect(pdf.toastError).toHaveBeenCalledWith('Could not make the PDF. Try again.'));
    expect(pdf.downloadBlob).not.toHaveBeenCalled();
    expect(screen.getByTestId('contract-download').hasAttribute('disabled')).toBe(false);
  });

  it('the sheet carries no page number of its own — "1 of 1" is never printed', async () => {
    renderPage('en');
    const doc = await screen.findByTestId('contract');
    expect(doc.textContent).not.toContain('صفحة');
    fireEvent.click(screen.getByTestId('contract-lang-en'));
    expect(screen.getByTestId('contract').textContent).not.toContain('Page');
    expect(CONTRACT_TEXT.ar.page(1, 2)).toBe('صفحة 1 من 2');
  });

  it('a sale with no plan: the refusal in words, no document', async () => {
    state.refuse = true;
    renderPage('en');
    const refused = await screen.findByTestId('contract-refused');
    expect(refused.textContent).toContain('Order ORD-2026-00001 has no instalment plan, so it has no contract.');
    expect(screen.queryByTestId('contract')).toBeNull();
  });
});
