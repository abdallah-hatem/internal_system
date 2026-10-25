import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { PartnerAccountsSection } from './partner-accounts-section';
import type { PartnerAccount } from './account-dialogs';

/**
 * Running accounts on the Partners page (BUSINESS_LOGIC §8, 2026-10-25): each
 * balance is the server's, each entry reads as what it did to the balance, a
 * reversed one is struck through and cannot be reversed again, and a refusal
 * (never below zero) is said in the reader's language.
 */

const state = vi.hoisted(() => ({
  accounts: [] as PartnerAccount[],
  posts: [] as Array<{ url: string; body: unknown }>,
  refuse: null as null | { code: string; params: Record<string, string> },
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/partners',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/partner-accounts') return Promise.resolve({ data: { data: state.accounts } });
      if (url === '/currency-rates/map') return Promise.resolve({ data: { data: {} } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.refuse) {
        return Promise.reject({ response: { status: 400, data: { error: { ...state.refuse, message: 'English' } } } });
      }
      return Promise.resolve({ data: { data: {} } });
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

const movement = (id: string, kind: PartnerAccount['movements'][number]['kind'], signed: string, extra = {}) => ({
  id,
  kind,
  amountEgp: signed.replace('-', ''),
  signedEgp: signed,
  amount: signed.replace('-', ''),
  currency: 'EGP',
  fxRateToEgp: '1',
  occurredOn: '2026-10-24',
  cycleId: kind === 'WITHDRAWAL' ? null : 'c-1',
  cycleCode: kind === 'WITHDRAWAL' ? null : 'CYC-2026-0001',
  settlementId: null,
  note: null,
  reversedAt: null,
  reversalReason: null,
  ...extra,
});

beforeEach(() => {
  state.posts = [];
  state.refuse = null;
  state.accounts = [
    {
      partnerUserId: 'u-s',
      name: 'Shady',
      email: 'shady@motoparts.com',
      active: true,
      balanceEgp: '25000.00',
      advancedEgp: '50000.00',
      leftInEgp: '0.00',
      contributedEgp: '20000.00',
      withdrawnEgp: '5000.00',
      movements: [
        movement('m3', 'WITHDRAWAL', '-5000.00'),
        movement('m2', 'CONTRIBUTION', '-20000.00'),
        movement('m1', 'ADVANCE', '50000.00'),
        movement('m0', 'ADVANCE', '700.00', { reversedAt: '2026-10-24T10:00:00Z', reversalReason: 'typo' }),
      ],
    },
  ];
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <PartnerAccountsSection />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('running accounts on the Partners page', () => {
  it('shows each balance and every entry as what it did to it', async () => {
    wrap();
    const card = await screen.findByTestId('partner-account');
    expect(within(card).getByTestId('account-balance').textContent).toBe('25,000.00 EGP');
    const entries = within(card).getAllByTestId('account-movement');
    expect(entries.map((e) => e.getAttribute('data-kind'))).toEqual(['WITHDRAWAL', 'CONTRIBUTION', 'ADVANCE', 'ADVANCE']);
    expect(entries[1].textContent).toContain('Into cycle');
    expect(entries[1].textContent).toContain('-20,000.00 EGP');
  });

  it('a reversed entry is marked and offers no second reversal', async () => {
    wrap();
    const entries = await screen.findAllByTestId('account-movement');
    expect(entries[3].textContent).toContain('Reversed');
    expect(within(entries[3]).queryByTestId('reverse-movement')).toBeNull();
    expect(within(entries[2]).getByTestId('reverse-movement')).toBeTruthy();
  });

  it('a refusal to take out more than the account holds is said, coded, in Arabic', async () => {
    state.refuse = {
      code: 'ACCOUNT_BALANCE_TOO_LOW',
      params: { partner: 'Shady', balance: '25,000.00', amount: '30,000.00', short: '5,000.00' },
    };
    wrap('ar');
    fireEvent.click(await screen.findByTestId('withdraw'));
    const input = document.querySelector<HTMLInputElement>('#withdraw-amount')!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '30000' } });
    fireEvent.blur(input);
    fireEvent.submit(document.querySelector('#withdraw-form')!);
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]).toEqual(expect.objectContaining({ url: '/partner-accounts/u-s/withdrawals' }));
    expect(await screen.findByText(/سجّل دفعة بـ 5,000.00 جنيه أولاً/)).toBeTruthy();
  });
});
