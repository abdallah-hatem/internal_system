import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
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

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
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
    // The table hides below 640px and the cards above it. (The shared table,
    // components/ui/data-table.tsx, is its scroller inside its frame.)
    const frame = table.parentElement!.parentElement!;
    expect(frame.className).toContain('hidden');
    expect(frame.className).toContain('sm:block');
    expect(phoneCards[0].parentElement!.className).toContain('sm:hidden');
  });

  it('a phone lists the first three products, then "See more" shows the rest and "See less" folds them (owner 2026-10-23)', async () => {
    const names = ['Brake pad', 'Chain kit', 'Clutch plate', 'Helmet', 'Mirror'];
    const many = names.map((productName, i) => ({
      purchaseOrderItemId: `poi-${i}`, productId: `p-${i}`, productName, ordered: 10,
      received: 0, lost: 0, onTheWay: 0, waiting: 0, accounted: false,
    }));
    state.batches = [];
    state.shipment = {
      cycleId: 'c-1', code: 'CYC-1', status: 'IN_TRANSIT', accounted: false,
      totals: { ordered: 50, received: 0, lost: 0, onTheWay: 0, waiting: 0 }, lines: many,
      legs: [
        leg(1, false, '2026-09-01', many.map((l) => legLine(l.purchaseOrderItemId, { entered: 10, onTheWay: 10 }))),
        leg(2, true, null, many.map((l) => legLine(l.purchaseOrderItemId, { received: 0, waiting: 0 }))),
      ],
    };
    wrap();
    const section = await screen.findByTestId('goods-location');
    const shown = () => within(section).getAllByTestId('location-product-card').map((c) => c.dataset.product);
    expect(shown()).toEqual(names.slice(0, 3));
    const toggle = within(section).getByTestId('location-products-toggle');
    expect(toggle.textContent).toContain(en.goodsLocation.seeMore.replace('{count}', '2'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.className).toContain('sm:hidden');
    fireEvent.click(toggle);
    expect(shown()).toEqual(names);
    expect(toggle.textContent).toContain(en.goodsLocation.seeLess);
    fireEvent.click(toggle);
    expect(shown()).toEqual(names.slice(0, 3));
    // The desktop table always lists every product.
    expect(within(section).getAllByTestId('location-row')).toHaveLength(5);
  });

  it('three products or fewer: every card shows and there is no toggle', async () => {
    wrap();
    const section = await screen.findByTestId('goods-location');
    expect(within(section).getAllByTestId('location-product-card')).toHaveLength(2);
    expect(within(section).queryByTestId('location-products-toggle')).toBeNull();
  });

  it('nothing ordered: no cards at all', async () => {
    state.shipment = { cycleId: 'c-1', code: 'CYC-1', status: 'PLANNING', accounted: true, totals, lines: [], legs: [] };
    wrap();
    await screen.findByTestId('cycle-status');
    await screen.findByTestId('shipment-panel');
    expect(screen.queryByTestId('goods-location')).toBeNull();
  });

  // ─── Leg 2 in handovers (owner 2026-11-20: "fix wording") ─────────────────

  /**
   * CYC-2026-0002's shape: everything reached Ajman; leg 2 is in handovers,
   * so per product the position still reads every piece as waiting in the
   * UAE (a handover names no products). `handedOver` is the server's count
   * of what is with the forwarder.
   */
  const handoverShipment = (handedOver: { withForwarder: number; withForwarderUnknown: number; notLeft: number }) => ({
    cycleId: 'c-1', code: 'CYC-1', status: 'IN_TRANSIT_TO_EGYPT', accounted: false,
    totals: { ordered: 50, received: 0, lost: 0, atOrigin: 50, onTheWay: 0, waiting: 0 }, lines,
    handedOver: { ...handedOver, legs: [] },
    legs: [
      leg(1, false, '2026-09-01', [
        legLine('poi-pad', { entered: 40, delivered: 40 }),
        legLine('poi-chain', { entered: 10, delivered: 10 }),
      ]),
      {
        ...leg(2, true, '2026-11-20', [
          { ...legLine('poi-pad', { entered: 40, received: 0, waiting: 0 }), atOrigin: 40 },
          { ...legLine('poi-chain', { entered: 10, received: 0, waiting: 0 }), atOrigin: 10 },
        ]),
        atOrigin: 50,
        usesHandovers: true,
        // The leg card's own summary — the figures the totals and cards must agree with.
        handovers: {
          legId: 'leg-2', handovers: [], freightEgp: '59200.00', freightByCurrency: [{ currency: 'AED', amount: '4000.00' }],
          covered: 50, pieces: 50, legCostEgp: '59200.00', perPieceEgp: '1184.00', perPiece: null, final: false,
          stillInUae: handedOver.notLeft, withForwarder: handedOver.withForwarder,
          withForwarderUnknown: handedOver.withForwarderUnknown, arrived: 0,
        },
      },
    ],
  });

  /** The handover leg's product table, in the Shipment card. */
  const legHeaders = () => {
    const leg2 = screen.getAllByTestId('shipment-leg').find((l) => l.dataset.legSequence === '2')!;
    return within(leg2).getAllByRole('columnheader').map((h) => h.textContent);
  };

  const totalsLine = async () => (await screen.findByTestId('shipment-totals')).textContent;

  it('everything handed over with a count: the cards put it on the way to Egypt, not in the UAE, and the totals line says "with the forwarder", not "not left yet"', async () => {
    state.batches = [];
    state.shipment = handoverShipment({ withForwarder: 50, withForwarderUnknown: 0, notLeft: 0 });
    wrap();
    expect(await cards()).toMatchObject({ inChina: '0', toUae: '0', inUae: '0', toEgypt: '50', inEgypt: '0' });
    const line = await totalsLine();
    expect(line).toContain('50 with the forwarder');
    expect(line).not.toContain('not left yet');
    // No "0 on the way" beside them: nothing else is on the way.
    expect(line).not.toContain('on the way');
    // The leg card says the same, and its product table does not say "Not left".
    expect(screen.getByTestId('handovers-footer').textContent).toContain(`${en.handovers.withForwarder} 50`);
    expect(legHeaders()).toContain(en.shipment.atOriginOrForwarderCol);
    expect(legHeaders()).not.toContain(en.shipment.atOriginCol);
    // Per product nobody knows which are with the forwarder: the column says so, and a note explains.
    const section = screen.getByTestId('goods-location');
    const table = within(section).getByTestId('location-table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toContain(en.goodsLocation.inUaeOrForwarder);
    const pad = within(table).getAllByTestId('location-row').find((r) => r.dataset.product === 'Brake pad')!;
    expect(pad.querySelector('[data-place="inUae"]')!.textContent).toBe('40');
    expect(within(section).getByTestId('location-forwarder-note').textContent).toBe(
      en.goodsLocation.forwarderNote.replace('{count}', '50'),
    );
    // The phone's product cards use the same title.
    const phone = within(section).getAllByTestId('location-product-card')[0];
    expect(phone.textContent).toContain(en.goodsLocation.inUaeOrForwarder);
    expect(within(section).queryByTestId('location-forwarder-unknown')).toBeNull();
  });

  it('a handover with no count: nothing moves to Egypt, the card and the totals line say "not known", the rest is still not left', async () => {
    state.batches = [];
    state.shipment = handoverShipment({ withForwarder: 0, withForwarderUnknown: 1, notLeft: 50 });
    wrap();
    expect(await cards()).toMatchObject({ inUae: '50', toEgypt: '0' });
    const section = screen.getByTestId('goods-location');
    expect(within(section).getByTestId('location-forwarder-unknown').textContent).toBe(en.goodsLocation.toEgyptPlusUnknown);
    expect(within(section).getByTestId('location-forwarder-note').textContent).toBe(en.goodsLocation.forwarderNoteUnknown);
    const line = await totalsLine();
    expect(line).toContain('50 not left yet');
    expect(line).toContain(en.shipment.withForwarderNotKnown);
  });

  it('part handed over: 20 with the forwarder, 30 not left — the cards and the totals line agree', async () => {
    state.batches = [];
    state.shipment = handoverShipment({ withForwarder: 20, withForwarderUnknown: 0, notLeft: 30 });
    wrap();
    expect(await cards()).toMatchObject({ inUae: '30', toEgypt: '20' });
    const line = await totalsLine();
    expect(line).toContain('30 not left yet');
    expect(line).toContain('20 with the forwarder');
  });

  it('no handover leg: the titles and the totals line are as they were', async () => {
    wrap();
    const section = await screen.findByTestId('goods-location');
    const headers = within(within(section).getByTestId('location-table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain(en.goodsLocation.inUae);
    expect(headers).not.toContain(en.goodsLocation.inUaeOrForwarder);
    expect(within(section).queryByTestId('location-forwarder-note')).toBeNull();
    expect(screen.queryByTestId('totals-with-forwarder')).toBeNull();
  });

  it('in Arabic: «مع الشاحن» on the totals line and the column, the note in Arabic', async () => {
    state.batches = [];
    state.shipment = handoverShipment({ withForwarder: 50, withForwarderUnknown: 0, notLeft: 0 });
    wrap('ar');
    expect(await cards()).toMatchObject({ inUae: '0', toEgypt: '50' });
    const line = await totalsLine();
    expect(line).toContain('مع الشاحن');
    expect(line).not.toContain('لم تغادر بعد');
    expect(legHeaders()).toContain(ar.shipment.atOriginOrForwarderCol);
    const section = screen.getByTestId('goods-location');
    expect(within(within(section).getByTestId('location-table')).getAllByRole('columnheader').map((h) => h.textContent)).toContain(
      ar.goodsLocation.inUaeOrForwarder,
    );
    expect(within(section).getByTestId('location-forwarder-note').textContent).toContain('مع الشاحن');
  });
});
