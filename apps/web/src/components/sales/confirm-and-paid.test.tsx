import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';

/**
 * Confirm & paid in one step (BUSINESS_LOGIC §4, owner 2026-10-27): the button
 * on a draft in the Sales order popup, reached the way a partner reaches it —
 * the list, a click on the order — and the third button in New Order.
 */

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

const data = vi.hoisted(() => ({
  orders: [] as unknown[],
  detail: {} as Record<string, unknown>,
}));
// `post` records what was sent; `answer` is what the API replies, kept apart so
// a rejected reply never rejects with nobody listening.
const post = vi.fn();
let answer: (path: string) => Promise<unknown> = () => new Promise(() => {});
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      const page = (rows: unknown[]) =>
        Promise.resolve({
          data: { data: rows, meta: { nextCursor: null, page: 1, pageSize: 10, total: rows.length, totalPages: 1 } },
        });
      if (url === '/sales/orders') return page(data.orders);
      if (/^\/sales\/orders\/[^/]+\/history$/.test(url)) return Promise.resolve({ data: { data: null } });
      // No shop here holds samples (it would otherwise read as an order with id "samples-at-shop").
      if (url.startsWith('/sales/orders/samples-at-shop')) return Promise.resolve({ data: { data: [] } });
      const m = url.match(/^\/sales\/orders\/([^/]+)$/);
      if (m) return Promise.resolve({ data: { data: data.detail[m[1]] } });
      return page([]);
    },
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') return new Promise(() => {});
      post(path, ...args);
      return answer(path);
    },
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

const order = (id: string, orderNo: string, status: string, outstanding: string, version = 1) => ({
  id,
  orderNo,
  customerId: 'c-1',
  customer: { displayName: 'Koshary' },
  channel: 'B2B',
  status,
  total: '3750.00',
  outstanding,
  currency: 'EGP',
  version,
  createdAt: '2026-10-01T09:00:00.000Z',
  orderedAt: '2026-10-01T09:00:00.000Z',
  items: [
    {
      id: `${id}-i`,
      productId: 'p-1',
      product: { name: 'Q58', sku: 'Q58' },
      quantity: '3',
      unitPrice: '1250',
      discount: '0',
      lineTotal: '3750',
      allocations: [],
    },
  ],
  paymentAllocations: [],
  contractPlan: null,
  samples: null,
});

/** The refusal body the API sends (CLAUDE.md §9). */
const refused = (code: string, message: string) =>
  Promise.reject({ response: { data: { error: { code, message, params: {} } } } });

beforeEach(() => {
  post.mockClear();
  answer = () => new Promise(() => {});
  const draft = order('o-2', 'ORD-2026-00003', 'DRAFT', '3750.00', 4);
  const confirmed = order('o-1', 'ORD-2026-00002', 'CONFIRMED', '3750.00');
  const paid = order('o-3', 'ORD-2026-00004', 'PAID', '0.00');
  const cancelled = order('o-4', 'ORD-2026-00005', 'CANCELLED', '0.00');
  const samples = { ...order('o-5', 'ORD-2026-00006', 'SAMPLES_OPEN', '0.00'), total: '0.00' };
  data.orders = [draft, confirmed, paid, cancelled, samples];
  data.detail = { 'o-1': confirmed, 'o-2': draft, 'o-3': paid, 'o-4': cancelled, 'o-5': samples };
});
afterEach(cleanup);

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

async function openOrder(orderNo: string) {
  const table = await screen.findByTestId('sales-table');
  fireEvent.click((await within(table).findAllByText(orderNo))[0]);
}

describe('Confirm & paid in the order popup', () => {
  it('a draft offers it beside Confirm; one click sends one call with the version it was read at', async () => {
    renderPage();
    await openOrder('ORD-2026-00003');
    const button = await screen.findByTestId('order-confirm-paid');
    expect(button.textContent).toContain(en.sales.confirmAndPaid);
    expect(screen.getByRole('button', { name: en.sales.confirm })).toBeTruthy();
    expect(button.getAttribute('type')).toBe('button');

    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/sales/orders/o-2/confirm-and-pay');
    expect(post.mock.calls[0][1]).toEqual({ version: 4 });
  });

  it.each([
    ['confirmed', 'ORD-2026-00002'],
    ['paid', 'ORD-2026-00004'],
    ['cancelled', 'ORD-2026-00005'],
    ['samples at a shop', 'ORD-2026-00006'],
  ])('a %s order does not offer it', async (_label, orderNo) => {
    renderPage();
    await openOrder(orderNo);
    // The popup has drawn the order before anything is said about its buttons.
    await screen.findByTestId('tab-orderDetails');
    expect(screen.queryByTestId('order-confirm-paid')).toBeNull();
  });

  it('while it is saving, it spins and both it and Confirm are disabled, so a second click sends nothing', async () => {
    renderPage();
    await openOrder('ORD-2026-00003');
    const button = await screen.findByTestId('order-confirm-paid');
    fireEvent.click(button);

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.animate-spin')).toBeTruthy();
    expect((screen.getByRole('button', { name: en.sales.confirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: en.sales.confirm }));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a refusal is said in the reader’s language from its code, and the popup stays open on the draft', async () => {
    answer = () => refused('ONLY_DRAFT_CONFIRMABLE', 'Only draft orders can be confirmed');
    renderPage('ar');
    await openOrder('ORD-2026-00003');
    fireEvent.click(await screen.findByTestId('order-confirm-paid'));

    expect(await screen.findByText(ar.errors.ONLY_DRAFT_CONFIRMABLE)).toBeTruthy();
    const button = screen.getByTestId('order-confirm-paid') as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('done → the popup closes and says it was confirmed and paid', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o-2', status: 'PAID' } } });
    renderPage();
    await openOrder('ORD-2026-00003');
    fireEvent.click(await screen.findByTestId('order-confirm-paid'));

    expect(await screen.findByText(en.sales.orderConfirmedPaid)).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('order-confirm-paid')).toBeNull());
  });
});

