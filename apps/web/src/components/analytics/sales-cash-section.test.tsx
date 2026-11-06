import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // The pill's (i) is a button, so the link is laid over the tile, not round it.
    const link = within(tile).getByTestId('stat-tile-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/payments');
    expect(within(tile).getByTestId('stat-label').textContent).toMatch(/^Collected/);
    expect(within(tile).getByTestId('stat-figure').textContent).toContain('126,400.00');
    const pill = within(tile).getByTestId('stat-badge');
    expect(pill.textContent).toBe('+25,502 profit');
    expect(pill.getAttribute('data-tone')).toBe('success');
  });

  it('Still to collect: what customers owe, with the profit to come, leading to customers by balance', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-to-collect');
    expect(within(tile).getByTestId('stat-tile-link').getAttribute('href')).toBe('/customers?sort=balance');
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

// Owner 2026-11-06: keep the pills "as is", with a small (i) beside each that
// says exactly what the figure is. A tap opens it (a phone has no hover), and
// tapping it must not open the tile's list: the tile is a link, so the (i)
// cannot sit inside the <a> (a button in a link is invalid and navigates).
describe('the (i) beside a profit pill', () => {
  const infos = (tile: HTMLElement) => ({
    beside: within(within(tile).getByTestId('stat-label')).queryByTestId('stat-badge-info'),
    phone: within(tile).queryByTestId('stat-badge-info-phone'),
  });

  it('sits right after the pill in both places it shows — beside the title from sm, on the icon row on a phone', async () => {
    renderPage();
    for (const id of ['sales-cash-collected', 'sales-cash-to-collect']) {
      const tile = await screen.findByTestId(id);
      const { beside, phone } = infos(tile);
      expect(beside).not.toBeNull();
      expect(phone).not.toBeNull();
      // Right after its pill, and hidden where that pill is hidden.
      expect(beside!.previousElementSibling!.getAttribute('data-testid')).toBe('stat-badge');
      expect(phone!.previousElementSibling!.getAttribute('data-testid')).toBe('stat-badge-phone');
      expect(within(tile).getByTestId('stat-icon-row').contains(phone)).toBe(true);
      expect(beside!.parentElement!.className.split(/\s+/)).toContain('max-sm:hidden');
      expect(phone!.parentElement!.className.split(/\s+/)).toContain('sm:hidden');
      expect(beside!.tagName).toBe('BUTTON');
      expect(beside!.getAttribute('type')).toBe('button');
      expect(beside!.getAttribute('aria-label')).toBe('What is this figure?');
    }
  });

  it('no pill, no (i)', async () => {
    state.kpis = { ...KPIS, profitOnCollectedEgp: 0.2 };
    renderPage();
    const tile = await screen.findByTestId('sales-cash-collected');
    expect(within(tile).queryByTestId('stat-badge')).toBeNull();
    expect(infos(tile)).toEqual({ beside: null, phone: null });
    expect(within(tile).queryByRole('button')).toBeNull();
  });

  it('is not inside the tile’s link, and the whole tile still opens its list', async () => {
    renderPage();
    for (const [id, href, name] of [
      ['sales-cash-collected', '/payments', /^Collected/],
      ['sales-cash-to-collect', '/customers?sort=balance', /^Still to collect/],
    ] as const) {
      const tile = await screen.findByTestId(id);
      const buttons = within(tile).getAllByRole('button');
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect(button.closest('a')).toBeNull();
      // One link, laid over the whole tile, named as the tile was.
      const link = within(tile).getByRole('link', { name });
      expect(link).toBe(within(tile).getByTestId('stat-tile-link'));
      expect(link.getAttribute('href')).toBe(href);
      expect(link.parentElement).toBe(tile);
      expect(link.className.split(/\s+/)).toEqual(expect.arrayContaining(['absolute', 'inset-0']));
      expect(tile.className.split(/\s+/)).toContain('relative');
      // First in the tile, so Tab reaches the tile before its (i).
      expect(tile.firstElementChild).toBe(link);
    }
  });

  it('tapping it opens what the cash collected’s profit is, and does not follow the tile’s link', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-collected');
    const followed = vi.fn();
    tile.querySelectorAll('a').forEach((a) => a.addEventListener('click', followed));
    const before = window.location.href;
    fireEvent.click(infos(tile).beside!);
    const panel = await screen.findByTestId('stat-badge-info-panel');
    expect(panel.textContent).toContain('Profit in the cash collected');
    expect(panel.textContent).toContain(
      'For each sale: what it sold for minus what its goods cost (purchase price plus shipping). A sale that is only partly paid counts the paid share of its profit. Cash refunds are taken off. Expenses and the exchange-rate loss are not taken off here — Net profit in Analytics takes them off.',
    );
    expect(followed).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  });

  it('Still to collect’s says what is still to come — on the phone’s (i) too', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-to-collect');
    fireEvent.click(infos(tile).phone!);
    const panel = await screen.findByTestId('stat-badge-info-phone-panel');
    expect(panel.textContent).toContain('Profit still to come');
    expect(panel.textContent).toContain(
      'The profit still inside what customers owe: the unpaid share of each sale’s profit. It arrives as they pay.',
    );
    expect(panel.textContent).not.toContain('Cash refunds');
  });

  it('a loss keeps the explanation and says loss', async () => {
    state.kpis = { ...KPIS, profitOnCollectedEgp: -900, profitToCollectEgp: -480.2 };
    renderPage();
    fireEvent.click(infos(await screen.findByTestId('sales-cash-collected')).beside!);
    const collected = await screen.findByTestId('stat-badge-info-panel');
    expect(collected.textContent).toMatch(/^Loss in the cash collected/);
    expect(collected.textContent).toContain('Cash refunds are taken off.');
    cleanup();
    renderPage();
    fireEvent.click(infos(await screen.findByTestId('sales-cash-to-collect')).beside!);
    expect((await screen.findByTestId('stat-badge-info-panel')).textContent).toMatch(/^Loss still to come/);
  });

  it('Escape closes it, and it opens again the second time', async () => {
    renderPage();
    const tile = await screen.findByTestId('sales-cash-collected');
    fireEvent.click(infos(tile).beside!);
    const panel = await screen.findByTestId('stat-badge-info-panel');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('stat-badge-info-panel')).toBeNull());
    fireEvent.click(infos(tile).beside!);
    expect((await screen.findByTestId('stat-badge-info-panel')).textContent).toContain('Profit in the cash collected');
  });

  it('reads in Arabic', async () => {
    renderPage('ar');
    const collected = await screen.findByTestId('sales-cash-collected');
    expect(infos(collected).beside!.getAttribute('aria-label')).toBe('ما هذا الرقم؟');
    fireEvent.click(infos(collected).beside!);
    const panel = await screen.findByTestId('stat-badge-info-panel');
    expect(panel.textContent).toContain('الربح في النقد المحصّل');
    expect(panel.textContent).toContain('صافي الربح في التحليلات يخصمها');
    cleanup();
    renderPage('ar');
    fireEvent.click(infos(await screen.findByTestId('sales-cash-to-collect')).beside!);
    const toCome = await screen.findByTestId('stat-badge-info-panel');
    expect(toCome.textContent).toContain('الربح الذي لم يُحصَّل بعد');
    expect(toCome.textContent).toContain('نصيب غير المدفوع من ربح كل عملية بيع');
  });

  it('the skeleton traces the (i) beside each wide pill, in both places', async () => {
    state.kpis = null;
    renderPage();
    const rows = within(await section()).getAllByTestId('skeleton-row');
    for (const row of rows) {
      const beside = row.querySelector('[data-testid="skeleton-badge-info"]')!;
      expect(beside.previousElementSibling!.getAttribute('data-testid')).toBe('skeleton-badge');
      expect(beside.className.split(/\s+/)).toEqual(expect.arrayContaining(['size-4', 'max-sm:hidden']));
      const phone = row.querySelector('[data-testid="skeleton-badge-info-phone"]')!;
      expect(phone.previousElementSibling!.getAttribute('data-testid')).toBe('skeleton-badge-phone');
      expect(phone.parentElement!.className.split(/\s+/)).toContain('sm:hidden');
    }
  });

  it('a count pill (Stock’s units) gets no (i), and its tile stays one link', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <StatTile label="Stock" value={1} icon={Banknote} color="" href="/inventory" testId="t" badge={{ label: '42', srLabel: '42 units' }} />
      </NextIntlClientProvider>,
    );
    const tile = screen.getByTestId('t');
    expect(tile.tagName).toBe('A');
    expect(within(tile).queryByRole('button')).toBeNull();
  });
});
