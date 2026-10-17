import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import InvoicePage from './page';

/**
 * The invoice's Download PDF / Share PDF / Print — the same DocumentActions as
 * the contract (owner, 2026-10-17: "invoice as well should have all the
 * options like the contract"). The PDF itself is lib/document-pdf.ts, mocked
 * here; what is checked is what the page hands it.
 */

const state = vi.hoisted(() => ({ locale: 'en' }));

const pdf = vi.hoisted(() => ({
  canShare: false,
  canPrint: true,
  documentToPdf: vi.fn(),
  downloadBlob: vi.fn(),
  sharePdf: vi.fn(),
  printPdf: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useParams: () => ({ id: 'sale-1', locale: state.locale }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/${state.locale}/sales/sale-1/invoice`,
  useSearchParams: () => new URLSearchParams(),
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
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) =>
      url === '/sales/orders/sale-1/invoice' ? Promise.resolve({ data: { data: INVOICE } }) : Promise.reject(new Error(url)),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const INVOICE = {
  id: 'sale-1',
  orderNo: 'ORD-2026-00002',
  status: 'CONFIRMED',
  currency: 'EGP',
  date: '2026-10-13',
  customer: { id: 'c-1', displayName: 'Koshary', phone: null, isWalkIn: false },
  lines: [
    { id: 'l1', product: 'Q58 Max Intercom', productAr: null, sku: 'Q58', quantity: '4', unitPrice: '1250.00', discount: '0.00', lineTotal: '5000.00' },
    { id: 'l2', product: 'Y30 Headset', productAr: null, sku: 'Y30', quantity: '10', unitPrice: '1200.00', discount: '100.00', lineTotal: '11900.00' },
  ],
  subtotal: '17000.00',
  discount: '100.00',
  total: '16900.00',
  paid: '0.00',
  credited: '0.00',
  returned: false,
  owes: '16900.00',
  account: { balanceBefore: '0.00', balanceAfter: '16900.00', balanceNow: '16900.00' },
};

function renderPage(locale: 'en' | 'ar') {
  state.locale = locale;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <InvoicePage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
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

describe('the invoice in Arabic or English, Arabic first (owner, 2026-10-17)', () => {
  for (const appLocale of ['en', 'ar'] as const) {
    it(`opens in Arabic, right to left, even when the app is in ${appLocale}`, async () => {
      renderPage(appLocale);
      const doc = await screen.findByTestId('invoice');
      expect(doc.getAttribute('lang')).toBe('ar');
      expect(doc.getAttribute('dir')).toBe('rtl');
      expect(doc.textContent).toContain(ar.sales.invoice.title);
      expect(screen.getByTestId('invoice-lang-ar').getAttribute('aria-pressed')).toBe('true');
    });
  }

  it('the switch turns the invoice — its words, dates and numbers — to English and back, the app around it unchanged', async () => {
    renderPage('ar');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-lang-en'));
    const doc = screen.getByTestId('invoice');
    expect(doc.getAttribute('dir')).toBe('ltr');
    expect(doc.className).toContain('text-start');
    expect(doc.textContent).toContain(en.sales.invoice.title);
    expect(doc.textContent).toContain('Oct 13, 2026');
    // The back link is the app's, still in the app's language.
    expect(screen.getByText(ar.sales.invoice.back)).toBeTruthy();

    fireEvent.click(screen.getByTestId('invoice-lang-ar'));
    expect(screen.getByTestId('invoice').getAttribute('dir')).toBe('rtl');
  });

  it('the PDF follows the switch: Arabic sheet and page numbers by default', async () => {
    renderPage('en');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-download'));
    await waitFor(() => expect(pdf.documentToPdf).toHaveBeenCalledOnce());
    const [sheet, options] = pdf.documentToPdf.mock.calls[0] as [HTMLElement, { dir: string; pageLabel: (n: number, t: number) => string }];
    expect(sheet.getAttribute('dir')).toBe('rtl');
    expect(sheet.textContent).toContain(ar.sales.invoice.title);
    expect(options.pageLabel(1, 2)).toBe('صفحة 1 من 2');
  });
});

describe('the invoice as a PDF', () => {
  it('Download PDF: an A4-wide sheet of this invoice in the chosen language, saved under the order number', async () => {
    renderPage('ar');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-lang-en'));
    fireEvent.click(screen.getByTestId('invoice-download'));

    await waitFor(() => expect(pdf.downloadBlob).toHaveBeenCalledOnce());
    const [sheet, options] = pdf.documentToPdf.mock.calls[0] as [HTMLElement, { dir: string; pageLabel: (n: number, t: number) => string }];
    expect(sheet.hasAttribute('data-pdf-sheet')).toBe(true);
    expect(sheet.style.width).toBe('794px');
    expect(sheet.textContent).toContain('ORD-2026-00002');
    expect(sheet.textContent).toContain('Y30 Headset');
    expect(options.dir).toBe('ltr');
    expect(options.pageLabel(2, 3)).toBe('Page 2 of 3');
    expect(pdf.downloadBlob.mock.calls[0][1]).toBe('ORD-2026-00002.pdf');
    // The sheet is there only while the PDF is made: one invoice on the page after.
    await waitFor(() => expect(screen.getAllByTestId('invoice')).toHaveLength(1));
  });

  it('every column is on the sheet, the ones a phone hides included', async () => {
    renderPage('en');
    await screen.findByTestId('invoice');
    let cells: string[] = [];
    pdf.documentToPdf.mockImplementationOnce(async (sheet: HTMLElement) => {
      // The phone-hidden columns carry sheet:table-cell, so the sheet shows
      // them at any screen width; the phone's stacked line under the name hides.
      cells = [...sheet.querySelectorAll('td.hidden')].map((td) => td.className);
      return new Blob(['%PDF']);
    });
    fireEvent.click(screen.getByTestId('invoice-download'));
    await waitFor(() => expect(pdf.downloadBlob).toHaveBeenCalledOnce());
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain('sheet:table-cell');
  });

  it('in Arabic the sheet runs right to left and numbers its pages in Arabic', async () => {
    renderPage('ar');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-download'));
    await waitFor(() => expect(pdf.documentToPdf).toHaveBeenCalledOnce());
    const [sheet, options] = pdf.documentToPdf.mock.calls[0] as [HTMLElement, { dir: string; pageLabel: (n: number, t: number) => string }];
    expect(sheet.getAttribute('dir')).toBe('rtl');
    expect(options.dir).toBe('rtl');
    expect(options.pageLabel(1, 2)).toBe('صفحة 1 من 2');
  });

  it('Print prints the PDF where the browser can, and the page print where it cannot', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderPage('en');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-print'));
    await waitFor(() => expect(pdf.printPdf).toHaveBeenCalledOnce());
    expect(print).not.toHaveBeenCalled();
    cleanup();

    pdf.canPrint = false;
    renderPage('en');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-print'));
    expect(print).toHaveBeenCalledOnce();
    expect(pdf.printPdf).toHaveBeenCalledOnce();
  });

  it('Share PDF only where a file can be shared; a second press while busy does nothing', async () => {
    renderPage('en');
    await screen.findByTestId('invoice');
    expect(screen.queryByTestId('invoice-share')).toBeNull();
    cleanup();

    pdf.canShare = true;
    let release!: () => void;
    pdf.documentToPdf.mockImplementationOnce(() => new Promise<Blob>((r) => (release = () => r(new Blob(['%PDF'])))));
    renderPage('en');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-share'));
    await waitFor(() => expect(pdf.documentToPdf).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId('invoice-share'));
    fireEvent.click(screen.getByTestId('invoice-download'));
    expect(pdf.documentToPdf).toHaveBeenCalledOnce();
    release();
    await waitFor(() => expect(pdf.sharePdf).toHaveBeenCalledOnce());
    expect(pdf.sharePdf.mock.calls[0][1]).toBe('ORD-2026-00002.pdf');
    expect(pdf.downloadBlob).not.toHaveBeenCalled();
  });

  it('a PDF that cannot be made says so, and the buttons come back', async () => {
    pdf.documentToPdf.mockRejectedValueOnce(new Error('canvas'));
    renderPage('en');
    await screen.findByTestId('invoice');
    fireEvent.click(screen.getByTestId('invoice-download'));
    await waitFor(() => expect(pdf.toastError).toHaveBeenCalledWith('Could not make the PDF. Try again.'));
    expect(screen.getByTestId('invoice-download').hasAttribute('disabled')).toBe(false);
  });
});
