import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import CycleDetailsPage from '@/app/[locale]/cycles/[cycleId]/details/page';

/**
 * I3 item 1 — a leg's departure and its deliveries are recorded from the cycle
 * details page's Shipping card (owner, 2026-10-11).
 *
 * Both directions of every rule (CLAUDE.md §12): the role that may and the
 * roles that may not; an open cycle and a frozen one. The dialogs are the
 * existing ones, portalled, and every way out of them leaves nothing behind
 * (§13). e2e (phase 2): apps/web/tests/95-cycle-details-shipping.spec.ts.
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  status: 'IN_TRANSIT' as string,
  /** Leg 1's departure; leg 2 has always departed in these fixtures. */
  leg1Departed: null as string | null,
  gets: [] as string[],
  writes: [] as Array<{ method: string; url: string; body: unknown }>,
  answer: 'ok' as 'ok' | 'refuse' | 'hang',
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ cycleId: 'c-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en/cycles/c-1/details',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const LEG_ROWS = () => [
  { id: 'leg-1', sequence: 1, origin: 'Guangzhou, China', destination: 'Dubai, UAE', provider: 'Merchant', departedOn: state.leg1Departed, status: state.leg1Departed ? 'IN_TRANSIT' : 'PENDING', amountEgp: '0' },
  { id: 'leg-2', sequence: 2, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', provider: 'Aramex', departedOn: '2026-09-10', status: 'IN_TRANSIT', amountEgp: '0' },
];

const legPosition = (legId: string, sequence: number, departedOn: string | null, onTheWay: number, isLast: boolean) => ({
  legId,
  sequence,
  isLast,
  status: departedOn ? 'IN_TRANSIT' : 'PENDING',
  arrivedOn: null,
  entered: onTheWay,
  delivered: 0,
  lost: 0,
  onTheWay,
  received: isLast ? 0 : null,
  waiting: isLast ? 0 : null,
  departedOn,
  origin: sequence === 1 ? 'Guangzhou, China' : 'Dubai, UAE',
  destination: sequence === 1 ? 'Dubai, UAE' : 'Cairo, Egypt',
  lines: [{ purchaseOrderItemId: 'poi-1', entered: onTheWay, delivered: 0, lost: 0, onTheWay, received: isLast ? 0 : null, waiting: isLast ? 0 : null }],
  deliveries: [],
  losses: [],
});

const shipment = () => ({
  cycleId: 'c-1',
  code: 'CYC-1',
  status: state.status,
  accounted: false,
  totals: { ordered: 40, received: 0, lost: 0, onTheWay: 40, waiting: 0 },
  lines: [{ purchaseOrderItemId: 'poi-1', productId: 'p-1', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, onTheWay: 40, waiting: 0, accounted: false }],
  // Leg 2 has goods on the way (as if leg 1 had delivered them), so both buttons have a reason to show.
  legs: [legPosition('leg-1', 1, state.leg1Departed, 40, false), legPosition('leg-2', 2, '2026-09-10', 40, true)],
});

const cycle = () => ({
  id: 'c-1',
  code: 'CYC-1',
  status: state.status,
  originType: 'CHINA',
  currency: 'USD',
  participants: [],
  purchaseOrders: [],
  shippingLegs: LEG_ROWS(),
  inventoryBatches: [],
});

const refusal = () =>
  Promise.reject({
    response: {
      status: 400,
      data: { error: { code: 'DELIVERY_BEFORE_DEPARTURE', message: 'English', params: { day: '2026-09-01', departedOn: '2026-09-05', leg: 'A → B' } } },
    },
  });

vi.mock('@/lib/api', () => {
  const write = (method: string) => (url: string, body?: unknown) => {
    state.writes.push({ method, url, body });
    if (state.answer === 'hang') return new Promise(() => {});
    if (state.answer === 'refuse') return refusal();
    return Promise.resolve({ data: { data: {} } });
  };
  return {
    api: {
      get: (url: string) => {
        state.gets.push(url);
        if (url === '/cycles/c-1/shipment') return Promise.resolve({ data: { data: shipment() } });
        if (url === '/cycles/c-1') return Promise.resolve({ data: { data: cycle() } });
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
  state.status = 'IN_TRANSIT';
  state.leg1Departed = null;
  state.gets = [];
  state.writes = [];
  state.answer = 'ok';
});
afterEach(() => cleanup());

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CycleDetailsPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The Shipping card's block for one leg, once the shipment has loaded into it. */
async function legBlock(legId: string) {
  await screen.findAllByTestId('shipping-card-leg');
  // Wait for the shipment too — the status line reads it.
  await waitFor(() => expect(state.gets).toContain('/cycles/c-1/shipment'));
  return document.querySelector(`[data-testid="shipping-card-leg"][data-leg-id="${legId}"]`) as HTMLElement;
}

const dialog = (kind: string) => document.querySelector(`[data-shipment-dialog="${kind}"]`) as HTMLElement | null;

describe('Shipping card: who sees Record departure and Record delivery', () => {
  it('a partner sees Record departure on a leg that has not left, and Record delivery on one that has goods on the way', async () => {
    wrap();
    const leg1 = await legBlock('leg-1');
    const leg2 = await legBlock('leg-2');
    await waitFor(() => expect(within(leg2).queryByTestId('leg-record-delivery')).toBeTruthy());
    expect(within(leg1).getByTestId('leg-record-departure')).toBeTruthy();
    // Not departed: no delivery can arrive from it (the server says LEG_NOT_DEPARTED).
    expect(within(leg1).queryByTestId('leg-record-delivery')).toBeNull();
    // Departed: no second departure offered.
    expect(within(leg2).queryByTestId('leg-record-departure')).toBeNull();
    // Buttons on a page with forms say what they are.
    for (const b of [within(leg1).getByTestId('leg-record-departure'), within(leg2).getByTestId('leg-record-delivery')]) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });

  it('a departed leg with nothing left on the way offers no delivery', async () => {
    state.leg1Departed = '2026-09-01';
    wrap();
    const leg1 = await legBlock('leg-1');
    await waitFor(() => expect(within(leg1).queryByTestId('leg-record-delivery')).toBeTruthy());
    expect(within(leg1).queryByTestId('leg-record-departure')).toBeNull();
  });

  it('an investor, an office role and an unknown role see neither — on the same open cycle', async () => {
    for (const role of ['TEMP_INVESTOR', 'ADMIN_SUPPORT', 'SOMETHING_NEW']) {
      state.role = role;
      state.gets = [];
      wrap();
      // The card's own leg block (not the old card's), so absence below means something.
      expect(await legBlock('leg-1')).toBeTruthy();
      // Give the shipment a render to land before asserting absence.
      await screen.findAllByTestId('shipping-card-status');
      expect(screen.queryByTestId('leg-record-departure'), role).toBeNull();
      expect(screen.queryByTestId('leg-record-delivery'), role).toBeNull();
      cleanup();
    }
  });

  it('a cycle being settled, closed or cancelled offers neither, even to a partner', async () => {
    for (const status of ['SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      state.status = status;
      state.gets = [];
      wrap();
      // The card's own leg block (not the old card's), so absence below means something.
      expect(await legBlock('leg-1')).toBeTruthy();
      await screen.findAllByTestId('shipping-card-status');
      expect(screen.queryByTestId('leg-record-departure'), status).toBeNull();
      expect(screen.queryByTestId('leg-record-delivery'), status).toBeNull();
      cleanup();
    }
  });
});

describe('Record departure from the details page', () => {
  it('sends the date to the leg and refetches the cycle and its shipment', async () => {
    wrap();
    const leg1 = await legBlock('leg-1');
    fireEvent.click(within(leg1).getByTestId('leg-record-departure'));
    const d = dialog('record-departure')!;
    expect(d).toBeTruthy();
    // Portalled: not inside the page's own tree.
    expect(leg1.contains(d)).toBe(false);
    expect(within(d).getByText(en.shipment.recordDepartureTitle.replace('{leg}', '1'))).toBeTruthy();

    const shipmentGets = state.gets.filter((u) => u === '/cycles/c-1/shipment').length;
    const cycleGets = state.gets.filter((u) => u === '/cycles/c-1').length;
    fireEvent.click(within(d).getByRole('button', { name: en.shipment.recordDeparture }));

    await waitFor(() => expect(dialog('record-departure')).toBeNull());
    expect(state.writes).toEqual([
      { method: 'put', url: '/shipping/legs/leg-1', body: { departedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } },
    ]);
    await waitFor(() => {
      expect(state.gets.filter((u) => u === '/cycles/c-1/shipment').length).toBeGreaterThan(shipmentGets);
      expect(state.gets.filter((u) => u === '/cycles/c-1').length).toBeGreaterThan(cycleGets);
    });
  });

  it('a refusal stays in the dialog; closing and reopening starts clean', async () => {
    state.answer = 'refuse';
    wrap();
    const leg1 = await legBlock('leg-1');
    fireEvent.click(within(leg1).getByTestId('leg-record-departure'));
    fireEvent.click(within(dialog('record-departure')!).getByRole('button', { name: en.shipment.recordDeparture }));
    await within(dialog('record-departure')!).findByTestId('shipment-refusal');

    fireEvent.click(within(dialog('record-departure')!).getByRole('button', { name: en.common.cancel }));
    expect(dialog('record-departure')).toBeNull();
    fireEvent.click(within(leg1).getByTestId('leg-record-departure'));
    expect(within(dialog('record-departure')!).queryByTestId('shipment-refusal')).toBeNull();
  });
});

describe('Record delivery from the details page', () => {
  it('opens the existing RecordDeliveryDialog for that leg, prefilled with what is on the way', async () => {
    wrap();
    const leg2 = await legBlock('leg-2');
    await waitFor(() => expect(within(leg2).queryByTestId('leg-record-delivery')).toBeTruthy());
    fireEvent.click(within(leg2).getByTestId('leg-record-delivery'));
    const d = dialog('record-delivery')!;
    expect(d).toBeTruthy();
    expect(within(d).getByText(en.shipment.recordDeliveryTitle.replace('{leg}', '2'))).toBeTruthy();
    expect((within(d).getByTestId('delivery-qty') as HTMLInputElement).value).toBe('40');

    fireEvent.click(within(d).getByRole('button', { name: en.shipment.recordDelivery }));
    await waitFor(() => expect(dialog('record-delivery')).toBeNull());
    expect(state.writes).toEqual([
      {
        method: 'post',
        url: '/shipping/legs/leg-2/deliveries',
        body: expect.objectContaining({ lines: [{ purchaseOrderItemId: 'poi-1', qty: 40 }] }),
      },
    ]);
  });
});

describe('every way out of a dialog clears it', () => {
  const ways: Array<[string, (d: HTMLElement) => void]> = [
    ['Cancel', (d) => fireEvent.click(within(d).getByRole('button', { name: en.common.cancel }))],
    ['the X', (d) => fireEvent.click(within(d).getByRole('button', { name: en.common.close }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['the scrim', (d) => fireEvent.click(d.firstElementChild!)],
  ];

  for (const [name, leave] of ways) {
    it(`${name}: closes, sends nothing, and the other leg's button opens the other dialog`, async () => {
      wrap();
      const leg1 = await legBlock('leg-1');
      const leg2 = await legBlock('leg-2');
      await waitFor(() => expect(within(leg2).queryByTestId('leg-record-delivery')).toBeTruthy());

      fireEvent.click(within(leg1).getByTestId('leg-record-departure'));
      leave(dialog('record-departure')!);
      expect(dialog('record-departure')).toBeNull();

      fireEvent.click(within(leg2).getByTestId('leg-record-delivery'));
      expect(dialog('record-departure')).toBeNull();
      const d = dialog('record-delivery')!;
      expect(within(d).getByText(en.shipment.recordDeliveryTitle.replace('{leg}', '2'))).toBeTruthy();
      leave(d);
      expect(dialog('record-delivery')).toBeNull();
      expect(state.writes).toEqual([]);
    });
  }
});
