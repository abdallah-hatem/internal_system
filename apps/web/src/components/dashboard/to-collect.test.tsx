import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ push }),
}));
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get } }));

import { ToCollect, daysSince, type ToCollectData } from './to-collect';

const row = (customerId: string, customer: string, outstanding: string, overdue = '0.00', openOrders = 1, oldestUnpaidOn = '2026-10-01') =>
  ({ customerId, customer, outstanding, overdue, openOrders, oldestUnpaidOn });

const DATA: ToCollectData = {
  totalOwed: '129550.00',
  totalOverdue: '16500.00',
  customers: 7,
  rows: [
    row('c1', 'El Masry Moto Parts', '48500.00', '12000.00', 3),
    row('c2', 'Speed Riders Shop', '27850.00'),
  ],
};

function show(data: ToCollectData | Error, locale: 'en' | 'ar' = 'en') {
  get.mockReset();
  get.mockImplementation((url: string, cfg?: { params?: { limit?: number } }) => {
    expect(url).toBe('/customers/to-collect');
    expect(cfg?.params?.limit).toBe(5);
    return data instanceof Error ? Promise.reject(data) : Promise.resolve({ data: { data } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <ToCollect />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => push.mockReset());
afterEach(cleanup);

describe('To collect card (owner, 2026-10-15)', () => {
  it('shows the rows in the order the API gives — overdue first is the API\'s rule, not re-sorted here', async () => {
    show(DATA);
    const rows = await screen.findAllByTestId('to-collect-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('El Masry Moto Parts'),
      expect.stringContaining('Speed Riders Shop'),
    ]);
  });

  it('the overdue line shows only on a row with something overdue', async () => {
    show(DATA);
    const [late, onTime] = await screen.findAllByTestId('to-collect-row');
    expect(within(late).getByTestId('to-collect-overdue').textContent).toMatch(/12,000\.00.*overdue/);
    expect(within(onTime).queryByTestId('to-collect-overdue')).toBeNull();
  });

  it('the headline totals everyone owing, with the overdue part', async () => {
    show(DATA);
    const total = await screen.findByTestId('to-collect-total');
    expect(total.textContent).toMatch(/129,550\.00/);
    expect(total.textContent).toMatch(/16,500\.00.*overdue/);
  });

  it('no overdue part in the headline when nothing is overdue', async () => {
    show({ ...DATA, totalOverdue: '0.00', rows: [row('c2', 'Speed Riders Shop', '27850.00')] });
    const total = await screen.findByTestId('to-collect-total');
    expect(total.textContent).not.toMatch(/overdue/);
  });

  it('a row opens that customer; View all opens Customers sorted by balance', async () => {
    show(DATA);
    const [first] = await screen.findAllByTestId('to-collect-row');
    fireEvent.click(first);
    expect(push).toHaveBeenCalledWith('/customers/c1');
    expect(screen.getByTestId('to-collect-all').getAttribute('href')).toBe('/customers?sort=balance');
  });

  it('nobody owing is an empty state with its hint — no table, no View all', async () => {
    show({ totalOwed: '0.00', totalOverdue: '0.00', customers: 0, rows: [] });
    expect(await screen.findByText(en.dashboard.toCollectEmpty)).toBeTruthy();
    expect(screen.queryByTestId('to-collect-row')).toBeNull();
    expect(screen.queryByTestId('to-collect-all')).toBeNull();
  });

  it('a failed request says so and ends the loading state', async () => {
    show(new Error('boom'));
    expect((await screen.findByRole('alert')).textContent).toBe(en.dashboard.toCollectError);
    expect(screen.queryByTestId('skeleton-row')).toBeNull();
  });

  it('in Arabic the titles and counts are Arabic', async () => {
    show(DATA, 'ar');
    expect(await screen.findByText(ar.dashboard.toCollect, { selector: 'h3' })).toBeTruthy();
    const [first] = await screen.findAllByTestId('to-collect-row');
    // Latin digits like every figure in the app; the formatter's invisible
    // direction marks may sit around the number.
    expect(first.textContent).toMatch(/3[\u200e\u200f\s]*فواتير/);
    expect(first.textContent).not.toMatch(/[٠-٩]/);
  });
});

describe('daysSince — the oldest unpaid order\'s age, in Cairo days', () => {
  it('today is 0, never negative for a day in the future', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    expect(daysSince('2026-10-15', now)).toBe(0);
    expect(daysSince('2026-10-20', now)).toBe(0);
  });
  it('counts calendar days in Cairo: 23:30 UTC on 14 Oct is already the 15th there', () => {
    expect(daysSince('2026-10-14', new Date('2026-10-14T23:30:00Z'))).toBe(1);
    expect(daysSince('2026-10-14', new Date('2026-10-14T20:30:00Z'))).toBe(0);
  });
  it('across a month and a year end', () => {
    expect(daysSince('2026-09-30', new Date('2026-10-01T09:00:00Z'))).toBe(1);
    expect(daysSince('2025-12-31', new Date('2026-01-01T09:00:00Z'))).toBe(1);
    expect(daysSince('2026-01-01', new Date('2026-10-15T09:00:00Z'))).toBe(287);
  });
  it('a day that does not parse reads as 0 rather than NaN on screen', () => {
    expect(daysSince('not-a-day', new Date('2026-10-15T09:00:00Z'))).toBe(0);
  });
});
