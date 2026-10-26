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
  role: 'CORE_PARTNER',
  /** 'never' keeps the request in flight; 'fail' refuses it. */
  get: 'ok' as 'ok' | 'never' | 'fail',
  refusal: null as null | { code: string; message: string; params: Record<string, string> },
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'abdallah@motoparts.com', role: state.role }, isLoading: false }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/account-funding') {
        if (state.get === 'never') return new Promise(() => {});
        if (state.get === 'fail') return Promise.reject(new Error('network'));
        return Promise.resolve({ data: { data: state.funding } });
      }
      if (url === '/currency-rates/map') return Promise.resolve({ data: { data: { USD: 50 } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.refusal) {
        return Promise.reject({ isAxiosError: true, response: { status: 400, data: { error: state.refusal } } });
      }
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

const partnerRow = (
  partnerUserId: string,
  name: string,
  available: string,
  elsewhere = '0.00',
) => ({
  partnerUserId,
  participantId: `p-${partnerUserId}`,
  name,
  availableEgp: available,
  ownAdvancesEgp: available,
  untiedEgp: '0.00',
  elsewhereEgp: elsewhere,
  balanceEgp: (Number(available) + Number(elsewhere)).toFixed(2),
  contributionEgp: '0.00',
  fromAccountEgp: '0.00',
});

beforeEach(() => {
  state.posts = [];
  state.role = 'CORE_PARTNER';
  state.get = 'ok';
  state.refusal = null;
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
      partnerRow('u-a', 'Abdallah', '10000.00'),
      partnerRow('u-s', 'Shady', '50000.00'),
      partnerRow('u-f', 'Fares', '20000.00'),
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

describe('each cycle’s funding is its own (owner 2026-10-26)', () => {
  const available = () => screen.getAllByTestId('contribute-available').map((e) => e.firstChild?.textContent);

  /** Production: CYC-2026-0001, while Abdallah's 50,775 and Shady's 10,000 were paid for CYC-2026-0002. */
  function cycleOne() {
    state.funding.code = 'CYC-2026-0001';
    state.funding.currency = 'EGP';
    state.funding.target = null;
    state.funding.paidSoFar = { totalEgp: '0.00', inTargetCurrency: null, byPartner: [] };
    state.funding.partners = [
      partnerRow('u-a', 'Abdallah', '0.00', '50775.00'),
      partnerRow('u-s', 'Shady', '0.00', '10000.00'),
      partnerRow('u-f', 'Fares', '0.00'),
    ];
    state.funding.stillToContributeEgp = '16925.00';
  }

  it('cycle 1 offers none of cycle 2’s advances: 0 for this cycle, the 50,775 named as another cycle’s, everyone short', async () => {
    cycleOne();
    wrap();
    await screen.findByTestId('contribute-from-accounts');
    expect(available()).toEqual(['0.00 EGP', '0.00 EGP', '0.00 EGP']);
    const elsewhere = screen.getAllByTestId('held-elsewhere').map((e) => e.textContent);
    expect(elsewhere).toEqual(['+ 50,775.00 EGP paid for other cycles', '+ 10,000.00 EGP paid for other cycles']);
    expect(screen.getAllByTestId('contribute-short')).toHaveLength(3);
    expect((screen.getByTestId('contribute-submit') as HTMLButtonElement).disabled).toBe(true);
    // Nowhere does the form offer his whole account as this cycle's.
    expect(screen.getByTestId('contribute-from-accounts').textContent).not.toContain('50,775.00 EGP50,775');
  });

  it('cycle 2, equal thirds of 60,775 with Abdallah 50,775 / Shady 10,000 / Fares 0: Shady and Fares short by the right amounts', async () => {
    state.funding.currency = 'EGP';
    state.funding.target = null;
    state.funding.partners = [
      partnerRow('u-a', 'Abdallah', '50775.00'),
      partnerRow('u-s', 'Shady', '10000.00'),
      partnerRow('u-f', 'Fares', '0.00'),
    ];
    state.funding.stillToContributeEgp = '60775.00';
    wrap();
    await screen.findByTestId('contribute-from-accounts');
    expect(shares()).toEqual(['20,258.33 EGP', '20,258.33 EGP', '20,258.34 EGP']);
    const rows = screen.getAllByTestId('contribute-row');
    expect(rows[0].textContent).toContain('30,516.67 EGP');
    expect(rows[1].querySelector('[data-testid="contribute-short"]')?.textContent).toContain('10,258.33 EGP');
    expect(rows[2].querySelector('[data-testid="contribute-short"]')?.textContent).toContain('20,258.34 EGP');
    expect(screen.queryAllByTestId('held-elsewhere')).toHaveLength(0);
  });

  it('the server’s refusal to draw another cycle’s money is shown in the reader’s words, English and Arabic', async () => {
    state.refusal = {
      code: 'ACCOUNT_MONEY_FOR_OTHER_CYCLE',
      message: 'english fallback',
      params: { partner: 'Abdallah', cycle: 'CYC-2026-0001', available: '0.00', elsewhere: '50,775.00', amount: '333.33', short: '333.33' },
    };
    for (const locale of ['en', 'ar'] as const) {
      wrap(locale);
      await screen.findByTestId('contribute-from-accounts');
      fireEvent.click(screen.getByTestId('contribute-submit'));
      const said =
        locale === 'en'
          ? 'Abdallah has 0.00 EGP that CYC-2026-0001 can draw; the other 50,775.00 EGP in his account was paid for other cycles'
          : 'دُفعت لدورات أخرى';
      await waitFor(() => expect(document.body.textContent).toContain(said));
      cleanup();
    }
  });
});

describe('while the funding loads, or if it cannot', () => {
  it('shows a skeleton in the panel’s shape — the Contribute box included — and no figures', async () => {
    state.get = 'never';
    wrap();
    expect(await screen.findByTestId('account-funding-loading')).toBeTruthy();
    expect(screen.getByTestId('account-funding-skeleton')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(en.common.loading);
    // The rows the panel draws: three paid-by rows and three contribute rows.
    expect(screen.getByTestId('account-funding-skeleton').querySelectorAll('.grid.grid-cols-2')).toHaveLength(6);
    expect(screen.queryByTestId('account-funding')).toBeNull();
  });

  it('says it could not load, and loads again on Try again', async () => {
    state.get = 'fail';
    wrap();
    expect((await screen.findByTestId('account-funding-error')).textContent).toContain('Could not load this cycle’s funding');
    state.get = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('account-funding')).toBeTruthy();
  });

  it('stays hidden — no skeleton either — for someone who may not read the accounts', async () => {
    state.role = 'INVESTOR';
    state.get = 'never';
    const { container } = wrap();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('account-funding-loading')).toBeNull();
  });
});
