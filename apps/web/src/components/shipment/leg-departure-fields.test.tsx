import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import ShipmentsPage from '@/components/views/shipments-view';

/**
 * L8 — the Shipments page's leg forms record a leg's first departure the way
 * Record departure does: a day, and per product what left, each starting at
 * everything waiting (BUSINESS_LOGIC §1, 2026-10-12). Later departures, and
 * undoing one, are on the cycle page.
 */

const state = vi.hoisted(() => ({
  legDeparted: false,
  writes: [] as Array<{ method: string; url: string; body?: unknown }>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/en/shipments',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const legRow = () => ({
  id: 'leg-1', cycleId: 'c-1', cycle: { code: 'CYC-1' }, sequence: 1, origin: 'Guangzhou', destination: 'Dubai',
  provider: 'Gulf Freight', providerId: 'prov-1', status: state.legDeparted ? 'IN_TRANSIT' : 'PENDING',
  departedOn: state.legDeparted ? '2026-09-02' : null, costBasis: 'FLAT', amount: 100, currency: 'EGP', fxRateToEgp: 1,
});

const shipment = () => ({
  cycleId: 'c-1', code: 'CYC-1', status: 'PURCHASING', accounted: false,
  totals: { ordered: 50, received: 0, lost: 0, atOrigin: 50, onTheWay: 0, waiting: 0 },
  lines: [
    { purchaseOrderItemId: 'poi-1', productId: 'p1', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, atOrigin: 40, onTheWay: 0, waiting: 0, accounted: false },
    { purchaseOrderItemId: 'poi-2', productId: 'p2', productName: 'Chain kit', ordered: 10, received: 0, lost: 0, atOrigin: 10, onTheWay: 0, waiting: 0, accounted: false },
  ],
  legs: [
    {
      legId: 'leg-1', sequence: 1, isLast: true, status: state.legDeparted ? 'IN_TRANSIT' : 'PENDING', arrivedOn: null,
      entered: 50, departed: state.legDeparted ? 50 : 0, atOrigin: state.legDeparted ? 0 : 50, delivered: 0, lost: 0,
      onTheWay: state.legDeparted ? 50 : 0, received: 0, waiting: 0,
      lines: [
        { purchaseOrderItemId: 'poi-1', entered: 40, departed: 0, atOrigin: state.legDeparted ? 0 : 40, delivered: 0, lost: 0, onTheWay: 0, received: 0, waiting: 0 },
        { purchaseOrderItemId: 'poi-2', entered: 10, departed: 0, atOrigin: state.legDeparted ? 0 : 10, delivered: 0, lost: 0, onTheWay: 0, received: 0, waiting: 0 },
      ],
      departures: state.legDeparted ? [{ id: 'dep-1', departedOn: '2026-09-02', lines: [], undoable: true }] : [],
      deliveries: [],
    },
  ],
  // A leg added after leg 1 would find nothing yet (leg 1 delivered nothing);
  // the create form below is for a cycle with no legs, see `noLegs`.
  nextLeg: [
    { purchaseOrderItemId: 'poi-1', waiting: 40 },
    { purchaseOrderItemId: 'poi-2', waiting: 10 },
  ],
});

vi.mock('@/lib/api', () => {
  const write = (method: string) => (url: string, body?: unknown) => {
    state.writes.push({ method, url, body });
    return Promise.resolve({ data: { data: {}, cycleStatus: null } });
  };
  return {
    api: {
      get: (url: string) => {
        if (url === '/shipping/legs') return Promise.resolve({ data: { data: [legRow()] } });
        if (url === '/cycles') return Promise.resolve({ data: { data: [{ id: 'c-1', code: 'CYC-1', status: 'PURCHASING', originType: 'UAE_DIRECT' }] } });
        if (url === '/providers') return Promise.resolve({ data: { data: [{ id: 'prov-1', name: 'Gulf Freight' }] } });
        if (url === '/cycles/c-1/shipment') return Promise.resolve({ data: { data: shipment() } });
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
  state.legDeparted = false;
  state.writes = [];
});
afterEach(() => cleanup());

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ShipmentsPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const fields = () => screen.getByTestId('leg-departure-fields');
const qty = (line: string) => document.querySelector<HTMLInputElement>(`[data-testid="departure-qty"][data-line="${line}"]`);
const pickToday = () => {
  fireEvent.click(within(fields()).getByRole('button', { name: en.common.pickDate }));
  fireEvent.click(screen.getByTestId('date-picker-today'));
};

describe('the create form', () => {
  it('with a cycle and a day: one row per product, each starting at what a new leg would find waiting', async () => {
    wrap();
    fireEvent.click((await screen.findAllByTestId('create-action'))[0]);
    // No cycle yet: it says to choose one, and offers no quantities.
    expect(within(fields()).getByText(en.shipments.departurePickCycle)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: /CYC-1/ }));
    pickToday();
    await waitFor(() => expect(qty('poi-1')).toBeTruthy());
    expect(qty('poi-1')!.value).toBe('40');
    expect(qty('poi-2')!.value).toBe('10');
  });

  it('closing the form and opening it again starts clean — nothing typed survives', async () => {
    wrap();
    fireEvent.click((await screen.findAllByTestId('create-action'))[0]);
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: /CYC-1/ }));
    pickToday();
    await waitFor(() => expect(qty('poi-1')).toBeTruthy());
    fireEvent.change(qty('poi-1')!, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));

    fireEvent.click((await screen.findAllByTestId('create-action'))[0]);
    expect(qty('poi-1')).toBeNull();
    expect(within(fields()).getByText(en.shipments.departurePickCycle)).toBeTruthy();
  });
});

describe('the edit form', () => {
  it('a leg that has not left: picking a day offers the products, starting at what waits; Save sends what was typed', async () => {
    wrap();
    fireEvent.click((await screen.findAllByTestId('edit-action'))[0]);
    pickToday();
    await waitFor(() => expect(qty('poi-1')).toBeTruthy());
    expect(qty('poi-1')!.value).toBe('40');
    fireEvent.change(qty('poi-1')!, { target: { value: '25' } });
    fireEvent.change(qty('poi-2')!, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({
      method: 'put',
      url: '/shipping/legs/leg-1',
      body: expect.objectContaining({
        departedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        departureLines: [{ purchaseOrderItemId: 'poi-1', qty: 25 }],
      }),
    });
  });

  it('a leg that has left: its date shows, no quantities, a pointer to the cycle page — and Save sends no lines', async () => {
    state.legDeparted = true;
    wrap();
    fireEvent.click((await screen.findAllByTestId('edit-action'))[0]);
    await waitFor(() => expect(within(fields()).getByText(en.shipments.departuresOnCyclePage, { exact: false })).toBeTruthy());
    expect(qty('poi-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect((state.writes[0].body as { departureLines?: unknown }).departureLines).toBeUndefined();
    expect((state.writes[0].body as { departedOn?: unknown }).departedOn).toBe('2026-09-02');
  });
});
