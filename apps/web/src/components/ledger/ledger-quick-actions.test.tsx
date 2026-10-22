import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

// The ledger page's Fuel quick action (owner 2026-10-18): a quick-action tile,
// in a strip of its own under the title, never one of Add / Export. Since
// 2026-10-18 the only place Fuel is recorded from — not the dashboard.

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ledger',
}));

const auth = vi.hoisted(() => ({ role: 'CORE_PARTNER' as string | undefined }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: auth.role ? { id: 'u1', email: 'x@y.z', role: auth.role } : null }),
}));

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get, post } }));

import LedgerPage from '@/app/[locale]/ledger/page';
import { QuickActions } from '@/components/dashboard/quick-actions';

const ROW = {
  id: 'l1', type: 'EXPENSE', category: 'rent', direction: 'OUTFLOW', amount: 1000, currency: 'EGP',
  createdAt: '2026-10-01T10:00:00.000Z', occurredOn: '2026-10-01',
};

beforeEach(() => {
  auth.role = 'CORE_PARTNER';
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/ledger') return Promise.resolve({ data: { data: [ROW] } });
    if (url.startsWith('/cycles')) return Promise.resolve({ data: { data: [] } });
    if (url.startsWith('/currency-rates')) return Promise.resolve({ data: { data: {} } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});
afterEach(cleanup);

function wrap(children: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <ToastProvider>{children}</ToastProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const renderLedger = async (locale: 'en' | 'ar' = 'en') => {
  render(wrap(<LedgerPage />, locale));
  await screen.findAllByText((locale === 'en' ? en : ar).ledger.title);
};
const fuel = () => screen.queryByTestId('quick-action-recordFuel');
const strip = () => screen.queryByTestId('ledger-quick-actions');
const dialog = () => document.querySelector('[data-ledger-entry-dialog]');
const category = () => document.querySelector<HTMLInputElement>('input[type="hidden"][name="category"]')?.value;
const amount = () => document.querySelector<HTMLInputElement>('#ledger-amount')!;
const ledgerFetches = () => get.mock.calls.filter((c) => c[0] === '/ledger').length;

describe('the ledger page has the Fuel quick action', () => {
  it('a core partner sees it, labelled as a quick action', async () => {
    await renderLedger();
    expect(fuel()?.textContent).toContain(en.dashboard.actions.recordFuel);
    const nav = screen.getByRole('navigation', { name: en.dashboard.quickActions });
    expect(nav.contains(fuel())).toBe(true);
  });

  it('looks like a dashboard quick action: same tile, same icon size', async () => {
    render(wrap(<QuickActions role="CORE_PARTNER" />));
    // The dashboard no longer has Fuel (owner 2026-10-18); compare with an outlined tile there.
    expect(screen.queryByTestId('quick-action-recordFuel')).toBeNull();
    const onDashboard = screen.getByTestId('quick-action-recordPayment');
    const look = onDashboard.className;
    const icon = onDashboard.querySelector('svg')?.getAttribute('class')?.split(' ').filter((c) => c !== 'icon' && !c.startsWith('icon-'));
    cleanup();
    await renderLedger();
    expect(fuel()!.className).toBe(look);
    const fuelIcon = fuel()!.querySelector('svg')?.getAttribute('class')?.split(' ').filter((c) => c !== 'icon' && !c.startsWith('icon-'));
    expect(fuelIcon).toEqual(icon);
  });

  it('is not one of the toolbar buttons: Add and Export sit elsewhere and look different', async () => {
    await renderLedger();
    const add = screen.getByRole('button', { name: en.ledger.create });
    const exportBtn = screen.getByRole('button', { name: en.common.export });
    expect(strip()!.contains(add)).toBe(false);
    expect(strip()!.contains(exportBtn)).toBe(false);
    // Not in the same row as them, nor dressed like them.
    expect(add.parentElement!.contains(fuel())).toBe(false);
    expect(fuel()!.className).not.toBe(add.className);
    expect(fuel()!.className).not.toBe(exportBtn.className);
    expect(within(strip()!).getAllByRole('button')).toHaveLength(1);
  });

  it.each(['ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])('%s, who may not write the ledger, does not see it', async (role) => {
    auth.role = role;
    await renderLedger();
    expect(fuel()).toBeNull();
    expect(strip()).toBeNull();
  });

  it('nobody known yet (auth loading) shows nothing', async () => {
    auth.role = undefined;
    await renderLedger();
    expect(fuel()).toBeNull();
  });

  it('opens the same entry form, on Expense → Fuel', async () => {
    await renderLedger();
    expect(dialog()).toBeNull();
    fireEvent.click(fuel()!);
    expect(dialog()).toBeTruthy();
    expect(category()).toBe('fuel');
    expect(screen.getByRole('radio', { name: new RegExp(en.ledger.kindExpense) }).getAttribute('aria-checked')).toBe('true');
    expect(amount().value).toBe('');
  });

  it('Add entry still opens the form with no category chosen', async () => {
    await renderLedger();
    fireEvent.click(screen.getByRole('button', { name: en.ledger.create }));
    expect(dialog()).toBeTruthy();
    expect(category() ?? '').toBe('');
  });

  it('saving records a fuel expense and refreshes the ledger list', async () => {
    post.mockResolvedValue({ data: { data: { id: 'tx' } } });
    await renderLedger();
    await waitFor(() => expect(ledgerFetches()).toBe(1));
    fireEvent.click(fuel()!);
    fireEvent.focus(amount());
    fireEvent.change(amount(), { target: { value: '650' } });
    fireEvent.blur(amount());
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/ledger');
    expect(post.mock.calls[0][1]).toMatchObject({ kind: 'EXPENSE', direction: 'OUTFLOW', category: 'fuel', amount: 650 });
    await waitFor(() => expect(ledgerFetches()).toBe(2));
  });

  it('with no amount, Save sends nothing and nothing is refetched', async () => {
    await renderLedger();
    await waitFor(() => expect(ledgerFetches()).toBe(1));
    fireEvent.click(fuel()!);
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    expect(await screen.findByTestId('ledger-refusal')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(ledgerFetches()).toBe(1);
  });

  it('the second time opens a fresh form: Cancel leaves nothing behind', async () => {
    await renderLedger();
    fireEvent.click(fuel()!);
    fireEvent.change(amount(), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    expect(dialog()).toBeNull();
    fireEvent.click(fuel()!);
    expect(amount().value).toBe('');
    expect(category()).toBe('fuel');
    expect(post).not.toHaveBeenCalled();
  });

  it('reads in Arabic', async () => {
    await renderLedger('ar');
    expect(fuel()?.textContent).toContain(ar.dashboard.actions.recordFuel);
    expect(strip()?.textContent).toContain(ar.dashboard.quickActions);
  });
});
