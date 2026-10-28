import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { RecordDepartureDialog } from './RecordDepartureDialog';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';
import type { Shipment, ShipmentLeg } from './shipment-model';

/**
 * L8 — goods leave in parts (BUSINESS_LOGIC §1, owner 2026-10-12): the Record
 * departure dialog's per-product quantities, and the panel's departures with
 * Undo where the server allows it. Every case tries to break something: a
 * refetch under a typed number, a zero, a non-number, an Undo the server
 * would refuse, a role or a frozen cycle that may not.
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  shipment: null as unknown,
  writes: [] as Array<{ method: string; url: string; body?: unknown }>,
  answer: 'ok' as 'ok' | 'refuse' | 'hang',
  /** What a write says the cycle's status did (L3; an undo back to Preparing). */
  cycleStatus: null as unknown,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api', () => {
  const write = (method: string) => (url: string, body?: unknown) => {
    state.writes.push({ method, url, body });
    if (state.answer === 'hang') return new Promise(() => {});
    if (state.answer === 'refuse') {
      return Promise.reject({
        response: {
          data: {
            error: {
              code: 'DEPARTURE_EXCEEDS_WAITING',
              message: 'English',
              params: { line: 'Brake pad', waiting: 40, asked: 41, leg: 'A → B' },
            },
          },
        },
      });
    }
    return Promise.resolve({ data: { data: {}, cycleStatus: state.cycleStatus } });
  };
  return {
    api: {
      get: (url: string) =>
        Promise.resolve({ data: { data: url.endsWith('/shipment') ? state.shipment : [] } }),
      post: write('post'),
      delete: write('delete'),
      put: write('put'),
    },
  };
});

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
  state.answer = 'ok';
  state.cycleStatus = null;
});
afterEach(() => cleanup());

