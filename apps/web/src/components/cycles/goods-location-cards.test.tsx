import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import CycleDetailsPage from '@/app/[locale]/cycles/[cycleId]/details/page';

/**
 * I3 item 3 — the where-the-goods-are cards at the top of cycle details, as
 * the page renders them from the shipment and the cycle's batches. The
 * arithmetic is pinned in goods-location.test.ts; this pins what shows.
 */

const state = vi.hoisted(() => ({
  originType: 'CHINA' as string,
  shipment: null as unknown,
  batches: [] as unknown[],
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'TEMP_INVESTOR' }, isLoading: false }),
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
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/shipment') return Promise.resolve({ data: { data: state.shipment } });
      if (url === '/cycles/c-1') {
        return Promise.resolve({
          data: {
            data: {
              id: 'c-1', code: 'CYC-1', status: 'SELLING', originType: state.originType, currency: 'USD',
              participants: [], purchaseOrders: [], shippingLegs: [], inventoryBatches: state.batches,
            },
          },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    },
    post: () => new Promise(() => {}),
    put: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const legLine = (poi: string, o: Partial<Record<'entered' | 'delivered' | 'lost' | 'onTheWay', number>> & { received?: number | null; waiting?: number | null }) => ({
  purchaseOrderItemId: poi, entered: 0, delivered: 0, lost: 0, onTheWay: 0, received: null, waiting: null, ...o,
});
const leg = (sequence: number, isLast: boolean, departedOn: string | null, lines: unknown[]) => ({
  legId: `leg-${sequence}`, sequence, isLast, status: departedOn ? 'IN_TRANSIT' : 'PENDING', arrivedOn: null,
  entered: 0, delivered: 0, lost: 0, onTheWay: 0, received: null, waiting: null, departedOn, lines, deliveries: [],
});
const lines = [
  { purchaseOrderItemId: 'poi-pad', productId: 'p-pad', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, onTheWay: 0, waiting: 0, accounted: false },
  { purchaseOrderItemId: 'poi-chain', productId: 'p-chain', productName: 'Chain kit', ordered: 10, received: 0, lost: 0, onTheWay: 0, waiting: 0, accounted: false },
];
const totals = { ordered: 50, received: 0, lost: 0, onTheWay: 0, waiting: 0 };

/**
 * China: pads — 10 still on the way to the UAE, 30 reached Dubai and left;
 * 20 of those reached Egypt, 15 checked in (6 sold), 5 waiting. Chains — leg 1
 * left with all 10, none arrived yet: 10 on the way to the UAE.
 */
const chinaShipment = (lost = 0) => ({
  cycleId: 'c-1', code: 'CYC-1', status: 'SELLING', accounted: false, totals, lines,
  legs: [
    leg(1, false, '2026-09-01', [
      legLine('poi-pad', { entered: 40, delivered: 30, onTheWay: 10 - lost, lost }),
      legLine('poi-chain', { entered: 10, onTheWay: 10 }),
    ]),
    leg(2, true, '2026-09-10', [
      legLine('poi-pad', { entered: 30, delivered: 20, onTheWay: 10, received: 15, waiting: 5 }),
      legLine('poi-chain', { received: 0, waiting: 0 }),
    ]),
  ],
});

beforeEach(() => {
  state.originType = 'CHINA';
  state.shipment = chinaShipment();
  state.batches = [{ id: 'b-1', productId: 'p-pad', receivedQty: '15', remainingQty: '9', product: { name: 'Brake pad' } }];
});

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

const cards = async () => {
  const section = await screen.findByTestId('goods-location');
  return Object.fromEntries(
    within(section)
      .getAllByTestId('location-card')
      .map((c) => [c.dataset.place, within(c).getByTestId('location-value').textContent]),
  );
};

describe('where the goods are, at the top of cycle details', () => {
  it('a China cycle shows every place in travel order with the cycle totals; no Lost card when nothing was lost', async () => {
    wrap();
    expect(await cards()).toEqual({
      inChina: '0', toUae: '20', inUae: '0', toEgypt: '10', inEgypt: '14', sold: '6',
    });
    const section = screen.getByTestId('goods-location');
    expect(within(section).getAllByTestId('location-card').map((c) => c.dataset.place)).toEqual([
      'inChina', 'toUae', 'inUae', 'toEgypt', 'inEgypt', 'sold',
    ]);
    // The goods waiting to be checked in are named under In Egypt.
    expect(within(section).getByTestId('location-not-checked-in').textContent).toBe('5 not checked in yet');
    // It sits above the page's other figures.
    const profit = screen.getByTestId('cycle-profit-card');
    expect(section.compareDocumentPosition(profit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a Lost card appears only once something is lost', async () => {
    state.shipment = chinaShipment(4);
    wrap();
    const c = await cards();
    expect(c.lost).toBe('4');
    expect(c.toUae).toBe('16');
  });

  it('a UAE-direct cycle shows no China and no To-UAE cards', async () => {
    state.originType = 'UAE_DIRECT';
    state.shipment = {
      cycleId: 'c-1', code: 'CYC-1', status: 'IN_TRANSIT', accounted: false, totals, lines,
      legs: [leg(1, true, null, [
        legLine('poi-pad', { entered: 40, onTheWay: 40, received: 0, waiting: 0 }),
        legLine('poi-chain', { entered: 10, onTheWay: 10, received: 0, waiting: 0 }),
      ])],
    };
    state.batches = [];
    wrap();
    expect(await cards()).toEqual({ inUae: '50', toEgypt: '0', inEgypt: '0', sold: '0' });
  });

  it('the product table has the same places plus Ordered; each product is also a card for a phone', async () => {
    wrap();
    const section = await screen.findByTestId('goods-location');
    const table = within(section).getByTestId('location-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      en.goodsLocation.product, en.goodsLocation.ordered, en.goodsLocation.inChina, en.goodsLocation.toUae,
      en.goodsLocation.inUae, en.goodsLocation.toEgypt, en.goodsLocation.inEgypt, en.goodsLocation.sold,
    ]);
    const pad = within(table).getAllByTestId('location-row').find((r) => r.dataset.product === 'Brake pad')!;
    const cell = (row: HTMLElement, place: string) => row.querySelector(`[data-place="${place}"]`)!.textContent;
    expect(cell(pad, 'ordered')).toBe('40');
    expect(cell(pad, 'toUae')).toBe('10');
    expect(cell(pad, 'sold')).toBe('6');

    const phoneCards = within(section).getAllByTestId('location-product-card');
    expect(phoneCards.map((c) => c.dataset.product)).toEqual(['Brake pad', 'Chain kit']);
    // The table hides below 640px and the cards above it.
    expect(table.parentElement!.className).toContain('hidden');
    expect(table.parentElement!.className).toContain('sm:block');
    expect(phoneCards[0].parentElement!.className).toContain('sm:hidden');
  });

  it('nothing ordered: no cards at all', async () => {
    state.shipment = { cycleId: 'c-1', code: 'CYC-1', status: 'PLANNING', accounted: true, totals, lines: [], legs: [] };
    wrap();
    await screen.findByTestId('cycle-status');
    await screen.findByTestId('shipment-panel');
    expect(screen.queryByTestId('goods-location')).toBeNull();
  });
});
