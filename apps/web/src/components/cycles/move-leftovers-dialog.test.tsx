import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { MoveLeftoversDialog } from './move-leftovers-dialog';
import { CycleTransfersSection, MoveLeftoversButton } from './cycle-transfers';

/**
 * L5 — the Move leftovers dialog (BUSINESS_LOGIC §8). It reaches the server
 * the way a person does: what is on the shelf from `/transfers/movable`, the
 * cycles from `/cycles`, and one POST with exactly what was chosen. The rules
 * themselves are the server's (stock-transfers.spec.ts); this checks the
 * dialog says them, offers only what the server would take, and never
 * overwrites a number someone typed.
 */

type Refusal = { code: string; message: string; params?: Record<string, string | number> } | null;

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  /** What the next POST answers; null succeeds. */
  refusal: null as Refusal,
  /** What `/transfers/movable` answers. */
  movable: null as unknown,
  transfers: { out: [] as unknown[], in: [] as unknown[] },
  writes: [] as Array<{ url: string; body: unknown }>,
  gets: [] as string[],
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CYCLES = [
  { id: 'cyc-a', code: 'CYC-A', status: 'SELLING' },
  { id: 'cyc-b', code: 'CYC-B', status: 'PLANNING' },
  { id: 'cyc-c', code: 'CYC-C', status: 'SELLING' },
  { id: 'cyc-s', code: 'CYC-S', status: 'SETTLEMENT' },
  { id: 'cyc-x', code: 'CYC-X', status: 'CLOSED' },
  { id: 'cyc-z', code: 'CYC-Z', status: 'CANCELLED' },
];

const SHELF = {
  cycle: { id: 'cyc-a', code: 'CYC-A', status: 'SELLING' },
  refusal: null,
  products: [
    {
      productId: 'p-pad',
      productName: 'Brake pad',
      sku: 'PAD',
      available: '30.000',
      batches: [{ id: 'b1', available: '30.000', unitCostEgp: '110.0000', arrivedOn: '2026-09-20' }],
    },
    {
      productId: 'p-chain',
      productName: 'Chain kit',
      sku: 'CHN',
      available: '4.000',
      batches: [{ id: 'b2', available: '4.000', unitCostEgp: '250.0000', arrivedOn: '2026-09-20' }],
    },
  ],
};

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      state.gets.push(url);
      if (url === '/cycles/cyc-a/transfers/movable') return Promise.resolve({ data: { data: state.movable } });
      if (url === '/cycles/cyc-a/transfers') return Promise.resolve({ data: { data: state.transfers } });
      if (url === '/cycles') return Promise.resolve({ data: { data: CYCLES, meta: { nextCursor: null } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body?: unknown) => {
      state.writes.push({ url, body });
      if (state.refusal) return Promise.reject({ response: { status: 400, data: { error: state.refusal } } });
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
  state.refusal = null;
  state.movable = structuredClone(SHELF);
  state.transfers = { out: [], in: [] };
  state.writes = [];
  state.gets = [];
});
afterEach(() => cleanup());

let client: QueryClient;
function wrap(node: ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const dialog = () => document.querySelector('[data-shipment-dialog="move-leftovers"]') as HTMLElement;
const qty = (product: string) =>
  dialog().querySelector(`[data-testid="move-qty"][data-product="${product}"]`) as HTMLInputElement;

async function open(props: Partial<Parameters<typeof MoveLeftoversDialog>[0]> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  wrap(<MoveLeftoversDialog cycleId="cyc-a" cycleCode="CYC-A" onSaved={onSaved} onClose={onClose} {...props} />);
  await waitFor(() => expect(qty('Brake pad')).toBeTruthy());
  return { onSaved, onClose };
}

async function pickTarget(code: string) {
  fireEvent.click(within(dialog()).getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(code) }));
}
const reason = (text: string) => fireEvent.change(within(dialog()).getByTestId('move-reason'), { target: { value: text } });
const submit = () => fireEvent.click(within(dialog()).getByRole('button', { name: en.transfers.move }));

