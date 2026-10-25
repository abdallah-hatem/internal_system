import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { AccountFundingPanel, type AccountFunding } from './account-funding-panel';

/**
 * The cycle's funding panel (BUSINESS_LOGIC §8, owner 2026-10-25: "equal
 * thirds, no negative, paid straight to supplier"). The server owns every
 * rule; these pin what the screen says about them: the target's progress,
 * who paid, the equal shares re-summing to the total, a short account
 * stopping the contribution, and a typed total never overwritten.
 */

const state = vi.hoisted(() => ({
  funding: null as unknown as AccountFunding,
  posts: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'abdallah@motoparts.com', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/account-funding') return Promise.resolve({ data: { data: state.funding } });
      if (url === '/currency-rates/map') return Promise.resolve({ data: { data: { USD: 50 } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      return Promise.resolve({ data: { data: { totalEgp: String((body as { totalEgp: number }).totalEgp), lines: [] } } });
    },
    put: () => Promise.resolve({ data: { data: {} } }),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const advance = (id: string, amount: string, currency = 'USD', egp = '0') => ({
  id,
  kind: 'ADVANCE' as const,
  amountEgp: egp,
  signedEgp: egp,
  amount,
  currency,
  fxRateToEgp: '50',
  occurredOn: '2026-10-16',
  cycleId: 'c-1',
  cycleCode: null,
  settlementId: null,
  note: null,
  reversedAt: null,
  reversalReason: null,
});

beforeEach(() => {
  state.posts = [];
  state.funding = {
    cycleId: 'c-1',
    code: 'CYC-2026-0001',
    status: 'PURCHASING',
    currency: 'USD',
    fundingLock: null,
    closed: false,
    target: { amount: '2000.00', currency: 'USD', fxRateToEgp: '50', amountEgp: '100000.00' },
    paidSoFar: {
      totalEgp: '80000.00',
      inTargetCurrency: '1600.00',
      byPartner: [
        { partnerUserId: 'u-s', name: 'Shady', totalEgp: '50000.00', inTargetCurrency: '1000.00', advances: [advance('a1', '1000.00', 'USD', '50000.00')] },
        { partnerUserId: 'u-f', name: 'Fares', totalEgp: '20000.00', inTargetCurrency: '400.00', advances: [advance('a2', '400.00', 'USD', '20000.00')] },
        { partnerUserId: 'u-a', name: 'Abdallah', totalEgp: '10000.00', inTargetCurrency: '200.00', advances: [advance('a3', '200.00', 'USD', '10000.00')] },
      ],
    },
    partners: [
      { partnerUserId: 'u-a', participantId: 'p-a', name: 'Abdallah', balanceEgp: '10000.00', contributionEgp: '0.00', fromAccountEgp: '0.00' },
      { partnerUserId: 'u-s', participantId: 'p-s', name: 'Shady', balanceEgp: '50000.00', contributionEgp: '0.00', fromAccountEgp: '0.00' },
      { partnerUserId: 'u-f', participantId: 'p-f', name: 'Fares', balanceEgp: '20000.00', contributionEgp: '0.00', fromAccountEgp: '0.00' },
    ],
    toFundEgp: '1000.00',
    investorsEgp: '0.00',
    partnersContributedEgp: '0.00',
    stillToContributeEgp: '1000.00',
  };
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    client,
    ...render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <QueryClientProvider client={client}>
          <ToastProvider>
            <AccountFundingPanel cycleId="c-1" />
          </ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

const shares = () => screen.getAllByTestId('contribute-share').map((e) => e.textContent);
const total = () => document.querySelector<HTMLInputElement>('#contribute-total')!;

describe('the cycle’s funding panel', () => {
  it('says how much of the target is paid so far, and by whom', async () => {
    wrap();
    expect((await screen.findByTestId('paid-of-target')).textContent).toBe('1,600.00 USD of 2,000.00 USD paid so far');
    const rows = screen.getAllByTestId('paid-by').map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Shady1,000\.00 USD50,000\.00 EGP/);
    expect(rows[1]).toMatch(/^Fares400\.00 USD20,000\.00 EGP/);
    expect(rows[2]).toMatch(/^Abdallah200\.00 USD10,000\.00 EGP/);
  });

  it('splits the total equally, the last partner taking the odd piastre, and sends the total', async () => {
    wrap();
    await screen.findByTestId('contribute-from-accounts');
    expect(shares()).toEqual(['333.33 EGP', '333.33 EGP', '333.34 EGP']);
    fireEvent.click(screen.getByTestId('contribute-submit'));
    await waitFor(() => expect(state.posts).toEqual([{ url: '/cycles/c-1/account-contributions', body: { totalEgp: 1000 } }]));
  });

  it('a partner whose account is short stops the contribution and says by how much', async () => {
    state.funding.stillToContributeEgp = '60000.00';
    wrap();
    await screen.findByTestId('contribute-from-accounts');
    expect(screen.getByTestId('contribute-short').textContent).toContain('10,000.00 EGP');
    expect((screen.getByTestId('contribute-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a total he typed is never overwritten when the figures refresh', async () => {
    const { client } = wrap();
    await screen.findByTestId('contribute-from-accounts');
    fireEvent.focus(total());
    fireEvent.change(total(), { target: { value: '300' } });
    fireEvent.blur(total());
    state.funding = { ...state.funding, stillToContributeEgp: '900.00' };
    await client.invalidateQueries({ queryKey: ['account-funding'] });
    await waitFor(() => expect(shares()).toEqual(['100.00 EGP', '100.00 EGP', '100.00 EGP']));
    expect(total().value).toBe('300');
  });

  it('once funding is locked, contributing is off and says why', async () => {
    state.funding.fundingLock = 'SETTLEMENT_APPROVED';
    wrap();
    expect(await screen.findByTestId('account-funding-locked')).toBeTruthy();
    expect((screen.getByTestId('contribute-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('record-advance')).toBeNull();
  });

  it('reads in Arabic, with no key left untranslated', async () => {
    wrap('ar');
    const line = await screen.findByTestId('paid-of-target');
    expect(line.textContent).toContain('حتى الآن');
    expect(document.body.textContent).not.toMatch(/accounts\.[a-zA-Z]/);
  });
});
