import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { PaidByFriend, type FinanceableOrder } from './paid-by-friend';

/**
 * "Paid by a friend" — in his own currency at that day's rate (BUSINESS_LOGIC
 * §18, owner 2026-10-16). The form a partner records it with.
 */

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-partner', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The `+` beside the lender picker opens the Lenders tab's own form; not under test here.
vi.mock('@/components/ui/quick-create', () => ({
  FieldWithQuickCreate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const post = vi.fn();
let answer: () => Promise<unknown> = () => new Promise(() => {});
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      post(url, body);
      return answer();
    },
    get: (url: string) => {
      if (url === '/currency-rates/map') return Promise.resolve({ data: { data: { AED: 13.85, USD: 50.86 } } });
      if (url === '/lenders') return Promise.resolve({ data: { data: [{ id: 'l-mahmoud', name: 'Mahmoud' }] } });
      if (url.endsWith('/financings')) return Promise.resolve({ data: { data: { financings: [] } } });
      return Promise.resolve({ data: { data: [] } });
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

/** A China order: 5,000 CNY at 2. */
const CNY_ORDER: FinanceableOrder = { id: 'po-cny', reference: 'PO-2026-0006', currency: 'CNY', fxRateToEgp: 2 };

function renderForm(order: FinanceableOrder = CNY_ORDER, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PaidByFriend purchaseOrder={order} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByTestId('add-financing'));
}

const rate = () => screen.getByTestId('financing-rate') as HTMLInputElement;
const amount = () => document.querySelector<HTMLInputElement>('#financing-amount')!;
const combobox = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)!.parentElement!.querySelector<HTMLElement>('[role="combobox"]')!;
async function pick(name: string, label: string) {
  fireEvent.click(combobox(name));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${label}`) }));
}
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
const save = () => screen.getByRole('button', { name: en.lenders.save });

beforeEach(() => {
  post.mockReset();
  answer = () => new Promise(() => {});
});
afterEach(cleanup);

describe('Paid by a friend — his currency and that day’s rate', () => {
  it('starts on the order’s currency at the order’s own rate', async () => {
    renderForm();
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="currency"]')!.value).toBe('CNY');
    expect(rate().value).toBe('2');
    expect(screen.getByText(en.lenders.rateOnThatDay.replace('{currency}', 'CNY'))).toBeTruthy();
    expect(screen.getByText(en.lenders.amountIn.replace('{currency}', 'CNY'))).toBeTruthy();
  });

  it('offers EGP and every currency with a rate on file, the order’s first', async () => {
    renderForm();
    fireEvent.click(combobox('currency'));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options[0]).toMatch(/^CNY/);
    expect(options.map((o) => o!.slice(0, 3)).sort()).toEqual(['AED', 'CNY', 'EGP', 'USD']);
  });

  it('AED on a CNY order: the rate starts at today’s AED rate, the pounds show as he types, and both are sent', async () => {
    answer = () => Promise.resolve({ data: { data: {} } });
    renderForm();
    await pick('lenderId', 'Mahmoud');
    await pick('currency', 'AED');
    await waitFor(() => expect(rate().value).toBe('13.85'));
    expect(screen.getByText(en.lenders.amountIn.replace('{currency}', 'AED'))).toBeTruthy();
    typeInto(rate(), '13.9');
    typeInto(amount(), '500');
    expect(screen.getByTestId('financing-egp').textContent).toMatch(/6,950\.00/);
    fireEvent.click(save());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/purchases/po-cny/financings');
    expect(post.mock.calls[0][1]).toMatchObject({
      lenderId: 'l-mahmoud',
      amount: 500,
      currency: 'AED',
      fxRateToEgp: 13.9,
    });
  });

  it('a typed rate is his: a rates refresh or typing the amount never overwrites it; another currency starts again', async () => {
    renderForm();
    await pick('currency', 'USD');
    await waitFor(() => expect(rate().value).toBe('50.86'));
    typeInto(rate(), '49.5');
    typeInto(amount(), '10');
    expect(rate().value).toBe('49.5');
    await pick('currency', 'AED');
    expect(rate().value).toBe('13.85');
  });

  it('EGP: the rate is 1 and fixed, no pounds line, and no rate is sent', async () => {
    answer = () => Promise.resolve({ data: { data: {} } });
    renderForm();
    await pick('lenderId', 'Mahmoud');
    await pick('currency', 'EGP');
    expect(rate().value).toBe('1');
    expect(rate().disabled).toBe(true);
    typeInto(amount(), '3000');
    expect(screen.queryByTestId('financing-egp')).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ currency: 'EGP', amount: 3000 });
    expect('fxRateToEgp' in post.mock.calls[0][1]).toBe(false);
  });

  it('the pounds line is half up to the piastre, as the server stores it (10.15 at 1.5 → 15.23)', async () => {
    renderForm();
    typeInto(rate(), '1.5');
    typeInto(amount(), '10.15');
    expect(screen.getByTestId('financing-egp').textContent).toMatch(/15\.23/);
  });

  it('a currency with no rate on file and no order rate leaves the rate empty, and it is required', async () => {
    renderForm({ id: 'po-gbp', reference: 'PO-2026-0009', currency: 'GBP' });
    expect(rate().value).toBe('');
    expect(rate().required).toBe(true);
  });

  it('the server’s refusal in pounds reads in the reader’s language', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: {
            error: {
              code: 'FINANCING_EXCEEDS_ORDER',
              message: 'English fallback',
              params: { amount: '4,170.00', currency: 'EGP', reference: 'PO-2026-0006', total: '10,000.00', financed: '6,950.00' },
            },
          },
        },
      });
    renderForm(CNY_ORDER, 'ar');
    await pick('lenderId', 'Mahmoud');
    typeInto(amount(), '300');
    fireEvent.click(screen.getByRole('button', { name: ar.lenders.save }));
    const shown = await screen.findByText((text) => text.includes('PO-2026-0006') && text.includes('10,000.00'));
    expect(shown.textContent).not.toContain('English fallback');
    // What friends paid is said in pounds, with its currency named.
    expect(shown.textContent).toContain('6,950.00 EGP');
    expect(screen.getByTestId('financing-form')).toBeTruthy();
  });
});