describe('Move leftovers', () => {
  it('starts every product at all of it, shows the cost, and posts exactly what was chosen', async () => {
    const { onSaved, onClose } = await open();
    expect(qty('Brake pad').value).toBe('30');
    expect(qty('Chain kit').value).toBe('4');
    // 30 × 110 + 4 × 250
    expect(within(dialog()).getByTestId('move-total').textContent).toMatch(/4,300\.00/);

    fireEvent.change(qty('Chain kit'), { target: { value: '0' } });
    fireEvent.change(qty('Brake pad'), { target: { value: '12' } });
    expect(within(dialog()).getByTestId('move-total').textContent).toMatch(/1,320\.00/);
    await pickTarget('CYC-B');
    reason('End of season');
    submit();

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(state.writes).toEqual([
      {
        url: '/cycles/cyc-a/transfers',
        body: {
          toCycleId: 'cyc-b',
          movedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          reason: 'End of season',
          lines: [{ productId: 'p-pad', qty: 12 }],
        },
      },
    ]);
  });

  it('offers only cycles that may take stock: never itself, never one settling, closed or cancelled', async () => {
    await open();
    fireEvent.click(within(dialog()).getByRole('combobox'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(options.some((o) => o.includes('CYC-B'))).toBe(true);
    expect(options.some((o) => o.includes('CYC-C'))).toBe(true);
    for (const code of ['CYC-A', 'CYC-S', 'CYC-X', 'CYC-Z']) {
      expect(options.some((o) => o.includes(code)), code).toBe(false);
    }
  });

  it('a target chosen before opening (back from a new cycle) is already picked', async () => {
    await open({ initialTargetId: 'cyc-b' });
    expect(within(dialog()).getByRole('combobox').textContent).toContain('CYC-B');
  });

  it('“Start a new cycle for them” goes to the wizard, saying which cycle the leftovers are from', async () => {
    await open();
    expect(within(dialog()).getByTestId('move-new-cycle').getAttribute('href')).toBe('/cycles/new?leftoversFrom=cyc-a');
  });

  it('a number typed is never overwritten when what is on the shelf is read again', async () => {
    await open();
    fireEvent.change(qty('Brake pad'), { target: { value: '7' } });
    state.movable = { ...SHELF, products: SHELF.products.map((p) => ({ ...p, available: '29.000' })) };
    await act(() => client.invalidateQueries({ queryKey: ['cycle-transfers'] }));
    await waitFor(() => expect(qty('Chain kit').value).toBe('29'));
    expect(qty('Brake pad').value).toBe('7');
  });

  it('no target, no reason, nothing chosen, or a quantity that is not a number: said here, nothing sent', async () => {
    await open();
    submit();
    expect(await within(dialog()).findByText(en.transfers.pickTarget, { selector: '[role=alert]' })).toBeTruthy();
    await pickTarget('CYC-B');
    submit();
    expect(within(dialog()).getByRole('alert').textContent).toBe(en.transfers.reasonRequired);
    reason('x');
    fireEvent.change(qty('Brake pad'), { target: { value: '' } });
    fireEvent.change(qty('Chain kit'), { target: { value: '0' } });
    submit();
    expect(within(dialog()).getByRole('alert').textContent).toBe(en.transfers.nothingChosen);
    fireEvent.change(qty('Brake pad'), { target: { value: 'ten' } });
    submit();
    expect(within(dialog()).getByRole('alert').textContent).toBe(en.transfers.qtyNotNumber.replace('{product}', 'Brake pad'));
    expect(state.writes).toEqual([]);
  });

  it('a refusal from the server is shown in the dialog, translated by its code, and the dialog stays open', async () => {
    const { onSaved, onClose } = await open();
    state.refusal = {
      code: 'TRANSFER_MORE_THAN_ON_SHELF',
      message: 'english fallback',
      params: { product: 'Brake pad', available: '28', requested: '30' },
    };
    await pickTarget('CYC-B');
    reason('x');
    submit();
    const alert = await within(dialog()).findByTestId('shipment-refusal');
    expect(alert.textContent).toBe('Only 28 of Brake pad can be moved; 30 was asked for.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  it('a cycle that cannot move anything says why, with no form and no Move button', async () => {
    state.movable = {
      ...SHELF,
      refusal: { code: 'TRANSFER_SOURCE_NOT_ACCOUNTED', message: 'x', params: { cycle: 'CYC-A', onTheWay: 5, waiting: 0 } },
    };
    wrap(<MoveLeftoversDialog cycleId="cyc-a" cycleCode="CYC-A" onClose={() => {}} />);
    const why = await screen.findByTestId('move-cannot');
    expect(why.textContent).toContain('5 unit(s) on the way');
    expect(screen.queryByTestId('move-qty')).toBeNull();
    expect(screen.queryByRole('button', { name: en.transfers.move })).toBeNull();
  });

  it('every button in it says its type, so none submits by accident', async () => {
    await open();
    for (const b of dialog().querySelectorAll('button')) {
      expect(b.getAttribute('type'), b.textContent ?? '').toMatch(/^(button|submit)$/);
    }
  });
});

describe('the button and the Transfers section', () => {
  it('Move leftovers shows for a core partner on a selling or settling cycle only', () => {
    wrap(<MoveLeftoversButton cycleId="cyc-a" cycleCode="CYC-A" status="SELLING" />);
    expect(screen.getByTestId('move-leftovers')).toBeTruthy();
    cleanup();
    wrap(<MoveLeftoversButton cycleId="cyc-a" cycleCode="CYC-A" status="VERIFICATION" />);
    expect(screen.queryByTestId('move-leftovers')).toBeNull();
    cleanup();
    state.role = 'TEMP_INVESTOR';
    wrap(<MoveLeftoversButton cycleId="cyc-a" cycleCode="CYC-A" status="SELLING" />);
    expect(screen.queryByTestId('move-leftovers')).toBeNull();
  });

  it('?moveTo= opens the dialog with that cycle chosen, and is dropped from the address', async () => {
    window.history.replaceState(null, '', '/en/cycles/cyc-a/details?moveTo=cyc-b');
    wrap(<MoveLeftoversButton cycleId="cyc-a" cycleCode="CYC-A" status="SELLING" />);
    await waitFor(() => expect(qty('Brake pad')).toBeTruthy());
    expect(within(dialog()).getByRole('combobox').textContent).toContain('CYC-B');
    expect(window.location.search).toBe('');
  });

  const row = (over: Record<string, unknown>) => ({
    id: 't-1',
    status: 'ACTIVE',
    movedOn: '2026-10-10',
    reason: 'End of season',
    createdAt: '2026-10-10T09:00:00Z',
    createdBy: { id: 'u-1', name: 'Omar' },
    reversedAt: null,
    reversalReason: null,
    reversedBy: null,
    fromCycle: { id: 'cyc-a', code: 'CYC-A' },
    toCycle: { id: 'cyc-b', code: 'CYC-B' },
    totalCostEgp: '2200.00',
    lines: [{ id: 'l1', productId: 'p-pad', productName: 'Brake pad', sku: 'PAD', sourceBatchId: 'b1', destBatchId: 'b9', qty: '20.000', unitCostEgp: '110.0000', costEgp: '2200.00' }],
    undo: { allowed: true },
    ...over,
  });

  it('Undo is offered only while the server would allow it; otherwise the reason is said', async () => {
    state.transfers = {
      out: [
        row({}),
        row({ id: 't-2', undo: { allowed: false, code: 'TRANSFER_UNITS_SOLD', params: { product: 'Brake pad', cycle: 'CYC-B' } } }),
      ],
      in: [],
    };
    wrap(<CycleTransfersSection cycleId="cyc-a" />);
    const rows = await screen.findAllByTestId('transfer-row');
    expect(within(rows[0]).getByTestId('transfer-undo')).toBeTruthy();
    expect(within(rows[0]).getByText(/To/).textContent).toContain('CYC-B');
    expect(within(rows[1]).queryByTestId('transfer-undo')).toBeNull();
    expect(within(rows[1]).getByTestId('transfer-permanent').textContent).toBe(
      'Some of the Brake pad moved to CYC-B has been sold or used there; the move is permanent now.',
    );
  });

  it('Undo asks why, then posts it', async () => {
    state.transfers = { out: [row({})], in: [] };
    wrap(<CycleTransfersSection cycleId="cyc-a" />);
    fireEvent.click(await screen.findByTestId('transfer-undo'));
    const d = document.querySelector('[data-shipment-dialog="undo-transfer"]') as HTMLElement;
    fireEvent.click(within(d).getByRole('button', { name: en.transfers.undo }));
    expect(within(d).getByRole('alert').textContent).toBe(en.transfers.reasonRequired);
    fireEvent.change(within(d).getByTestId('undo-reason'), { target: { value: 'Wrong cycle' } });
    fireEvent.click(within(d).getByRole('button', { name: en.transfers.undo }));
    await waitFor(() => expect(state.writes).toEqual([{ url: '/stock-transfers/t-1/undo', body: { reason: 'Wrong cycle' } }]));
  });

  it('an investor sees the transfers and no Undo', async () => {
    state.role = 'TEMP_INVESTOR';
    state.transfers = { out: [row({})], in: [] };
    wrap(<CycleTransfersSection cycleId="cyc-a" />);
    await screen.findByTestId('transfer-row');
    expect(screen.queryByTestId('transfer-undo')).toBeNull();
  });
});
