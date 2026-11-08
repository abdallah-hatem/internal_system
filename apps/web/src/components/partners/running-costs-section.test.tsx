import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { RunningCostsSection, periodRange } from './running-costs-section';

/**
 * The Partners page's Running costs section (BUSINESS_LOGIC §8, owner
 * 2026-10-11; reworked 2026-11-08): what was spent by category, what was
 * shared to which cycle (inside its profit, borne by everyone, investors
 * too), what waits for a running cycle, and, as history, what partners'
 * payouts took before the change — for a period that defaults to this
 * quarter. The figures are the API's; this lays them out and asks for the
 * period chosen.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

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
  sharedEgp: '20066.66',
  chargedEgp: '0.00',
  waitingEgp: '10033.34',
  waitingAllTimeEgp: '13033.34',
  byCategory: [
    { category: 'rent', spentEgp: '30000.00' },
    { category: 'utilities', spentEgp: '100.00' },
  ],
  cycles: [
    { cycleId: 'c-1', code: 'CYC-2026-0007', status: 'SELLING', sharedEgp: '10033.33' },
    { cycleId: 'c-2', code: 'CYC-2026-0008', status: 'CLOSED', sharedEgp: '10033.33' },
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

  it('spent, shared to cycles, waiting; by category; each cycle with its share, its code opening the cycle', async () => {
    renderIn();
    expect((await screen.findByTestId('running-costs-spent')).textContent).toContain('30,100.00');
    expect(screen.getByTestId('running-costs-shared').textContent).toContain('20,066.66');
    const waiting = screen.getByTestId('running-costs-waiting');
    expect(waiting.textContent).toContain('10,033.34');
    expect(waiting.textContent).toContain(en.partners.waitingForCycle);
    const categories = within(screen.getByTestId('running-costs-categories'));
    expect(categories.getByText(en.codes.ledgerCategory.rent)).toBeTruthy();
    const cycles = screen.getByTestId('running-costs-cycles');
    const links = within(cycles).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['CYC-2026-0007', 'CYC-2026-0008']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/cycles/c-1/details', '/cycles/c-2/details']);
    const rows = cycles.querySelectorAll(':scope > div');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('10,033.33');
    expect(rows[0].textContent).toContain(en.codes.cycleStatus.SELLING);
    // No per-partner rows: running costs are no one partner's any more.
    expect(screen.queryByTestId('running-costs-partners')).toBeNull();
    expect(screen.queryByTestId('running-costs-partner-cards')).toBeNull();
  });

  it('nothing waiting in the period: no waiting figure, not a zero', async () => {
    reply = { ...SUMMARY, waitingEgp: '0.00' };
    renderIn();
    await screen.findByTestId('running-costs-shared');
    expect(screen.queryByTestId('running-costs-waiting')).toBeNull();
    expect(screen.getByTestId('running-costs').textContent).not.toContain(en.partners.waitingForCycle);
  });

  it('what partners’ payouts took before 2026-11-08 shows only when there is some, as history', async () => {
    renderIn();
    await screen.findByTestId('running-costs-shared');
    expect(screen.queryByTestId('running-costs-charged')).toBeNull();
    expect(screen.getByTestId('running-costs').textContent).not.toContain(en.partners.chargedBefore);
    cleanup();
    reply = { ...SUMMARY, chargedEgp: '4500.00' };
    renderIn();
    const charged = await screen.findByTestId('running-costs-charged');
    expect(charged.textContent).toContain('4,500.00');
    expect(charged.textContent).toContain(en.partners.chargedBefore);
  });

  it('spent while no cycle was running: says nothing was shared, and how much waits', async () => {
    reply = { ...SUMMARY, sharedEgp: '0.00', waitingEgp: '30100.00', cycles: [] };
    renderIn();
    expect((await screen.findByTestId('running-costs-no-cycles')).textContent).toBe(en.partners.noCyclesShared);
    expect(screen.queryByTestId('running-costs-cycles')).toBeNull();
    expect(screen.getByTestId('running-costs-waiting').textContent).toContain('30,100.00');
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
    reply = { ...SUMMARY, spentEgp: '0.00', sharedEgp: '0.00', waitingEgp: '0.00', byCategory: [], cycles: [] };
    renderIn();
    expect(await screen.findByText(en.partners.noRunningCosts)).toBeTruthy();
    expect(screen.getByTestId('running-costs-all-waiting').textContent).toContain('13,033.34');
  });

  it('nothing waiting anywhere: no all-time waiting sentence', async () => {
    reply = { ...SUMMARY, waitingEgp: '0.00', waitingAllTimeEgp: '0.00' };
    renderIn();
    await screen.findByTestId('running-costs-shared');
    expect(screen.queryByTestId('running-costs-all-waiting')).toBeNull();
  });

  it('the explanation says the running cycles bear it, investors too — never a partner’s payout', async () => {
    renderIn();
    await screen.findByTestId('running-costs-shared');
    const text = screen.getByTestId('running-costs').textContent ?? '';
    expect(text).toContain(en.partners.runningCostsIntro);
    expect(en.partners.runningCostsIntro).toMatch(/cycles running/);
    expect(en.partners.runningCostsIntro).toMatch(/investors too/);
    expect(en.partners.runningCostsIntro).not.toMatch(/payout|core partners/);
    expect(ar.partners.runningCostsIntro).toContain('المستثمرون');
    expect(ar.partners.runningCostsIntro).not.toMatch(/توزيع|الشركاء الأساسيين/);
  });

  it('in Arabic, every heading is Arabic — no English left over', async () => {
    reply = { ...SUMMARY, chargedEgp: '4500.00' };
    renderIn('ar');
    await screen.findByTestId('running-costs-spent');
    const section = screen.getByTestId('running-costs');
    const text = section.textContent ?? '';
    expect(text).toContain(ar.partners.runningCostsTitle);
    expect(text).toContain(ar.partners.sharedToCycles);
    expect(text).toContain(ar.partners.waitingForCycle);
    expect(text).toContain(ar.partners.chargedBefore);
    expect(text).toContain(ar.codes.cycleStatus.SELLING);
    // Only the cycle codes and the currency are Latin.
    const latin = text.replace(/CYC-\d{4}-\d{4}/g, '').match(/[A-Za-z]{2,}/g)?.filter((w) => w !== 'EGP') ?? [];
    expect(latin).toEqual([]);
    // The amount inside the Arabic sentence stays one left-to-right run (§11).
    expect(screen.getByTestId('running-costs-all-waiting').textContent).toMatch(/⁦[^⁩]*13,033\.34[^⁩]*⁩/);
  });
});

describe('every new word for running costs shared to cycles (2026-11-08), in both languages', () => {
  type Tree = { [k: string]: string | Tree };
  const at = (tree: Tree, path: string) => path.split('.').reduce<Tree | string | undefined>((n, k) => (n as Tree)?.[k], tree);
  const params = (s: string) => [...s.matchAll(/\{(\w+)[,}]|<(\w+)>/g)].map((m) => m[1] ?? m[2]).sort();
  const KEYS = [
    'partners.runningCostsIntro',
    'partners.runningCostsHint',
    'partners.sharedToCycles',
    'partners.waitingForCycle',
    'partners.waitingForCycleHint',
    'partners.chargedBefore',
    'partners.noCyclesShared',
    'partners.waitingAllTime',
    'settlementsPage.costShared',
    'settlementsPage.footnote',
    'ledger.noCycleExpenseHint',
    'errors.RUNNING_COST_SETTLED',
    'errors.SETTLEMENT_STALE_COSTS',
    'errors.RUNNING_COST_CHARGED',
  ];

  it('each is in English and Arabic, not empty, with the same placeholders', () => {
    for (const key of KEYS) {
      const e = at(en as unknown as Tree, key);
      const a = at(ar as unknown as Tree, key);
      expect(typeof e, key).toBe('string');
      expect(typeof a, key).toBe('string');
      expect((e as string).trim(), key).not.toBe('');
      expect((a as string).trim(), key).not.toBe('');
      expect(params(a as string), key).toEqual(params(e as string));
    }
  });

  it('the refusals carry the params the API sends, and say what the API says', () => {
    expect(params(en.errors.RUNNING_COST_SETTLED)).toEqual(['cycles']);
    expect(params(en.errors.SETTLEMENT_STALE_COSTS)).toEqual([]);
    expect(en.errors.RUNNING_COST_SETTLED).toBe(
      "This running cost is part of {cycles}'s settlement. Reverse that settlement first, then this entry.",
    );
    expect(en.errors.SETTLEMENT_STALE_COSTS).toBe(
      'Running costs shared to this cycle changed after this settlement was calculated. Calculate it again.',
    );
  });

  it('the per-partner words are gone, and nothing promises a deduction if paid today', () => {
    for (const messages of [en, ar] as unknown as Tree[]) {
      for (const key of ['partners.taken', 'partners.share', 'partners.residualNote', 'partners.leftPartner', 'partners.waiting', 'settlementsPage.runningCostsProjected']) {
        expect(at(messages, key), key).toBeUndefined();
      }
    }
  });
});
