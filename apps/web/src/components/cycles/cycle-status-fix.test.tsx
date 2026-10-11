import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { CycleStatusButton } from './cycle-status-button';

/**
 * I3 item 2 — a status change refused because a leg has not left or not
 * arrived offers the fix in place: the departure form or RecordDeliveryDialog
 * for exactly the leg the server named (`params.legId`), and after a save the
 * status can be tried again without leaving the page.
 *
 * It branches on `error.code`, never on the words (CLAUDE.md §9), so a refusal
 * whose English happens to mention a departure offers nothing, and one whose
 * words say nothing about legs still offers its fix.
 */

type Refusal = { code: string; message: string; params?: Record<string, string> } | null;

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  /** What the next transition POST answers; null succeeds. */
  refusal: null as Refusal,
  writes: [] as Array<{ method: string; url: string; body: unknown }>,
  leg1Departed: null as string | null,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const leg = (legId: string, sequence: number, departedOn: string | null, onTheWay: number) => ({
  legId,
  sequence,
  isLast: sequence === 2,
  status: departedOn ? 'IN_TRANSIT' : 'PENDING',
  arrivedOn: null,
  entered: onTheWay,
  delivered: 0,
  lost: 0,
  onTheWay,
  received: sequence === 2 ? 0 : null,
  waiting: sequence === 2 ? 0 : null,
  departedOn,
  origin: sequence === 1 ? 'Guangzhou, China' : 'Dubai, UAE',
  destination: sequence === 1 ? 'Dubai, UAE' : 'Cairo, Egypt',
  lines: [{ purchaseOrderItemId: 'poi-1', entered: onTheWay, delivered: 0, lost: 0, onTheWay, received: null, waiting: null }],
  deliveries: [],
});

