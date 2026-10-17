import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';
import { legCounts, legNeedsAttention, shipmentProgress, type Shipment, type ShipmentLeg } from './shipment-model';

/**
 * The cycle page's Shipment card, made compact (owner 2026-10-17: "the
 * shipment card design is not easy on the eye"). A finished leg is one line —
 * route, status, dates, provider and what it cost — and opens on request; a
 * leg still asking for something opens by itself; a count nobody has is not a
 * column; a leg that cost nothing says the bill has not come.
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
    get: (url: string) => Promise.resolve({ data: { data: url.endsWith('/shipment') ? state.shipment : [] } }),
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

function wrap(ui: ReactNode, locale: 'ar' | 'en' = 'en') {
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

const line = (over: Partial<ShipmentLeg['lines'][number]> = {}) => ({
  purchaseOrderItemId: 'poi-1', entered: 70, atOrigin: 0, delivered: 70, lost: 0, onTheWay: 0, received: 70, waiting: 0, ...over,
});

function leg(over: Partial<ShipmentLeg> = {}): ShipmentLeg {
  return {
    legId: 'leg-2', sequence: 2, isLast: true, status: 'ARRIVED', arrivedOn: '2026-09-09',
    entered: 70, atOrigin: 0, delivered: 70, lost: 0, onTheWay: 0, received: 70, waiting: 0,
    departedOn: '2026-08-28', origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    lines: [line()],
    departures: [{ id: 'dep-1', departedOn: '2026-08-28', undoable: false, lines: [{ purchaseOrderItemId: 'poi-1', qty: 70 }] }],
    deliveries: [{ id: 'd-1', arrivedOn: '2026-09-09', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 70, received: 70 }] }],
    losses: [],
    ...over,
  } as ShipmentLeg;
}

function shipment(legs: ShipmentLeg[], totals: Partial<Shipment['totals']> = {}): Shipment {
  return {
    cycleId: 'c-1', code: 'CYC-1', status: 'SELLING', accounted: true,
    totals: { ordered: 70, received: 70, lost: 0, atOrigin: 0, onTheWay: 0, waiting: 0, ...totals },
    lines: [{ purchaseOrderItemId: 'poi-1', productName: 'Y30 Headset', ordered: 70, received: 70, lost: 0, onTheWay: 0, waiting: 0, accounted: true }],
    legs,
  } as Shipment;
}

const cycle = (legs: PanelCycle['shippingLegs']): PanelCycle => ({
  id: 'c-1', status: 'SELLING', originType: 'CHINA', shippingLegs: legs,
  purchaseOrders: [{ supplier: { id: 's-1', name: 'Yixi' }, items: [{ id: 'poi-1' }] }],
});

const block = async () => screen.findByTestId('shipment-leg');
const toggle = (el: HTMLElement) => within(el).getByTestId('leg-toggle');

describe('a finished leg is one line', () => {
  it('folded at first: no table, no departures, no deliveries — and the toggle says so', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '23000' }])} />);
    const el = await block();
    expect(within(el).queryByTestId('leg-details')).toBeNull();
    expect(within(el).queryByTestId('shipment-line')).toBeNull();
    expect(within(el).queryByTestId('shipment-delivery')).toBeNull();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(toggle(el).getAttribute('aria-label')).toBe(en.shipment.showDetails);
    // The line itself still carries the route, the status and the cost.
    expect(within(el).getByTestId('leg-route').textContent).toContain('Cairo, Egypt');
    expect(within(el).getByTestId('leg-status').textContent).toBe(en.codes.legStatus.ARRIVED);
    expect(within(el).getByTestId('leg-cost').textContent).toContain('23,000.00');
  });

  it('opens on the toggle, folds again on the second press', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '23000' }])} />);
    const el = await block();
    fireEvent.click(toggle(el));
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(el).getAttribute('aria-controls')).toBe(within(el).getByTestId('leg-details').id);
    expect(within(el).getAllByTestId('shipment-line').length).toBeGreaterThan(0);
    expect(within(el).getAllByTestId('shipment-delivery')).toHaveLength(1);
    fireEvent.click(toggle(el));
    expect(within(el).queryByTestId('leg-details')).toBeNull();
  });
});

describe('a leg still asking for something opens by itself', () => {
  it.each([
    ['on the way', leg({ status: 'IN_TRANSIT', onTheWay: 70, delivered: 0, received: 0, lines: [line({ onTheWay: 70, delivered: 0, received: 0 })], deliveries: [] })],
    ['waiting to be received', leg({ waiting: 70, received: 0, lines: [line({ waiting: 70, received: 0 })] })],
    ['goods still at the origin', leg({ status: 'PARTLY_ARRIVED', atOrigin: 10, lines: [line({ atOrigin: 10 })] })],
  ])('%s', async (_, l) => {
    state.shipment = shipment([l]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '100' }])} />);
    const el = await block();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    expect(within(el).getByTestId('leg-details')).toBeTruthy();
  });
});

describe('the cost is where the eye lands', () => {
  it('a leg that cost nothing says the bill has not come, with 0 under it', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '0', amount: '0', currency: 'EGP' }])} />);
    const el = await block();
    expect(within(el).getByTestId('leg-no-cost').textContent).toBe(en.shipment.noCostYet);
    expect(within(el).getByTestId('leg-cost').textContent).toContain('0.00');
  });

  it('a leg paid in dirhams shows the dirhams first and the pounds under them', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '21491.60', amount: '1551.74', currency: 'AED' }])} />);
    const cost = within(await block()).getByTestId('leg-cost');
    const [first, second] = Array.from(cost.querySelectorAll('p')).map((p) => p.textContent ?? '');
    expect(first).toContain('1,551.74');
    expect(first).toContain('AED');
    expect(second).toContain('21,491.60');
    expect(within(cost).queryByTestId('leg-no-cost')).toBeNull();
  });

  it('the card totals what shipping cost across every leg', async () => {
    state.shipment = shipment([leg({ legId: 'leg-1', sequence: 1, isLast: false }), leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-1', amountEgp: '21491.60' }, { id: 'leg-2', amountEgp: '2300' }])} />);
    expect((await screen.findByTestId('shipping-total')).textContent).toContain('23,791.60');
  });
});

describe('one summary line, only what is not settled', () => {
  it('says how much is in stock and leaves out counts nobody has', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const totals = await screen.findByTestId('shipment-totals');
    expect(totals.textContent).toContain('70 of 70 in stock');
    expect(totals.textContent).not.toContain('not left');
    expect(totals.textContent).not.toContain('waiting to be received');
  });

  it('names goods waiting to be received and goods not left when there are some', async () => {
    state.shipment = shipment([leg({ waiting: 20, lines: [line({ waiting: 20 })] })], { received: 50, waiting: 20, atOrigin: 3 });
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const totals = await screen.findByTestId('shipment-totals');
    expect(totals.textContent).toContain('20 waiting to be received');
    expect(totals.textContent).toContain('3 not left yet');
  });

  it('reads in Arabic', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '0' }])} />, 'ar');
    expect((await screen.findByTestId('shipment-totals')).textContent).toContain('من 70 في المخزون');
    expect(screen.getByTestId('leg-no-cost').textContent).toBe('لا تكلفة بعد');
  });
});

describe('a column nobody has is not shown', () => {
  it('an arrived last leg shows ordered, delivered and received — no zeros for waiting, lost, on the way, not left', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const el = await block();
    fireEvent.click(toggle(el));
    const row = within(el).getAllByTestId('shipment-line')[0];
    for (const id of ['line-ordered', 'line-delivered', 'line-received']) expect(within(row).getByTestId(id)).toBeTruthy();
    for (const id of ['line-waiting', 'line-lost', 'line-on-the-way', 'line-at-origin']) expect(within(row).queryByTestId(id), id).toBeNull();
  });

  it('a loss brings its column back', async () => {
    state.shipment = shipment([leg({ lost: 2, lines: [line({ lost: 2, delivered: 68, received: 68 })] })]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const el = await block();
    fireEvent.click(toggle(el));
    expect(within(within(el).getAllByTestId('shipment-line')[0]).getByTestId('line-lost').textContent).toBe('2');
  });
});

describe('the rules, on their own', () => {
  it('legNeedsAttention', () => {
    expect(legNeedsAttention(leg())).toBe(false);
    expect(legNeedsAttention(leg({ status: 'IN_TRANSIT' }))).toBe(true);
    expect(legNeedsAttention(leg({ onTheWay: 1 }))).toBe(true);
    expect(legNeedsAttention(leg({ atOrigin: 1 }))).toBe(true);
    expect(legNeedsAttention(leg({ lines: [line({ waiting: 1 })] }))).toBe(true);
    // Waiting only means "to be received" on the last leg.
    expect(legNeedsAttention(leg({ isLast: false, lines: [line({ waiting: 1 })] }))).toBe(false);
    const loss = { id: 'l', legId: 'leg-2', purchaseOrderItemId: 'poi-1', qty: 1, costEgp: '100', createdAt: '2026-09-09', refundedEgp: '0', unrecoveredEgp: '100', refunds: [] };
    expect(legNeedsAttention(leg({ losses: [loss] }))).toBe(true);
    expect(legNeedsAttention(leg({ losses: [{ ...loss, refundedEgp: '100', unrecoveredEgp: '0' }] }))).toBe(false);
  });

  it('legCounts', () => {
    expect(legCounts(leg())).toEqual(['ordered', 'delivered', 'received']);
    expect(legCounts(leg({ isLast: false }))).toEqual(['ordered', 'delivered']);
    expect(legCounts(leg({ lines: [line({ waiting: 1, lost: 1, onTheWay: 1, atOrigin: 1 })] }))).toEqual([
      'ordered', 'atOrigin', 'delivered', 'received', 'waiting', 'lost', 'onTheWay',
    ]);
  });

  it('shipmentProgress', () => {
    expect(shipmentProgress({ ordered: 0, received: 0, lost: 0, onTheWay: 0, waiting: 0 })).toBe(0);
    expect(shipmentProgress({ ordered: 230, received: 115, lost: 0, onTheWay: 115, waiting: 0 })).toBe(50);
    expect(shipmentProgress({ ordered: 100, received: 95, lost: 5, onTheWay: 0, waiting: 0 })).toBe(100);
    expect(shipmentProgress({ ordered: 10, received: 12, lost: 0, onTheWay: 0, waiting: 0 })).toBe(100);
  });
});

describe('the status sits on the title line, coloured by what happened (owner 2026-10-17)', () => {
  it.each([
    ['ARRIVED', 'text-success'],
    ['IN_TRANSIT', 'text-primary'],
    ['PARTLY_ARRIVED', 'text-accent-600'],
    ['PENDING', 'text-muted-foreground'],
  ])('%s → %s, as a dot and a word, no pill', async (status, tone) => {
    state.shipment = shipment([leg({ status })]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const el = await block();
    const mark = within(el).getByTestId('leg-status');
    expect(mark.textContent).toBe(en.codes.legStatus[status as keyof typeof en.codes.legStatus]);
    const wrapper = mark.parentElement!;
    expect(wrapper.className).toContain(tone);
    expect(wrapper.className).not.toMatch(/rounded-full|bg-muted/);
    expect(wrapper.querySelector('[aria-hidden="true"]')?.className).toContain('rounded-full');
  });

  it('beside the heading, not in the dates line under it', async () => {
    state.shipment = shipment([leg()]);
    wrap(<ShipmentPanel cycle={cycle([{ id: 'leg-2', amountEgp: '1' }])} />);
    const el = await block();
    const heading = within(el).getByRole('heading', { level: 3 });
    const mark = within(el).getByTestId('leg-status');
    expect(heading.parentElement!.contains(mark)).toBe(true);
    expect(mark.closest('p')).toBeNull();
  });
});
