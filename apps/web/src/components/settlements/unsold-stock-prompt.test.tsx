import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { UnsoldStockPrompt } from './unsold-stock-prompt';

/**
 * L5 — paying out a settlement whose cycle still holds stock is refused with
 * `CYCLE_HAS_UNSOLD_STOCK`; the refusal now offers Move leftovers in place, as
 * I3's status refusal offers its fix: the prompt steps aside for the cycle's
 * own Move leftovers dialog and comes back when it closes — after a save,
 * ready to pay out again (no write-off); after a cancel, exactly as it was.
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  writes: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/cyc-a/transfers/movable') {
        return Promise.resolve({
          data: {
            data: {
              cycle: { id: 'cyc-a', code: 'CYC-A', status: 'SETTLEMENT' },
              refusal: null,
              products: [
                { productId: 'p-pad', productName: 'Brake pad', sku: 'PAD', available: '30.000', batches: [{ id: 'b1', available: '30.000', unitCostEgp: '110.0000', arrivedOn: null }] },
              ],
            },
          },
        });
      }
      if (url === '/cycles') {
        return Promise.resolve({ data: { data: [{ id: 'cyc-b', code: 'CYC-B', status: 'PLANNING' }], meta: { nextCursor: null } } });
      }
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body?: unknown) => {
      state.writes.push({ url, body });
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
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.writes = [];
});
afterEach(() => cleanup());

const MESSAGE = 'Cycle CYC-A still holds 30 units worth 3,300.00 EGP at landed cost.';

function wrap(props: Partial<Parameters<typeof UnsoldStockPrompt>[0]> = {}) {
  const onPay = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <UnsoldStockPrompt
            message={MESSAGE}
            cycleId="cyc-a"
            cycleCode="CYC-A"
            paying={false}
            onPay={onPay}
            onClose={onClose}
            {...props}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onPay, onClose };
}

const prompt = () => document.querySelector('[data-shipment-dialog="unsold-stock"]') as HTMLElement | null;
const mover = () => document.querySelector('[data-shipment-dialog="move-leftovers"]') as HTMLElement | null;

describe('CYCLE_HAS_UNSOLD_STOCK offers Move leftovers in place', () => {
  it('shows the refusal with the fix; the fix opens Move leftovers for that cycle and the prompt steps aside', async () => {
    wrap();
    expect(within(prompt()!).getByTestId('unsold-refusal').textContent).toBe(MESSAGE);
    const fix = within(prompt()!).getByTestId('unsold-move');
    expect(fix.getAttribute('type')).toBe('button');
    fireEvent.click(fix);
    await waitFor(() => expect(mover()).toBeTruthy());
    expect(prompt()).toBeNull();
    expect(within(mover()!).getByTestId('dialog-subtitle').textContent).toBe('CYC-A');
  });

  it('saving the move brings the prompt back saying so, and paying out again does not accept a write-off', async () => {
    const { onPay } = wrap();
    fireEvent.click(within(prompt()!).getByTestId('unsold-move'));
    await waitFor(() => expect(mover()?.querySelector('[data-testid="move-qty"]')).toBeTruthy());
    fireEvent.click(within(mover()!).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /CYC-B/ }));
    fireEvent.change(within(mover()!).getByTestId('move-reason'), { target: { value: 'Next season' } });
    fireEvent.click(within(mover()!).getByRole('button', { name: en.transfers.move }));

    await waitFor(() => expect(prompt()).toBeTruthy());
    expect(mover()).toBeNull();
    expect(state.writes.map((w) => w.url)).toEqual(['/cycles/cyc-a/transfers']);
    expect(within(prompt()!).getByTestId('unsold-moved').textContent).toBe(en.transfers.movedTryAgain);
    expect(within(prompt()!).queryByTestId('unsold-close-anyway')).toBeNull();
    fireEvent.click(within(prompt()!).getByTestId('unsold-pay-again'));
    expect(onPay).toHaveBeenCalledWith(false);
  });

  it('cancelling the move brings the prompt back exactly as it was — the refusal, the fix, Close anyway', async () => {
    const { onPay } = wrap();
    fireEvent.click(within(prompt()!).getByTestId('unsold-move'));
    await waitFor(() => expect(mover()).toBeTruthy());
    fireEvent.click(within(mover()!).getByRole('button', { name: en.common.cancel }));
    await waitFor(() => expect(prompt()).toBeTruthy());
    expect(within(prompt()!).getByTestId('unsold-refusal').textContent).toBe(MESSAGE);
    expect(within(prompt()!).getByTestId('unsold-move')).toBeTruthy();
    expect(state.writes).toEqual([]);
    fireEvent.click(within(prompt()!).getByTestId('unsold-close-anyway'));
    expect(onPay).toHaveBeenCalledWith(true);
  });

  it('no fix for a role that cannot move stock, nor when the refusal names no cycle', () => {
    state.role = 'ADMIN_SUPPORT';
    wrap();
    expect(within(prompt()!).queryByTestId('unsold-move')).toBeNull();
    expect(within(prompt()!).getByTestId('unsold-close-anyway')).toBeTruthy();
    cleanup();
    state.role = 'CORE_PARTNER';
    wrap({ cycleId: undefined });
    expect(within(prompt()!).queryByTestId('unsold-move')).toBeNull();
  });
});