function wrap(ui: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (node: ReactNode) => (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  const view = render(tree(ui));
  return { ...view, rerender: (node: ReactNode) => view.rerender(tree(node)) };
}

const NAMES = { 'poi-1': 'Brake pad', 'poi-2': 'Chain kit', 'poi-3': 'Mirror' };

/** Leg 1 of a China cycle: 40 pads and 20 chains ordered, 10 chains already left, no mirrors waiting. */
const leg = (over: Partial<ShipmentLeg> = {}): ShipmentLeg => ({
  legId: 'leg-1',
  sequence: 1,
  isLast: false,
  status: 'PARTLY_DEPARTED',
  arrivedOn: null,
  entered: 60,
  departed: 10,
  atOrigin: 50,
  delivered: 0,
  lost: 0,
  onTheWay: 10,
  received: null,
  waiting: null,
  departedOn: '2026-09-01',
  origin: 'Guangzhou, CN',
  destination: 'Dubai, UAE',
  lines: [
    { purchaseOrderItemId: 'poi-1', entered: 40, departed: 0, atOrigin: 40, delivered: 0, lost: 0, onTheWay: 0, received: null, waiting: null },
    { purchaseOrderItemId: 'poi-2', entered: 20, departed: 10, atOrigin: 10, delivered: 0, lost: 0, onTheWay: 10, received: null, waiting: null },
    { purchaseOrderItemId: 'poi-3', entered: 0, departed: 0, atOrigin: 0, delivered: 0, lost: 0, onTheWay: 0, received: null, waiting: null },
  ],
  departures: [
    { id: 'dep-1', departedOn: '2026-09-01', lines: [{ purchaseOrderItemId: 'poi-2', qty: 10 }], undoable: true, undoBlockedBy: null },
  ],
  deliveries: [],
  losses: [],
  ...over,
});

const qty = (line: string) => document.querySelector<HTMLInputElement>(`[data-testid="departure-qty"][data-line="${line}"]`);
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const dialog = (name: string) => document.querySelector<HTMLElement>(`[data-shipment-dialog="${name}"]`);
const submit = () => fireEvent.click(within(dialog('record-departure')!).getByRole('button', { name: en.shipment.recordDeparture }));

describe('Record departure — per-product quantities', () => {
  it('each product starts at everything still waiting; a product with nothing waiting has no row', () => {
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    expect(qty('poi-1')!.value).toBe('40');
    expect(qty('poi-2')!.value).toBe('10');
    expect(qty('poi-3')).toBeNull();
  });

  it('a typed number is never overwritten when the shipment refetches with other figures', () => {
    const { rerender } = wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    type(qty('poi-1')!, '25');
    // Another partner recorded a departure: the server now says 30 and 5 wait.
    const moved = leg({
      lines: leg().lines.map((l) =>
        l.purchaseOrderItemId === 'poi-1' ? { ...l, atOrigin: 30 } : l.purchaseOrderItemId === 'poi-2' ? { ...l, atOrigin: 5 } : l,
      ),
    });
    rerender(<RecordDepartureDialog leg={moved} productNames={NAMES} onClose={() => {}} />);
    expect(qty('poi-1')!.value).toBe('25');
    // The untouched field follows the server.
    expect(qty('poi-2')!.value).toBe('5');
  });

  it('a typed number is kept even when its product then has nothing waiting', () => {
    const { rerender } = wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    type(qty('poi-2')!, '7');
    const gone = leg({ lines: leg().lines.map((l) => (l.purchaseOrderItemId === 'poi-2' ? { ...l, atOrigin: 0 } : l)) });
    rerender(<RecordDepartureDialog leg={gone} productNames={NAMES} onClose={() => {}} />);
    expect(qty('poi-2')!.value).toBe('7');
  });

  it('sends the day and every non-zero line to POST /shipping/legs/:id/departures; a zero is left out', async () => {
    const onClose = vi.fn();
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    type(qty('poi-1')!, '25');
    type(qty('poi-2')!, '0');
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.writes).toEqual([
      {
        method: 'post',
        url: '/shipping/legs/leg-1/departures',
        body: { departedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), lines: [{ purchaseOrderItemId: 'poi-1', qty: 25 }] },
      },
    ]);
  });

  it('every row zero → nothing sent, the dialog says to enter a quantity', () => {
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    type(qty('poi-1')!, '0');
    type(qty('poi-2')!, '');
    submit();
    expect(state.writes).toEqual([]);
    expect(within(dialog('record-departure')!).getByTestId('shipment-refusal').textContent).toBe(en.shipment.nothingEntered);
  });

  it('a quantity that is not a number → named, nothing sent', () => {
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    type(qty('poi-1')!, '2x');
    submit();
    expect(state.writes).toEqual([]);
    expect(within(dialog('record-departure')!).getByTestId('shipment-refusal').textContent).toBe(
      en.shipment.qtyNotNumber.replace('{product}', 'Brake pad'),
    );
  });

  it("the server's refusal is shown translated, the dialog stays open and every value stays as typed", async () => {
    state.answer = 'refuse';
    const onClose = vi.fn();
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    type(qty('poi-1')!, '41');
    submit();
    const refusal = await within(dialog('record-departure')!).findByTestId('shipment-refusal');
    expect(refusal.textContent).toBe('Only 40 of Brake pad are waiting to leave, so a departure of 41 cannot be recorded.');
    expect(onClose).not.toHaveBeenCalled();
    expect(qty('poi-1')!.value).toBe('41');
  });

  it('a double click sends one departure', () => {
    state.answer = 'hang';
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    submit();
    submit();
    expect(state.writes).toHaveLength(1);
  });

  it('Arabic: the strings are there and the quantity inputs read start-aligned', () => {
    wrap(<RecordDepartureDialog leg={leg()} productNames={NAMES} onClose={() => {}} />, 'ar');
    expect(within(dialog('record-departure')!).getByText(ar.shipment.departureQtyPerProduct)).toBeTruthy();
    expect(qty('poi-1')!.className).not.toMatch(/\btext-(left|right)\b/);
  });
});

// ─── The panel ───────────────────────────────────────────────────────────

const panelCycle = (status = 'IN_TRANSIT'): PanelCycle => ({
  id: 'c-1',
  status,
  originType: 'CHINA',
  shippingLegs: [{ id: 'leg-1', provider: 'Merchant', amountEgp: 0 }],
  purchaseOrders: [],
});