// ── New Order ───────────────────────────────────────────────────────────

const SHOP = { id: 'c-shop', displayName: 'Nile Motors', type: 'B2B' };
const PISTON: SaleFormProduct = {
  id: 'p-piston',
  name: 'Piston kit',
  sku: 'PK-1',
  prices: [
    { channel: 'B2B', amount: 1800 },
    { channel: 'B2C', amount: 2100 },
  ],
  listPrices: {
    B2B: { amount: '1800.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '2100.00', currency: 'EGP', source: 'SET' },
  },
};

function renderForm(onSaved = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[SHOP]}
            products={[PISTON]}
            stock={[{ productId: PISTON.id, availableStock: 60 }]}
            title="New sale"
            onCancel={() => {}}
            onSaved={onSaved}
            initialCustomerId={SHOP.id}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onSaved };
}

/** Open a picker (the nth combobox) and click an option by its label. */
function pick(nth: number, label: string) {
  fireEvent.click(screen.getAllByRole('combobox')[nth]);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }));
}
const paidButton = () => screen.queryByTestId('sale-submit-paid') as HTMLButtonElement | null;
/** The product picker is the last combobox before the lines' own. */
function pickPiston() {
  const boxes = screen.getAllByRole('combobox');
  const productBox = boxes.findIndex((b) => b.closest('[data-testid="sale-line"]'));
  pick(productBox, 'Piston kit');
}

describe('Confirm & paid in New Order', () => {
  it('sits beside Save as draft and Create & confirm, and is never the first submit (Enter saves a draft)', () => {
    renderForm();
    const submits = Array.from(screen.getByTestId('sale-order-form').querySelectorAll('button[type="submit"]'));
    expect(submits.map((b) => b.textContent?.trim())).toEqual([
      en.sales.saveDraft,
      en.sales.createAndConfirm,
      en.sales.confirmAndPaid,
    ]);
  });

  it('sends the order with confirm and paid, once, and says so to the page', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o-9', orderNo: 'ORD-2026-00009', status: 'PAID' } } });
    const { onSaved } = renderForm();
    pickPiston();
    fireEvent.click(paidButton()!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body, config] = post.mock.calls[0];
    expect(path).toBe('/sales/orders');
    expect(body).toMatchObject({ customerId: SHOP.id, confirm: true, paid: true });
    expect('payment' in body).toBe(false);
    expect(config.headers['Idempotency-Key']).toBeTruthy();
    expect(onSaved.mock.calls[0][0]).toMatchObject({ confirmed: true, paid: true, walkIn: false });
  });

  it('Create & confirm still sends no paid, and a draft neither', async () => {
    const { onSaved } = renderForm();
    answer = () => Promise.resolve({ data: { data: { id: 'o-9', orderNo: 'ORD-2026-00009', status: 'CONFIRMED' } } });
    pickPiston();
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ confirm: true });
    expect('paid' in post.mock.calls[0][1]).toBe(false);
    expect(onSaved.mock.calls[0][0]).toMatchObject({ paid: false });
  });

  it('while it is saving every button is disabled and only it spins', async () => {
    renderForm();
    pickPiston();
    fireEvent.click(paidButton()!);
    await waitFor(() => expect(paidButton()!.disabled).toBe(true));
    expect(paidButton()!.querySelector('.animate-spin')).toBeTruthy();
    expect((screen.getByTestId('sale-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sale-submit').querySelector('.animate-spin')).toBeNull();
    fireEvent.click(paidButton()!);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a refusal shows translated in the form, which stays open as typed', async () => {
    answer = () => refused('ONLY_DRAFT_CONFIRMABLE', 'Only draft orders can be confirmed');
    const { onSaved } = renderForm();
    pickPiston();
    await act(async () => {
      fireEvent.click(paidButton()!);
    });
    expect(await screen.findByText(en.errors.ONLY_DRAFT_CONFIRMABLE)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    await waitFor(() => expect(paidButton()!.disabled).toBe(false));
  });

  it('not offered on a walk-in sale (already paid on confirm) nor on samples (not charged)', () => {
    renderForm();
    expect(paidButton()).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: en.sales.walkIn }));
    expect(paidButton()).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: en.sales.walkIn }));
    expect(paidButton()).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: new RegExp(en.sales.samples.switch) }));
    expect(paidButton()).toBeNull();
  });
});
