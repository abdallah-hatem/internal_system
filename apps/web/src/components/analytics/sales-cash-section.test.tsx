import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * Analytics' Sales cash (owner 2026-11-06: "where to see the current cash from
 * sales, and what left to collect, why is it not shown in analytics?"): all
 * time, Collected and Still to collect, each with its profit pill, each
 * leading where the dashboard's tile leads. Rendered inside the real
 * Analytics page, so it is checked where a person finds it.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/en/analytics',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/analytics',
}));

const state = vi.hoisted(() => ({
  kpis: {} as Record<string, unknown> | null,
  periods: [] as string[],
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url.startsWith('/analytics/dashboard')) {
        state.periods.push(url);
        return state.kpis === null ? new Promise(() => {}) : Promise.resolve({ data: { data: state.kpis } });
      }
      // Profit and loss is another section's business; left loading here.
      if (url.startsWith('/analytics/profit-and-loss')) return new Promise(() => {});
      return Promise.resolve({ data: { data: [] } });
    },
  },
}));

import AnalyticsPage from '@/app/[locale]/analytics/page';
import { StatTile, StatTileSkeleton } from '@/components/dashboard/stat-tile';
import { Banknote } from '@/components/ui/icons';

const KPIS = {
  cashFromSalesEgp: 126400,
  receivables: 94325,
  profitOnCollectedEgp: 25501.79,
  profitToCollectEgp: 20369.95,
  // Unlike the figures above, so a tile reading the wrong field shows it.
  cashOnHand: 111,
  collected: 222,
  netProfit: 333,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  state.kpis = { ...KPIS };
  state.periods = [];
});
afterEach(cleanup);

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <AnalyticsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const section = () => screen.findByTestId('analytics-sales-cash');

describe('Analytics — Sales cash, all time', () => {
  it('headed Sales cash, saying All time', async () => {
    renderPage();
    const el = await section();
    const heading = within(el).getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Sales cashAll time');
    expect(within(el).getByTestId('analytics-sales-cash-period').textContent).toBe('All time');
  });

  it('Collected: the cash from sales, with its profit pill, leading to Payments', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-collected');
    expect(tile.tagName).toBe('A');
    expect(tile.getAttribute('href')).toBe('/payments');
    expect(within(tile).getByTestId('stat-label').textContent).toMatch(/^Collected/);
    expect(within(tile).getByTestId('stat-figure').textContent).toContain('126,400.00');
    const pill = within(tile).getByTestId('stat-badge');
    expect(pill.textContent).toBe('+25,502 profit');
    expect(pill.getAttribute('data-tone')).toBe('success');
  });

  it('Still to collect: what customers owe, with the profit to come, leading to customers by balance', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-to-collect');
    expect(tile.getAttribute('href')).toBe('/customers?sort=balance');
    expect(within(tile).getByTestId('stat-label').textContent).toMatch(/^Still to collect/);
    expect(within(tile).getByTestId('stat-figure').textContent).toContain('94,325.00');
    const pill = within(tile).getByTestId('stat-badge');
    expect(pill.textContent).toBe('+20,370 profit to come');
    expect(pill.getAttribute('data-tone')).toBe('success');
  });

  it('not tied to the period: one request for the all-time figures, no period in it', async () => {
    renderPage();
    await screen.findByTestId('sales-cash-collected');
    expect(state.periods.every((u) => u === '/analytics/dashboard')).toBe(true);
  });

  it('a loss still to come shows red; a zero profit shows no pill', async () => {
    state.kpis = { ...KPIS, profitOnCollectedEgp: 0, profitToCollectEgp: -480.2 };
    renderPage();
    const collected = await screen.findByTestId('sales-cash-collected');
    expect(within(collected).queryByTestId('stat-badge')).toBeNull();
    const pill = within(screen.getByTestId('sales-cash-to-collect')).getByTestId('stat-badge');
    expect(pill.textContent).toBe('-480 loss to come');
    expect(pill.getAttribute('data-tone')).toBe('danger');
  });

  it('reads in Arabic', async () => {
    renderPage('ar');
    const el = await section();
    expect(el.textContent).toContain(ar.analytics.salesCash.title);
    expect(el.textContent).toContain(ar.analytics.salesCash.allTime);
    const collected = await screen.findByTestId('sales-cash-collected');
    expect(within(collected).getByTestId('stat-label').textContent).toContain('المُحصَّل');
    expect(within(collected).getByTestId('stat-badge').textContent).toBe('+25,502 ربح');
    const toCollect = screen.getByTestId('sales-cash-to-collect');
    expect(within(toCollect).getByTestId('stat-label').textContent).toContain('المتبقي للتحصيل');
    expect(within(toCollect).getByTestId('stat-badge').textContent).toBe('+20,370 ربح قادم');
  });

  it('the skeleton keeps the heading and traces two tiles, each with a worded pill', async () => {
    state.kpis = null;
    renderPage();
    const el = await section();
    expect(within(el).getByRole('heading', { level: 2 }).textContent).toContain('Sales cash');
    const rows = within(el).getAllByTestId('skeleton-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector('[data-testid="skeleton-badge"]')!.className.split(/\s+/)).toContain('w-20');
      // Label and figure: no second line, as the tiles have none.
      expect(row.querySelector('.flex-1')!.children).toHaveLength(2);
    }
    // The same grid the tiles land in.
    expect(rows[0].parentElement!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid', 'grid-cols-2', 'gap-3', 'sm:gap-4']),
    );
  });

  it('…and the tiles have the shape the skeleton traced', async () => {
    renderPage();
    const tiles = [await screen.findByTestId('sales-cash-collected'), screen.getByTestId('sales-cash-to-collect')];
    for (const tile of tiles) expect(tile.querySelector('.flex-1')!.children).toHaveLength(2);
    expect(screen.getByTestId('analytics-sales-cash-grid').className).toBe('grid grid-cols-2 gap-3 sm:gap-4');
  });
});

describe('a worded pill on any tile, and its skeleton', () => {
  it('a muted count keeps reading left to right; a worded pill follows the page', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <StatTile label="A" value={1} icon={Banknote} color="" href={null} badge={{ label: '42', srLabel: '42 units' }} />
        <StatTile
          label="B"
          value={1}
          icon={Banknote}
          color=""
          href={null}
          badge={{ label: <span>+1 profit</span>, srLabel: 'p', tone: 'success' }}
        />
      </NextIntlClientProvider>,
    );
    const [count, worded] = screen.getAllByTestId('stat-badge');
    expect(count.getAttribute('dir')).toBe('ltr');
    expect(count.getAttribute('data-tone')).toBe('muted');
    expect(worded.getAttribute('dir')).toBeNull();
  });

  it('a skeleton badge: narrow for a count, wide for words', () => {
    render(
      <>
        <StatTileSkeleton badge />
        <StatTileSkeleton badge="wide" />
      </>,
    );
    const [narrow, wide] = screen.getAllByTestId('skeleton-badge');
    expect(narrow.className.split(/\s+/)).toContain('w-7');
    expect(wide.className.split(/\s+/)).toContain('w-20');
  });
});
