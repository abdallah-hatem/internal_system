import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { RunningCostsSection, periodRange } from './running-costs-section';

/**
 * L7 — the Partners page's Running costs section (BUSINESS_LOGIC §8, owner
 * 2026-10-11): what was spent, what has been taken from payouts, what is
 * still waiting, and each core partner's share, for a period that defaults to
 * this quarter. The figures are the API's; this lays them out and asks for
 * the period chosen.
 */

const get = vi.fn();
let reply: unknown;
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: { params?: Record<string, string> }) => {
      get(url, opts?.params);
      return Promise.resolve({ data: { data: reply } });
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

const SUMMARY = {
  from: '2026-10-01',
  to: '2026-12-31',
  spentEgp: '30100.00',
  chargedEgp: '20066.66',
  waitingEgp: '10033.34',
  waitingAllTimeEgp: '13033.34',
  byCategory: [
    { category: 'rent', spentEgp: '30000.00' },
    { category: 'utilities', spentEgp: '100.00' },
  ],
  partners: [
    { userId: 'u-a', name: 'Abdallah', shareEgp: '10033.33', chargedEgp: '10033.33', waitingEgp: '0.00', takesResidual: false },
    { userId: 'u-o', name: 'Omar', shareEgp: '10033.33', chargedEgp: '10033.33', waitingEgp: '0.00', takesResidual: false },
    { userId: 'u-m', name: 'Mahmoud', shareEgp: '10033.34', chargedEgp: '0.00', waitingEgp: '10033.34', takesResidual: true },
  ],
};

function renderIn(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <RunningCostsSection />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  reply = SUMMARY;
  // 23:30 UTC on 30 Sep is 02:30 on 1 Oct in Cairo: already the new quarter.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T23:30:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('periodRange — days in Cairo', () => {
  it('this quarter, last quarter, this month, this year', () => {
    expect(periodRange('quarter', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange('lastQuarter', '2026-10-01')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(periodRange('lastQuarter', '2026-02-14')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(periodRange('month', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('year', '2026-02-14')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('the Running costs section', () => {
  it('asks for this quarter by default — Cairo’s quarter, not the machine’s', async () => {
    renderIn();
    await screen.findByTestId('running-costs-spent');
    expect(get).toHaveBeenCalledWith('/settlements/running-costs', {
      from: '2026-10-01',
      to: '2026-12-31',
    });
  });

  it('spent, taken, waiting; by category; each partner’s share', async () => {
    renderIn();
    expect((await screen.findByTestId('running-costs-spent')).textContent).toContain('30,100.00');
    expect(screen.getByTestId('running-costs-taken').textContent).toContain('20,066.66');
    expect(screen.getByTestId('running-costs-waiting').textContent).toContain('10,033.34');
    const categories = within(screen.getByTestId('running-costs-categories'));
    expect(categories.getByText(en.codes.ledgerCategory.rent)).toBeTruthy();
    const rows = within(screen.getByTestId('running-costs-partners')).getAllByRole('row');
    // A header and one row per core partner.
    expect(rows).toHaveLength(4);
    expect(rows[3].textContent).toContain('Mahmoud');
    expect(rows[3].textContent).toContain('10,033.34');
    // On a phone the same figures are a card per partner, each labelled; the table is for wider screens.
    const cards = screen.getByTestId('running-costs-partner-cards');
    expect(cards.className).toContain('sm:hidden');
    expect(within(cards).getAllByRole('listitem')).toHaveLength(3);
    expect(within(cards).getAllByRole('listitem')[2].querySelectorAll('dt')).toHaveLength(3);
    expect(screen.getByTestId('running-costs-partners').parentElement!.className).toContain('hidden');
  });

  it('says who takes the odd piastre, by name — never silently', async () => {
    renderIn();
    expect((await screen.findByTestId('running-costs-residual')).textContent).toBe(
      en.partners.residualNote.replace('{name}', 'Mahmoud'),
    );
  });

  it('choosing another period asks for that period', async () => {
    renderIn();
    await screen.findByTestId('running-costs-spent');
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: en.partners.periodLastQuarter }));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith('/settlements/running-costs', {
        from: '2026-07-01',
        to: '2026-09-30',
      }),
    );
  });

  it('nothing spent in the period: says so, and still how much waits overall', async () => {
    reply = { ...SUMMARY, spentEgp: '0.00', chargedEgp: '0.00', waitingEgp: '0.00', byCategory: [] };
    renderIn();
    expect(await screen.findByText(en.partners.noRunningCosts)).toBeTruthy();
    expect(screen.getByTestId('running-costs-all-waiting').textContent).toContain('13,033.34');
  });

  it('in Arabic, every heading is Arabic', async () => {
    renderIn('ar');
    await screen.findByTestId('running-costs-spent');
    const section = screen.getByTestId('running-costs');
    expect(section.textContent).toContain(ar.partners.runningCostsTitle);
    expect(section.textContent).toContain(ar.partners.waiting);
    expect(section.textContent).not.toMatch(/Spent|Still waiting|His share/);
    // The amount inside the Arabic sentence stays one left-to-right run (§11).
    expect(screen.getByTestId('running-costs-all-waiting').textContent).toMatch(/\u2066[^\u2069]*13,033\.34[^\u2069]*\u2069/);
  });
});
