import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { LegRoute } from './LegRoute';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';
import type { Shipment, ShipmentLoss } from './shipment-model';

/**
 * UF3 — the shipment screens read correctly in Arabic (UI audit #6, #11, #12,
 * #24, #25). Rendered under `dir="rtl"` with the Arabic messages, not English.
 */

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-partner', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const state = vi.hoisted(() => ({ shipment: null as unknown }));
vi.mock('@/lib/api', () => ({
  api: {
    post: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
    get: (url: string) =>
      Promise.resolve({ data: { data: url.endsWith('/shipment') ? state.shipment : [] } }),
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

function wrap(ui: ReactNode, locale: 'ar' | 'en' = 'ar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <QueryClientProvider client={client}>
          <ToastProvider>{ui}</ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>
    </div>,
  );
}

/** The route's parts in DOM order — the order a flex row lays out in either direction. */
function routeParts(route: HTMLElement) {
  return Array.from(route.children).map((el) => el.getAttribute('data-testid'));
}

describe('LegRoute', () => {
  it('puts origin, arrow, destination in that order, each name isolated, the arrow mirrored in RTL', () => {
    wrap(<LegRoute origin="Guangzhou, China" destination="Dubai, UAE" />);
    const route = screen.getByTestId('leg-route');
    expect(routeParts(route)).toEqual(['leg-route-origin', 'leg-route-arrow', 'leg-route-destination']);

    const origin = within(route).getByTestId('leg-route-origin');
    const destination = within(route).getByTestId('leg-route-destination');
    // <bdi>: a Latin "Dubai, UAE" keeps its own order inside an Arabic line.
    expect(origin.tagName).toBe('BDI');
    expect(destination.tagName).toBe('BDI');
    expect(origin.textContent).toBe('Guangzhou, China');
    expect(destination.textContent).toBe('Dubai, UAE');
    // The row follows the page direction, so in RTL the arrow has to turn to
    // keep pointing from the origin to the destination.
    expect(within(route).getByTestId('leg-route-arrow').getAttribute('class')).toContain('rtl:rotate-180');
  });

  it('a missing end shows a dash rather than an arrow pointing at nothing; no ends renders nothing', () => {
    wrap(
      <>
        <LegRoute origin="Dubai, UAE" destination="" />
        <LegRoute origin={null} destination={undefined} />
      </>,
    );
    const routes = screen.getAllByTestId('leg-route');
    expect(routes).toHaveLength(1);
    expect(within(routes[0]).getByTestId('leg-route-destination').textContent).toBe('—');
  });
});

const cycle: PanelCycle = {
  id: 'c-1',
  status: 'SELLING',
  originType: 'UAE_DIRECT',
  shippingLegs: [{ id: 'leg-1', providerId: 'prov-1', provider: 'Gulf Freight' }],
  purchaseOrders: [{ supplier: { id: 'sup-1', name: 'Dubai Parts' }, items: [{ id: 'poi-1' }] }],
};

function shipment(): Shipment {
  const loss: ShipmentLoss = {
    id: 'loss-1',
    legId: 'leg-1',
    purchaseOrderItemId: 'poi-1',
    qty: 5,
    costEgp: '550.00',
    createdAt: '2026-10-09T10:00:00Z',
    refundedEgp: '1234.50',
    unrecoveredEgp: '0.00',
    refunds: [
      {
        id: 'ref-1',
        amountEgp: '1234.50',
        currency: 'EGP',
        amount: '1234.50',
        recordedOn: '2026-10-09',
        payerType: 'SHIPPING_PROVIDER',
        payerName: 'Gulf Freight',
        reversedAt: null,
        reversalReason: null,
      },
    ],
  };
  return {
    cycleId: 'c-1',
    code: 'CYC-1',
    status: 'SELLING',
    accounted: false,
    totals: { ordered: 40, received: 35, lost: 5, onTheWay: 0, waiting: 0 },
    lines: [
      { purchaseOrderItemId: 'poi-1', productName: 'Brake pad, front', ordered: 40, received: 35, lost: 5, onTheWay: 0, waiting: 0, accounted: true },
    ],
    legs: [
      {
        legId: 'leg-1',
        sequence: 1,
        isLast: true,
        status: 'ARRIVED',
        arrivedOn: '2026-09-20',
        entered: 40,
        delivered: 35,
        lost: 5,
        onTheWay: 0,
        received: 35,
        waiting: 0,
        departedOn: '2026-09-01',
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 35, lost: 5, onTheWay: 0, received: 35, waiting: 0 }],
        deliveries: [
          { id: 'd-1', arrivedOn: '2026-09-20', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 35, received: 35 }] },
        ],
        losses: [loss],
      },
    ],
  } as Shipment;
}

