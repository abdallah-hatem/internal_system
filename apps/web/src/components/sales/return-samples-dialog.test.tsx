import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * "Returned" on a samples order picks what came back (BUSINESS_LOGIC §4, owner
 * 2026-10-28: "I should be able to pick which sample a shop returned"),
 * reached the way a partner reaches it: the Sales list, the order, Returned.
 * Each product the shop holds, all of it by default; lower it or 0 for what
 * stays. The second visit (CLAUDE.md §0): Cancel forgets what was typed.
 */

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/sales',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const data = vi.hoisted(() => ({ orders: [] as unknown[], detail: {} as Record<string, unknown> }));
const post = vi.hoisted(() => vi.fn((...args: unknown[]) => new Promise(() => void args)));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      const page = (rows: unknown[]) =>
        Promise.resolve({
          data: { data: rows, meta: { nextCursor: null, page: 1, pageSize: 10, total: rows.length, totalPages: 1 } },
        });
      if (url === '/sales/orders') return page(data.orders);
      const m = url.match(/^\/sales\/orders\/([^/]+)$/);
      if (m) return Promise.resolve({ data: { data: data.detail[m[1]] } });
      return page([]);
    },
    post: (...args: unknown[]) => post(...args),
  },
}));

import SalesPage from '@/app/[locale]/sales/page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const item = (id: string, productId: string, name: string, quantity: string) => ({
  id,
  productId,
  product: { name, nameAr: `${name} (ع)`, sku: `${productId.toUpperCase()}-1` },
  quantity,
  unitPrice: '0',
  discount: '0',
  lineTotal: '0',
  allocations: [{ id: `a-${id}`, inventoryBatchId: `b-${id}`, qty: quantity, unitCostEgp: '100', cogsEgp: '0' }],
});

// Five piston kits on two lines (two batches) and two chains.
const SAMPLES_ORDER = {
  id: 'o-s',
  orderNo: 'ORD-2026-00042',
  customerId: 'c-1',
  customer: { displayName: 'Nile Motors' },
  channel: 'B2B',
  status: 'SAMPLES',
  total: '0.00',
  outstanding: '0.00',
  currency: 'EGP',
  version: 7,
  createdAt: '2026-10-08T09:00:00.000Z',
  orderedAt: '2026-10-08T09:00:00.000Z',
  items: [
    item('i-1', 'p-1', 'Piston kit', '3'),
    item('i-2', 'p-1', 'Piston kit', '2'),
    item('i-3', 'p-2', 'Chain', '2'),
  ],
  samples: {
    open: true,
    unitsOut: '7',
    leftOn: '2026-10-08',
    daysAtShop: 10,
    reminderOn: '2026-10-22',
    remindedAt: null,
    decidedAt: null,
  },
};

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SalesPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The Sales list → the order → Returned, as a partner clicks it. */
async function openReturned() {
  const table = await screen.findByTestId('sales-table');
  fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
  fireEvent.click(await screen.findByTestId('samples-returned'));
  return screen.findByTestId('samples-return-dialog');
}

const rowOf = (dialog: HTMLElement, productId: string) =>
  dialog.querySelector<HTMLElement>(`[data-testid="samples-return-row"][data-product="${productId}"]`)!;
const qtyOf = (dialog: HTMLElement, productId: string) =>
  rowOf(dialog, productId).querySelector<HTMLInputElement>('[data-field="returned"]')!;
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const confirm = () => screen.getByTestId('samples-return-confirm') as HTMLButtonElement;

