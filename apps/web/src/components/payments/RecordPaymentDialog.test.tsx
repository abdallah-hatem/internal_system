import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { RecordPaymentDialog, type PaymentOrder } from './RecordPaymentDialog';

// `post` records calls; `answer` decides the reply, per URL. Kept apart because
// a vi.fn returning a rejected promise chains its own copy nobody listens to.
const post = vi.fn();
let answer: (url: string, body: unknown) => Promise<unknown> = () => new Promise(() => {});
let orders: unknown[] = [];
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      post(url, body);
      return answer(url, body);
    },
    get: (url: string) =>
      Promise.resolve({ data: { data: url.startsWith('/sales/orders') ? orders : [] } }),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const ORDER: PaymentOrder = {
  id: 'o-chosen',
  orderNo: 'ORD-2026-00042',
  customerId: 'c-shop',
  customer: { displayName: 'Nile Motors' },
  status: 'PARTIALLY_PAID',
  outstanding: '800.00',
  currency: 'EGP',
};

function renderDialog(props: Partial<React.ComponentProps<typeof RecordPaymentDialog>> = {}) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <RecordPaymentDialog open onClose={onClose} {...props} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onClose };
}

const amountInput = () => document.querySelector<HTMLInputElement>('#payment-amount')!;
const hidden = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)!;
const save = () => screen.getByRole('button', { name: 'Save' });

function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

const refusal = (code: string, params: Record<string, string>) =>
  Promise.reject({ response: { data: { error: { code, message: 'English fallback', params } } } });

beforeEach(() => {
  post.mockReset();
  answer = () => new Promise(() => {});
  orders = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RecordPaymentDialog opened from an order', () => {
  it("shows that order's outstanding and defaults the amount to it", () => {
    renderDialog({ order: ORDER });
    expect(screen.getByRole('heading', { name: /ORD-2026-00042/ })).toBeTruthy();
    expect(screen.getByTestId('payment-owed').textContent).toMatch(/ORD-2026-00042 owes/);
    expect(screen.getByTestId('payment-owed').textContent).toMatch(/800\.00/);
    expect(hidden('amount').value).toBe('800.00');
    expect(amountInput().value).toBe('800.00');
  });

  it("the date defaults to Cairo's today, not the browser's", () => {
    // 23:30 UTC on 15 Dec is 01:30 on the 16th in Cairo; the test machine is UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T23:30:00Z'));
    renderDialog({ order: ORDER });
    expect(hidden('receivedOn').value).toBe('2026-12-16');
  });

  it('posts with orderId, so the money goes on that order', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'pay-1' } } });
    const { onClose } = renderDialog({ order: ORDER });
    typeInto(amountInput(), '500');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/payments');
    expect(post.mock.calls[0][1]).toMatchObject({
      customerId: 'c-shop',
      orderId: 'o-chosen',
      amount: 500,
      method: 'CASH',
    });
  });

  it('stays open with every value on a refusal, and says it translated', async () => {
    answer = () => refusal('PAYMENT_EXCEEDS_ORDER', { order: 'ORD-2026-00042', owed: '300.00', asked: '500.00' });
    const { onClose } = renderDialog({ order: ORDER });
    typeInto(amountInput(), '500');
    typeInto(document.querySelector<HTMLInputElement>('#payment-reference')!, 'RCPT-7');
    fireEvent.click(save());

    const alert = await screen.findByTestId('payment-refusal');
    expect(alert.textContent).toBe('Order ORD-2026-00042 owes 300.00, so 500.00 cannot be paid on it.');
    expect(onClose).not.toHaveBeenCalled();
    expect(amountInput().value).toBe('500');
    expect(document.querySelector<HTMLInputElement>('#payment-reference')!.value).toBe('RCPT-7');
    // And it can be sent again once fixed.
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it('more than the order owes is caught before it is sent, in the server’s words', () => {
    renderDialog({ order: ORDER });
    typeInto(amountInput(), '900');
    fireEvent.click(save());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('payment-refusal').textContent).toBe(
      'Order ORD-2026-00042 owes 800.00, so 900.00 cannot be paid on it.',
    );
  });

  it('zero is caught before it is sent', () => {
    renderDialog({ order: ORDER });
    typeInto(amountInput(), '0');
    fireEvent.click(save());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('payment-refusal').textContent).toBe('A payment must be more than zero.');
  });

  it('Double submit → one payment', () => {
    renderDialog({ order: ORDER });
    // Two submits inside one frame: React has not re-rendered, so the button is
    // not yet disabled for the second — only the synchronous guard stops it.
    const form = save().closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(post).toHaveBeenCalledTimes(1);
    // And once re-rendered, the button itself is disabled.
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });

  it('methods read as words, the same as everywhere else', () => {
    renderDialog({ order: ORDER });
    expect(screen.getByRole('combobox').textContent).toBe('Cash');
  });
});

describe('RecordPaymentDialog opened from a customer', () => {
  it('shows what they owe in all and applies the money oldest first, drafts ignored', async () => {
    orders = [
      { id: 'o-new', status: 'CONFIRMED', outstanding: '800', createdAt: '2026-06-01T00:00:00Z' },
      { id: 'o-draft', status: 'DRAFT', outstanding: '999', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'o-old', status: 'PARTIALLY_PAID', outstanding: '500', createdAt: '2026-01-01T00:00:00Z' },
    ];
    answer = (url) =>
      Promise.resolve({ data: { data: url === '/payments' ? { id: 'pay-1' } : {} } });
    const { onClose } = renderDialog({ customer: { id: 'c-shop', displayName: 'Nile Motors' } });

    await waitFor(() =>
      expect(screen.getByTestId('payment-owed').textContent).toMatch(/1,300\.00/),
    );
    // No amount is guessed for a customer: what they pay is what they say.
    expect(amountInput().value).toBe('');

    typeInto(amountInput(), '700');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(post.mock.calls.map((c) => c[0])).toEqual([
      '/payments',
      '/payments/pay-1/allocations',
      '/payments/pay-1/allocations',
    ]);
    expect(post.mock.calls[0][1]).not.toHaveProperty('orderId');
    expect(post.mock.calls[1][1]).toEqual({ saleOrderId: 'o-old', amount: 500 });
    expect(post.mock.calls[2][1]).toEqual({ saleOrderId: 'o-new', amount: 200 });
  });
});

describe('one form for recording a payment (rule 11)', () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('The payments page form and the customer page form are the same component', () => {
    const pages = [
      read('../../app/[locale]/payments/page.tsx'),
      read('../../app/[locale]/customers/[id]/page.tsx'),
      read('../../app/[locale]/sales/page.tsx'),
    ];
    for (const source of pages) {
      expect(source).toMatch(/<RecordPaymentDialog\b/);
      // None of them records a payment by its own hand.
      expect(source).not.toMatch(/api\.post\(\s*['`]\/payments['`]/);
    }
  });
});