describe('Shipment panel in Arabic', () => {
  it('the leg number and its route are separate, and the route reads origin to destination', async () => {
    state.shipment = shipment();
    wrap(<ShipmentPanel cycle={cycle} />);
    const leg = await screen.findByTestId('shipment-leg');
    const heading = within(leg).getByRole('heading', { level: 3 });
    const route = within(heading).getByTestId('leg-route');
    // "المرحلة 1" is its own item, not text run straight into "Dubai, UAE".
    expect(heading.firstElementChild?.textContent).toBe('المرحلة 1');
    expect(heading.firstElementChild).not.toBe(route);
    expect(within(route).getByTestId('leg-route-origin').textContent).toBe('Dubai, UAE');
    expect(within(route).getByTestId('leg-route-destination').textContent).toBe('Cairo, Egypt');
    expect(routeParts(route)).toEqual(['leg-route-origin', 'leg-route-arrow', 'leg-route-destination']);
  });

  /** The fixture's leg has arrived and its loss is paid back, so it starts folded: open it as a person would. */
  const openLeg = async () => fireEvent.click(await screen.findByTestId('leg-toggle'));

  it('a delivery lists each product as its own item with the Latin name isolated', async () => {
    state.shipment = shipment();
    wrap(<ShipmentPanel cycle={cycle} />);
    await openLeg();
    const summary = await screen.findByTestId('delivery-summary');
    const items = within(summary).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const name = items[0].querySelector('bdi');
    expect(name?.textContent).toBe('Brake pad, front');
    expect(items[0].textContent).toBe('Brake pad, front: 35 (استُلم 35)');
  });

  it('the refund line shows its amount through Money, never a hardcoded "ج.م"', async () => {
    state.shipment = shipment();
    wrap(<ShipmentPanel cycle={cycle} />);
    await openLeg();
    const line = await screen.findByTestId('loss-refund-line');
    expect(line.textContent).not.toContain('ج.م');
    // Money: an LTR-isolated run with grouping, two decimals and the currency.
    const money = line.querySelector('[dir="ltr"]');
    expect(money?.textContent).toBe('1,234.50 EGP');
    expect(line.querySelector('bdi')?.textContent).toBe('Gulf Freight');
    expect(line.textContent).toMatch(/^1,234\.50 EGP من Gulf Freight، استُلم في /);
  });

  it('the same line in English still reads as a sentence', async () => {
    state.shipment = shipment();
    wrap(<ShipmentPanel cycle={cycle} />, 'en');
    await openLeg();
    const line = await screen.findByTestId('loss-refund-line');
    expect(line.textContent).toMatch(/^1,234\.50 EGP from Gulf Freight, received /);
  });

  it('a delivery is never called a payment: the Arabic delivery wording does not use دفعة', () => {
    const deliveryKeys = Object.entries(ar.shipment).filter(([k]) => /deliver|Deliver|waitingHint|nothingWaitingHint|noLegsHint|receiveTitle/.test(k));
    expect(deliveryKeys.length).toBeGreaterThan(5);
    for (const [key, text] of deliveryKeys) expect(text, key).not.toMatch(/دفع/);
    expect(ar.shipments.arrivalsAreDeliveries).not.toMatch(/دفع/);
  });
});