describe('Returned — some samples, not all', () => {
  beforeEach(() => {
    data.orders = [SAMPLES_ORDER];
    data.detail = { 'o-s': SAMPLES_ORDER };
    post.mockReset();
    post.mockImplementation(() => new Promise(() => {}));
  });

  it('lists each product the shop holds, once, with its units at the shop, and every one defaults to all', async () => {
    renderPage();
    const dialog = await openReturned();
    const rows = within(dialog).getAllByTestId('samples-return-row');
    expect(rows.map((r) => r.getAttribute('data-product'))).toEqual(['p-1', 'p-2']);
    expect(rows[0].textContent).toContain('Piston kit');
    expect(rows[0].textContent).toContain('5 at the shop');
    expect(qtyOf(dialog, 'p-1').value).toBe('5');
    expect(qtyOf(dialog, 'p-2').value).toBe('2');
    expect(within(dialog).getByTestId('samples-return-summary').textContent).toBe(en.sales.samples.returnBody);
  });

  it('all, untouched: posts every product at what is out, with the shop and the version it showed', async () => {
    renderPage();
    await openReturned();
    fireEvent.click(confirm());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/sales/orders/o-s/samples/return');
    expect(post.mock.calls[0][1]).toEqual({
      lines: [
        { productId: 'p-1', quantity: 5 },
        { productId: 'p-2', quantity: 2 },
      ],
      customerId: 'c-1',
      version: 7,
    });
  });

  it('some: a lowered product sends what was typed, a 0 is left out, and the dialog says what stays', async () => {
    renderPage();
    const dialog = await openReturned();
    type(qtyOf(dialog, 'p-1'), '1');
    type(qtyOf(dialog, 'p-2'), '0');
    expect(within(dialog).getByTestId('samples-return-summary').textContent).toBe(
      '1 unit goes back on the shelf, to the batch each came from; 6 stay at the shop as samples. Nothing is sold and nothing is owed.',
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ lines: [{ productId: 'p-1', quantity: 1 }] });
  });

  it('none: every product at 0 says nothing is coming back, and Put back cannot be pressed', async () => {
    renderPage();
    const dialog = await openReturned();
    type(qtyOf(dialog, 'p-1'), '0');
    type(qtyOf(dialog, 'p-2'), '0');
    expect(within(dialog).getByTestId('samples-return-summary').textContent).toBe(en.sales.samples.returnNothing);
    expect(confirm().disabled).toBe(true);
    fireEvent.submit(confirm().closest('form')!);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['more than is out', '6'],
    ['a negative number', '-1'],
    ['nothing at all', ''],
  ])('%s: the field says the range, and nothing is sent', async (_what, value) => {
    renderPage();
    const dialog = await openReturned();
    type(qtyOf(dialog, 'p-1'), value);
    expect(within(rowOf(dialog, 'p-1')).getByTestId('samples-return-invalid').textContent).toBe('From 0 to 5');
    expect(confirm().disabled).toBe(true);
    fireEvent.submit(confirm().closest('form')!);
    expect(post).not.toHaveBeenCalled();
  });

  it('the second visit: Cancel forgets what was typed, and Returned opens on all again', async () => {
    renderPage();
    let dialog = await openReturned();
    type(qtyOf(dialog, 'p-1'), '1');
    type(qtyOf(dialog, 'p-2'), '0');
    fireEvent.click(within(dialog.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: en.common.cancel }));
    await waitFor(() => expect(screen.queryByTestId('samples-return-dialog')).toBeNull());

    fireEvent.click(await screen.findByTestId('samples-returned'));
    dialog = await screen.findByTestId('samples-return-dialog');
    expect(qtyOf(dialog, 'p-1').value).toBe('5');
    expect(qtyOf(dialog, 'p-2').value).toBe('2');
    fireEvent.click(confirm());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({
      lines: [
        { productId: 'p-1', quantity: 5 },
        { productId: 'p-2', quantity: 2 },
      ],
    });
  });

  it("the server's refusal is shown in the dialog, translated from its code, and the dialog stays open with what was typed", async () => {
    post.mockImplementation(() =>
      Promise.reject({
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: {
              code: 'SAMPLES_RETURN_MORE_THAN_OUT',
              message: 'Only 4 of Piston kit went out on ORD-2026-00042; 5 cannot come back.',
              params: { order: 'ORD-2026-00042', product: 'Piston kit', out: '4', returned: '5' },
            },
          },
        },
      }),
    );
    renderPage();
    const dialog = await openReturned();
    type(qtyOf(dialog, 'p-2'), '1');
    fireEvent.click(confirm());
    const refusal = await screen.findByTestId('samples-return-refusal');
    expect(refusal.textContent).toBe('Only 4 of Piston kit went out on ORD-2026-00042; 5 cannot come back.');
    expect(screen.getByTestId('samples-return-dialog')).toBeTruthy();
    expect(qtyOf(screen.getByTestId('samples-return-dialog'), 'p-2').value).toBe('1');
  });

  it('done with some kept: the toast says the rest stay at the shop', async () => {
    post.mockImplementation(() => Promise.resolve({ data: { data: { ...SAMPLES_ORDER, status: 'SAMPLES' } } }));
    renderPage();
    const dialog = await openReturned();
    type(qtyOf(dialog, 'p-1'), '2');
    fireEvent.click(confirm());
    expect(await screen.findByText(en.sales.samples.partReturnedToast)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('samples-return-dialog')).toBeNull());
  });

  it('Arabic: the products by their Arabic names, the prompt and the range in Arabic', async () => {
    renderPage('ar');
    const dialog = await openReturned();
    expect(rowOf(dialog, 'p-1').textContent).toContain('Piston kit (ع)');
    expect(dialog.textContent).toContain(ar.sales.samples.returnPick);
    type(qtyOf(dialog, 'p-2'), '9');
    expect(within(rowOf(dialog, 'p-2')).getByTestId('samples-return-invalid').textContent).toBe('من 0 إلى 2');
  });
});