vi.mock('@/lib/api', () => {
  const write = (method: string) => (url: string, body?: unknown) => {
    state.writes.push({ method, url, body });
    if (url.endsWith('/transition') && state.refusal) {
      return Promise.reject({ response: { status: 400, data: { error: state.refusal } } });
    }
    return Promise.resolve({ data: { data: {} } });
  };
  return {
    api: {
      get: (url: string) => {
        if (url === '/cycles/c-1/shipment') {
          return Promise.resolve({
            data: {
              data: {
                cycleId: 'c-1',
                code: 'CYC-1',
                status: 'IN_TRANSIT',
                accounted: false,
                totals: { ordered: 40, received: 0, lost: 0, onTheWay: 40, waiting: 0 },
                lines: [{ purchaseOrderItemId: 'poi-1', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, onTheWay: 40, waiting: 0, accounted: false }],
                legs: [leg('leg-1', 1, state.leg1Departed, 40), leg('leg-2', 2, null, 0)],
              },
            },
          });
        }
        return Promise.resolve({ data: { data: [] } });
      },
      post: write('post'),
      put: write('put'),
      delete: write('delete'),
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
  state.refusal = null;
  state.writes = [];
  state.leg1Departed = null;
});
afterEach(() => cleanup());

function wrap(status = 'PURCHASING') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CycleStatusButton cycleId="c-1" status={status} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const NOT_DEPARTED: Refusal = {
  code: 'LEG_NOT_DEPARTED',
  message: 'Guangzhou, China → Dubai, UAE has not departed. Record the departure date on that leg first.',
  params: { leg: 'Guangzhou, China → Dubai, UAE', legId: 'leg-1' },
};
const NOT_ARRIVED: Refusal = {
  code: 'LEG_NOT_ARRIVED',
  message: 'Guangzhou, China → Dubai, UAE has not arrived.',
  params: { leg: 'Guangzhou, China → Dubai, UAE', legId: 'leg-1' },
};

/** Open Change status and pick `to`; resolves to the dialog once the refusal is in it. */
async function tryMove(to: string) {
  fireEvent.click(screen.getByTestId('change-status'));
  const dialog = await screen.findByTestId('change-status-dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: en.codes.cycleStatus[to as 'IN_TRANSIT'] }));
  await within(dialog).findByTestId('status-refusal');
  return dialog;
}

const shipmentDialog = (kind: string) => document.querySelector(`[data-shipment-dialog="${kind}"]`) as HTMLElement | null;

describe('a LEG_NOT_DEPARTED refusal offers Record departure for that leg', () => {
  it('shows the refusal in the dialog with the fix; saving it brings the status dialog back to try again', async () => {
    state.refusal = NOT_DEPARTED;
    wrap('PURCHASING');
    const dialog = await tryMove('IN_TRANSIT');
    const refusal = within(dialog).getByTestId('status-refusal');
    expect(refusal.textContent).toContain('has not departed yet');
    const fix = await within(refusal).findByTestId('status-fix');
    expect(fix.textContent).toContain(en.shipment.recordDeparture);
    expect(fix.getAttribute('type')).toBe('button');

    fireEvent.click(fix);
    const departure = await waitFor(() => {
      const d = shipmentDialog('record-departure');
      if (!d) throw new Error('no departure dialog');
      return d;
    });
    expect(within(departure).getByText(en.shipment.recordDepartureTitle.replace('{leg}', '1'))).toBeTruthy();
    // One dialog at a time: the status dialog steps aside while the fix is open.
    expect(screen.queryByTestId('change-status-dialog')).toBeNull();

    fireEvent.click(within(departure).getByRole('button', { name: en.shipment.recordDeparture }));
    const back = await screen.findByTestId('change-status-dialog');
    expect(shipmentDialog('record-departure')).toBeNull();
    expect(state.writes.filter((w) => w.method === 'put')).toEqual([
      { method: 'put', url: '/shipping/legs/leg-1', body: { departedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } },
    ]);
    // The old refusal is gone and the reader is told to try again.
    expect(within(back).queryByTestId('status-refusal')).toBeNull();
    expect(within(back).getByTestId('status-fix-saved').textContent).toBe(en.cycles.statusFixSaved);

    // Retry: the server now accepts it.
    state.refusal = null;
    fireEvent.click(within(back).getByRole('button', { name: en.codes.cycleStatus.IN_TRANSIT }));
    await screen.findByText(en.cycles.statusUpdated);
    expect(state.writes.filter((w) => w.url.endsWith('/transition'))).toHaveLength(2);
  });
});

describe('a LEG_NOT_ARRIVED refusal offers Record delivery for that leg', () => {
  it('opens RecordDeliveryDialog for the leg; cancelling it brings the status dialog back with the refusal still there', async () => {
    state.refusal = NOT_ARRIVED;
    state.leg1Departed = '2026-09-01';
    wrap('IN_TRANSIT');
    const dialog = await tryMove('ARRIVED_UAE');
    const fix = await within(dialog).findByTestId('status-fix');
    expect(fix.textContent).toContain(en.shipment.recordDelivery);

    fireEvent.click(fix);
    const delivery = await waitFor(() => {
      const d = shipmentDialog('record-delivery');
      if (!d) throw new Error('no delivery dialog');
      return d;
    });
    expect(within(delivery).getByText(en.shipment.recordDeliveryTitle.replace('{leg}', '1'))).toBeTruthy();
    expect((within(delivery).getByTestId('delivery-qty') as HTMLInputElement).value).toBe('40');

    fireEvent.click(within(delivery).getByRole('button', { name: en.common.cancel }));
    const back = await screen.findByTestId('change-status-dialog');
    expect(shipmentDialog('record-delivery')).toBeNull();
    expect(within(back).getByTestId('status-refusal')).toBeTruthy();
    expect(within(back).getByTestId('status-fix')).toBeTruthy();
    expect(state.writes.filter((w) => !w.url.endsWith('/transition'))).toEqual([]);
  });

  it('saving the delivery brings the status dialog back, ready to try again', async () => {
    state.refusal = NOT_ARRIVED;
    state.leg1Departed = '2026-09-01';
    wrap('IN_TRANSIT');
    const dialog = await tryMove('ARRIVED_UAE');
    fireEvent.click(await within(dialog).findByTestId('status-fix'));
    const delivery = await waitFor(() => shipmentDialog('record-delivery')!);
    fireEvent.click(within(delivery).getByRole('button', { name: en.shipment.recordDelivery }));
    const back = await screen.findByTestId('change-status-dialog');
    expect(state.writes.find((w) => w.url === '/shipping/legs/leg-1/deliveries')).toBeTruthy();
    expect(within(back).queryByTestId('status-refusal')).toBeNull();
    expect(within(back).getByTestId('status-fix-saved')).toBeTruthy();
  });

  it('on a leg that has not left yet, the fix it offers is the departure (a delivery would be refused)', async () => {
    state.refusal = NOT_ARRIVED;
    state.leg1Departed = null;
    wrap('IN_TRANSIT');
    const dialog = await tryMove('ARRIVED_UAE');
    const fix = await within(dialog).findByTestId('status-fix');
    expect(fix.textContent).toContain(en.shipment.recordDeparture);
  });
});

describe('no fix where there is none to offer', () => {
  it('other refusals show their reason and no fix button — even when the words mention a departure', async () => {
    const others: Refusal[] = [
      { code: 'BAD_STATUS_TRANSITION', message: 'Leg has not departed', params: { from: 'PURCHASING', to: 'IN_TRANSIT', allowed: 'ARRIVED_UAE' } },
      { code: 'CYCLE_STATUS_CHANGED', message: 'has not departed', params: { cycle: 'CYC-1', status: 'IN_TRANSIT', expected: 'PURCHASING', legId: 'leg-1' } },
      { code: 'ERROR', message: 'has not departed', params: { legId: 'leg-1' } },
    ];
    for (const r of others) {
      state.refusal = r;
      wrap('PURCHASING');
      const dialog = await tryMove('IN_TRANSIT');
      expect(within(dialog).queryByTestId('status-fix'), r!.code).toBeNull();
      cleanup();
    }
  });

  it('a leg refusal without the leg id (an older server) shows the reason and no fix', async () => {
    state.refusal = { ...NOT_DEPARTED!, params: { leg: 'Guangzhou, China → Dubai, UAE' } };
    wrap('PURCHASING');
    const dialog = await tryMove('IN_TRANSIT');
    expect(within(dialog).getByTestId('status-refusal').textContent).toContain('has not departed yet');
    expect(within(dialog).queryByTestId('status-fix')).toBeNull();
  });

  it('a leg id the shipment does not have offers no fix', async () => {
    state.refusal = { ...NOT_DEPARTED!, params: { leg: 'X → Y', legId: 'leg-from-another-cycle' } };
    wrap('PURCHASING');
    const dialog = await tryMove('IN_TRANSIT');
    // Let the shipment load before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(within(dialog).queryByTestId('status-fix')).toBeNull();
  });
});

describe('the status dialog clears on every way out', () => {
  const ways: Array<[string, (dialog: HTMLElement) => void]> = [
    ['Cancel', (d) => fireEvent.click(within(d).getByRole('button', { name: en.common.cancel }))],
    ['Escape', (d) => fireEvent.keyDown(d, { key: 'Escape' })],
  ];
  for (const [name, leave] of ways) {
    it(`${name}: reopening shows the options again with no old refusal and no fix`, async () => {
      state.refusal = NOT_DEPARTED;
      wrap('PURCHASING');
      const dialog = await tryMove('IN_TRANSIT');
      await within(dialog).findByTestId('status-fix');
      leave(dialog);
      await waitFor(() => expect(screen.queryByTestId('change-status-dialog')).toBeNull());

      fireEvent.click(screen.getByTestId('change-status'));
      const again = await screen.findByTestId('change-status-dialog');
      expect(within(again).queryByTestId('status-refusal')).toBeNull();
      expect(within(again).queryByTestId('status-fix')).toBeNull();
      expect(within(again).queryByTestId('status-fix-saved')).toBeNull();
      expect(shipmentDialog('record-departure')).toBeNull();
    });
  }
});