const shipmentOf = (l: ShipmentLeg, status = 'IN_TRANSIT'): Shipment => ({
  cycleId: 'c-1',
  code: 'CYC-1',
  status,
  accounted: false,
  totals: { ordered: 60, received: 0, lost: 0, atOrigin: 50, onTheWay: 10, waiting: 0 },
  lines: [
    { purchaseOrderItemId: 'poi-1', productId: 'p1', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, onTheWay: 0, waiting: 0, accounted: false },
    { purchaseOrderItemId: 'poi-2', productId: 'p2', productName: 'Chain kit', ordered: 20, received: 0, lost: 0, onTheWay: 10, waiting: 0, accounted: false },
  ],
  legs: [l],
});

async function panelLeg(l: ShipmentLeg, status = 'IN_TRANSIT') {
  state.shipment = shipmentOf(l, status);
  wrap(<ShipmentPanel cycle={panelCycle(status)} />);
  return (await screen.findByTestId('shipment-leg')) as HTMLElement;
}

describe('the leg in the Shipment panel', () => {
  it('a leg that left in part offers another departure and a delivery at once', async () => {
    const block = await panelLeg(leg());
    expect(within(block).getByTestId('record-departure')).toBeTruthy();
    expect(within(block).getByTestId('record-delivery')).toBeTruthy();
    expect(within(block).getByTestId('leg-status').textContent).toBe(en.codes.legStatus.PARTLY_DEPARTED);
  });

  it('everything left → no Record departure; nothing left → no Record delivery', async () => {
    const allLeft = leg({
      status: 'IN_TRANSIT',
      atOrigin: 0,
      lines: leg().lines.map((l) => ({ ...l, atOrigin: 0, onTheWay: l.entered, departed: l.entered })),
      onTheWay: 60,
    });
    const block = await panelLeg(allLeft);
    expect(within(block).queryByTestId('record-departure')).toBeNull();
    expect(within(block).getByTestId('record-delivery')).toBeTruthy();
    cleanup();

    const noneLeft = leg({
      status: 'PENDING',
      departedOn: null,
      onTheWay: 0,
      atOrigin: 60,
      departures: [],
      lines: leg().lines.map((l) => ({ ...l, atOrigin: l.entered, onTheWay: 0, departed: 0 })),
    });
    const block2 = await panelLeg(noneLeft);
    expect(within(block2).getByTestId('record-departure')).toBeTruthy();
    expect(within(block2).queryByTestId('record-delivery')).toBeNull();
  });

  it('partly arrived AND partly departed: the header says both', async () => {
    const both = leg({ status: 'PARTLY_ARRIVED', delivered: 5, deliveries: [{ id: 'd1', arrivedOn: '2026-09-10', lines: [{ id: 'dl1', purchaseOrderItemId: 'poi-2', qty: 5, received: 0 }] }] });
    const block = await panelLeg(both);
    expect(within(block).getByTestId('leg-status').textContent).toBe(en.codes.legStatus.PARTLY_ARRIVED);
    expect(within(block).getByTestId('leg-partly-departed').textContent).toBe(en.shipment.partlyDeparted);
  });

  it('partly arrived with nothing waiting to leave says only that', async () => {
    const block = await panelLeg(
      leg({ status: 'PARTLY_ARRIVED', atOrigin: 0, lines: leg().lines.map((l) => ({ ...l, atOrigin: 0 })) }),
    );
    expect(within(block).queryByTestId('leg-partly-departed')).toBeNull();
  });

  it('each departure is listed with its day and lines', async () => {
    const block = await panelLeg(leg());
    const rows = within(block).getAllByTestId('shipment-departure');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Sep 1, 2026');
    expect(within(rows[0]).getByTestId('departure-summary').textContent).toBe('Chain kit: 10');
  });

  it('Undo is offered only where the server allows it', async () => {
    const two = leg({
      departures: [
        { id: 'dep-1', departedOn: '2026-09-01', lines: [{ purchaseOrderItemId: 'poi-2', qty: 5 }], undoable: false, undoBlockedBy: 'used' },
        { id: 'dep-2', departedOn: '2026-09-03', lines: [{ purchaseOrderItemId: 'poi-2', qty: 5 }], undoable: true, undoBlockedBy: null },
      ],
    });
    const block = await panelLeg(two);
    const [first, second] = within(block).getAllByTestId('shipment-departure');
    expect(within(first).queryByTestId('undo-departure')).toBeNull();
    expect(within(second).getByTestId('undo-departure')).toBeTruthy();
  });

  it('Undo asks first, then deletes that departure', async () => {
    const block = await panelLeg(leg());
    fireEvent.click(within(block).getByTestId('undo-departure'));
    const confirm = dialog('undo-departure')!;
    expect(confirm).toBeTruthy();
    expect(state.writes).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: en.shipment.undoDeparture }));
    await waitFor(() => expect(state.writes).toEqual([{ method: 'delete', url: '/shipping/departures/dep-1', body: undefined }]));
  });

  // Preparing (§1, 2026-10-27): undoing the shipment's last departure takes the
  // cycle back to Preparing — the dialog says so first, the toast after.
  it('the last departure: Undo says the cycle goes back to Preparing, and the toast says it did', async () => {
    state.cycleStatus = { cycleId: 'c-1', from: 'IN_TRANSIT', to: 'PREPARING', moved: true, steps: ['PREPARING'], stoppedAt: null, ordersConfirmed: [] };
    const last = leg({
      departures: [
        { id: 'dep-1', departedOn: '2026-09-01', lines: [{ purchaseOrderItemId: 'poi-2', qty: 10 }], undoable: true, undoBlockedBy: null, undoReturnsTo: 'PREPARING' },
      ],
    });
    const block = await panelLeg(last, 'IN_TRANSIT');
    fireEvent.click(within(block).getByTestId('undo-departure'));
    const confirm = dialog('undo-departure')!;
    expect(confirm.textContent).toContain(en.shipment.undoDepartureToPreparing);
    fireEvent.click(within(confirm).getByRole('button', { name: en.shipment.undoDeparture }));
    await screen.findByText(`${en.shipment.departureUndone} — cycle is now ${en.codes.cycleStatus.PREPARING}`);
  });

  it('any other departure: no word of Preparing, and a plain toast', async () => {
    const block = await panelLeg(leg(), 'IN_TRANSIT');
    fireEvent.click(within(block).getByTestId('undo-departure'));
    const confirm = dialog('undo-departure')!;
    expect(confirm.textContent).not.toContain(en.shipment.undoDepartureToPreparing);
    fireEvent.click(within(confirm).getByRole('button', { name: en.shipment.undoDeparture }));
    await screen.findByText(en.shipment.departureUndone);
    expect(screen.queryByText(/cycle is now/)).toBeNull();
  });

  it('Undo is hidden on a cycle being settled, closed or cancelled, even where the departure itself is free', async () => {
    for (const status of ['SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      const block = await panelLeg(leg(), status);
      expect(within(block).getAllByTestId('shipment-departure')).toHaveLength(1);
      expect(within(block).queryByTestId('undo-departure'), status).toBeNull();
      expect(within(block).queryByTestId('record-departure'), status).toBeNull();
      cleanup();
    }
  });

  it('an investor or an office role sees the departures, and no Undo or Record departure', async () => {
    for (const role of ['TEMP_INVESTOR', 'ADMIN_SUPPORT']) {
      state.role = role;
      const block = await panelLeg(leg());
      expect(within(block).getAllByTestId('shipment-departure')).toHaveLength(1);
      expect(within(block).queryByTestId('undo-departure'), role).toBeNull();
      expect(within(block).queryByTestId('record-departure'), role).toBeNull();
      cleanup();
    }
  });

  it('the Record departure dialog opens from the panel with the names and what waits', async () => {
    const block = await panelLeg(leg());
    fireEvent.click(within(block).getByTestId('record-departure'));
    expect(dialog('record-departure')).toBeTruthy();
    expect(qty('poi-1')!.value).toBe('40');
    expect(within(dialog('record-departure')!).getByText('Brake pad')).toBeTruthy();
  });
});
