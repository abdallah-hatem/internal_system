import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { ExchangeRates, type RateRow } from './exchange-rates';

/**
 * The exchange-rate page (BUSINESS_LOGIC §22, owner 2026-10-16): every
 * currency, its rate to EGP and when it last changed; a core partner changes
 * or adds one, everyone else reads.
 */

const role = vi.hoisted(() => ({ current: 'CORE_PARTNER' }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: role.current }, isLoading: false }),
}));

const calls = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  list: null as null | (() => Promise<unknown>),
  answer: (() => Promise.resolve({ data: { data: {} } })) as () => Promise<unknown>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      calls('get', url);
      if (url === '/currency-rates') return state.list ? state.list() : Promise.resolve({ data: { data: state.rows } });
      return Promise.resolve({ data: { data: {} } });
    },
    put: (url: string, body: unknown) => {
      calls('put', url, body);
      return state.answer();
    },
    post: (url: string, body: unknown) => {
      calls('post', url, body);
      return state.answer();
    },
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

const ROWS: RateRow[] = [
  { code: 'AED', rateToEgp: '13.8500', updatedAt: '2026-10-14T09:00:00.000Z' },
  { code: 'CNY', rateToEgp: null, updatedAt: '2026-10-01T09:00:00.000Z' },
  { code: 'EGP', rateToEgp: '1.0000', updatedAt: '2026-08-01T09:00:00.000Z' },
];

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ExchangeRates />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const rowOf = (code: string) => document.querySelector<HTMLElement>(`[data-testid="rate-row"][data-code="${code}"]`)!;
const rateInput = () => screen.getByTestId('rate-input') as HTMLInputElement;
const refusal = (code: string, params: Record<string, string | number> = {}) =>
  Promise.reject({ response: { data: { error: { code, message: 'English fallback', params } } } });

beforeEach(() => {
  calls.mockReset();
  role.current = 'CORE_PARTNER';
  state.rows = ROWS;
  state.list = null;
  state.answer = () => Promise.resolve({ data: { data: {} } });
});
afterEach(cleanup);

describe('the exchange-rate page', () => {
  it('lists every currency with its rate to EGP and when it last changed, and says the rates only prefill forms', async () => {
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    expect(within(rowOf('AED')).getByTestId('rate-value').textContent).toBe('13.85');
    expect(rowOf('AED').textContent).toMatch(/Oct 14, 2026/);
    expect(rowOf('CNY').textContent).toContain(en.fxRates.noRate);
    expect(screen.getByTestId('prefill-only').textContent).toBe(en.fxRates.prefillOnly);
  });

  it('EGP is the base currency: no edit offered', async () => {
    renderPage();
    await waitFor(() => expect(rowOf('EGP')).toBeTruthy());
    expect(rowOf('EGP').textContent).toContain(en.fxRates.base);
    expect(within(rowOf('EGP')).queryByTestId('edit-rate')).toBeNull();
    expect(within(rowOf('AED')).getByTestId('edit-rate')).toBeTruthy();
  });

  it('while loading: skeleton rows, never a spinner', () => {
    state.list = () => new Promise(() => {});
    renderPage();
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
  });

  it('no currencies: the empty state, with Add for a partner', async () => {
    state.rows = [];
    renderPage();
    expect(await screen.findAllByText(en.fxRates.emptyTitle)).not.toHaveLength(0);
  });

  it('a partner changes a rate: the dialog starts at the current rate, sends the new one, and the list and the forms’ map are read again', async () => {
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    fireEvent.click(within(rowOf('AED')).getByTestId('edit-rate'));
    expect(rateInput().value).toBe('13.85');
    fireEvent.change(rateInput(), { target: { value: '13.9125' } });
    calls.mockClear();
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('put', '/currency-rates/AED', { rateToEgp: 13.9125 }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('get', '/currency-rates'));
    await waitFor(() => expect(document.querySelector('[data-fx-dialog="edit"]')).toBeNull());
  });

  it('a refused rate stays in the dialog, translated, with what was typed', async () => {
    state.answer = () => refusal('RATE_TOO_PRECISE', { rate: '13.12345', decimals: 4 });
    renderPage('ar');
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    fireEvent.click(within(rowOf('AED')).getByTestId('edit-rate'));
    fireEvent.change(rateInput(), { target: { value: '13.12345' } });
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    const shown = await screen.findByTestId('fx-refusal');
    expect(shown.textContent).toBe(ar.errors.RATE_TOO_PRECISE.replace('{decimals}', '4').replace('{rate}', '13.12345'));
    expect(rateInput().value).toBe('13.12345');
  });

  it('only digits and one decimal point reach the rate', async () => {
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    fireEvent.click(within(rowOf('AED')).getByTestId('edit-rate'));
    fireEvent.change(rateInput(), { target: { value: '-1x3.5' } });
    expect(rateInput().value).toBe('13.5');
  });

  it('a partner adds a currency: the code is three letters, upper-cased, sent with its rate', async () => {
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    fireEvent.click(screen.getByTestId('add-currency'));
    const code = screen.getByTestId('code-input') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'gb1px' } });
    expect(code.value).toBe('GBP');
    fireEvent.change(rateInput(), { target: { value: '64.2' } });
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-fx-dialog="add"]')!).getByRole('button', { name: en.fxRates.add }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('post', '/currency-rates', { code: 'GBP', rateToEgp: 64.2 }));
  });

  it('adding one already there reads CURRENCY_EXISTS in the reader’s words, and the dialog keeps it', async () => {
    state.answer = () => refusal('CURRENCY_EXISTS', { currency: 'AED' });
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    fireEvent.click(screen.getByTestId('add-currency'));
    fireEvent.change(screen.getByTestId('code-input'), { target: { value: 'AED' } });
    fireEvent.change(rateInput(), { target: { value: '14' } });
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-fx-dialog="add"]')!).getByRole('button', { name: en.fxRates.add }));
    expect((await screen.findByTestId('fx-refusal')).textContent).toBe(en.errors.CURRENCY_EXISTS.replace('{currency}', 'AED'));
    expect((screen.getByTestId('code-input') as HTMLInputElement).value).toBe('AED');
  });

  it.each(['ADMIN_SUPPORT', 'TEMP_INVESTOR'])('%s reads the rates but is offered no change and no add', async (r) => {
    role.current = r;
    renderPage();
    await waitFor(() => expect(rowOf('AED')).toBeTruthy());
    expect(screen.queryByTestId('add-currency')).toBeNull();
    expect(screen.queryAllByTestId('edit-rate')).toHaveLength(0);
  });
});
