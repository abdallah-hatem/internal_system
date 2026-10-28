import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import PartnersView from './partners-view';

/**
 * The Partners tab drew its running-costs section twice on a fresh load: once
 * while the partners loaded and again, in another place, when they arrived.
 * React mounted it a second time, which closed a period picker a partner had
 * already opened (BUILD_LOG "Known e2e debt", 2026-10-19). One slot now.
 */

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/partners/running-costs-section', async () => {
  const { useEffect } = await import('react');
  return {
    RunningCostsSection: () => {
      useEffect(() => {
        mounts.count += 1;
      }, []);
      return <section data-testid="running-costs" />;
    },
  };
});

// The running accounts (§8, 2026-10-25) ask the API on their own; not under test here.
vi.mock('@/components/partners/partner-accounts-section', () => ({
  PartnerAccountsSection: () => null,
}));

const reply = vi.hoisted(() => ({ resolve: (_: unknown) => {} }));
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(
      () =>
        new Promise((resolve) => {
          reply.resolve = resolve;
        }),
    ),
  },
}));

const PARTNER = {
  id: 'p1',
  email: 'abdallah@x.test',
  displayName: 'Abdallah',
  role: 'CORE_PARTNER',
  contributedEgp: 1000,
  profitShareEgp: 100,
  accruedProfitEgp: 0,
  atRiskEgp: 0,
  runningCostsEgp: 0,
  cycles: [],
};

afterEach(() => {
  cleanup();
  mounts.count = 0;
});

function renderView(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <PartnersView />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('the running-costs section on the Partners tab', () => {
  it('is mounted once: the same section while the partners load and after they arrive', async () => {
    renderView();
    expect(screen.getAllByTestId('running-costs')).toHaveLength(1);
    expect(mounts.count).toBe(1);

    await act(async () => reply.resolve({ data: { data: [PARTNER] } }));
    await screen.findByText('Abdallah');
    expect(screen.getAllByTestId('running-costs')).toHaveLength(1);
    expect(mounts.count).toBe(1);
  });

  it('is not shown once loaded with no partner at all', async () => {
    renderView();
    await act(async () => reply.resolve({ data: { data: [] } }));
    await vi.waitFor(() => expect(screen.queryByTestId('running-costs')).toBeNull());
  });
});

/**
 * The card's money figure is Put in so far (§8, owner 2026-10-28): capital
 * plus advances paid for a cycle and not drawn into it yet — the Funding
 * card's figure. Capital alone showed 55,000 for a partner who had also paid
 * 50,775 for cycle 2, which the owner read as "not synced".
 */
describe('a core partner card: put in so far', () => {
  const ONE = { id: 'c1', code: 'CYC-2026-0001', status: 'SELLING', profitShareEgp: 0, accruedProfitEgp: 0 };
  const TWO = { id: 'c2', code: 'CYC-2026-0002', status: 'PURCHASING', profitShareEgp: 0, accruedProfitEgp: 0 };
  const ABDALLAH = {
    ...PARTNER,
    contributedEgp: 55_000,
    putInEgp: 105_775,
    undrawnAdvancesEgp: 50_775,
    profitShareEgp: 0,
    cycleCount: 2,
    openCycleCount: 2,
    cycles: [
      { ...TWO, contributionEgp: 0, putInEgp: 50_775, undrawnAdvancesEgp: 50_775 },
      { ...ONE, contributionEgp: 55_000, putInEgp: 55_000, undrawnAdvancesEgp: 0 },
    ],
  };
  const FARES = {
    ...PARTNER,
    id: 'p3',
    email: 'fares@x.test',
    displayName: 'Fares',
    contributedEgp: 33_084.49,
    putInEgp: 33_084.49,
    undrawnAdvancesEgp: 0,
    profitShareEgp: 0,
    cycleCount: 1,
    openCycleCount: 1,
    cycles: [{ ...ONE, contributionEgp: 33_084.49, putInEgp: 33_084.49, undrawnAdvancesEgp: 0 }],
  };

  async function cardOf(email: string, locale: 'en' | 'ar' = 'en') {
    renderView(locale);
    await act(async () => reply.resolve({ data: { data: [ABDALLAH, FARES] } }));
    const cards = await screen.findAllByTestId('partner-card');
    return cards.find((c) => c.getAttribute('data-email') === email)!;
  }
  const flat = (el: HTMLElement) => (el.textContent ?? '').replace(/[\u2066-\u2069]/g, '');

  it('shows put in so far first, with capital and the undrawn advances under it when they differ', async () => {
    const card = await cardOf('abdallah@x.test');
    const label = within(card).getByText('Put in so far');
    expect(label.nextElementSibling?.textContent).toBe('105,775.00 EGP');
    expect(within(card).queryByText('Capital in')).toBeNull();
    expect(flat(within(card).getByTestId('put-in-breakdown'))).toBe(
      'Capital 55,000.00 EGP · 50,775.00 EGP paid, not drawn yet',
    );
  });

  it('each cycle on the card reads its own put in so far, not its capital', async () => {
    const card = await cardOf('abdallah@x.test');
    const two = within(card).getByText('CYC-2026-0002').closest('li')!;
    expect(flat(two)).toContain('50,775.00 EGP');
    expect(flat(two)).not.toContain('0.00 EGP →');
    const one = within(card).getByText('CYC-2026-0001').closest('li')!;
    expect(flat(one)).toContain('55,000.00 EGP');
  });

  it('has no sub-line when put in so far is the capital', async () => {
    const card = await cardOf('fares@x.test');
    expect(within(card).getByText('Put in so far').nextElementSibling?.textContent).toBe('33,084.49 EGP');
    expect(within(card).queryByTestId('put-in-breakdown')).toBeNull();
  });

  it('the total card adds up put in so far across the partners', async () => {
    renderView();
    await act(async () => reply.resolve({ data: { data: [ABDALLAH, FARES] } }));
    await screen.findAllByTestId('partner-card');
    const labels = screen.getAllByText('Put in so far');
    const total = labels.find((l) => !l.closest('[data-testid="partner-card"]'))!;
    const tile = total.parentElement!.parentElement!;
    expect(flat(tile)).toContain('138,859.49 EGP');
    expect(flat(tile)).toContain('Capital 88,084.49 EGP · 50,775.00 EGP paid, not drawn yet');
  });

  it('reads in Arabic, the amounts kept as left-to-right runs', async () => {
    const card = await cardOf('abdallah@x.test', 'ar');
    expect(within(card).getByText('ما وضعه حتى الآن')).toBeTruthy();
    const line = within(card).getByTestId('put-in-breakdown');
    expect(flat(line)).toBe('رأس المال 55,000.00 EGP · 50,775.00 EGP مدفوع ولم يُسحب بعد');
    // Each amount sits inside its own isolate, so RTL does not reorder it.
    expect(line.textContent).toContain('\u206655,000.00 EGP\u2069');
  });
});
