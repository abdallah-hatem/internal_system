import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { ShipmentPanel, type PanelCycle } from '@/components/shipment/ShipmentPanel';
import type { Shipment } from '@/components/shipment/shipment-model';
import SettlementsPage from '@/components/views/settlements-view';
import CycleDetailsPage from '@/app/[locale]/cycles/[cycleId]/details/page';
import { accountFundingFixture } from '@/components/cycles/funding-card.fixture';

/**
 * R1b — a temporary investor reads their cycle, its shipment and its
 * settlement, and is offered no button the server would refuse. Both
 * directions: the same screens still offer every action to a core partner, so
 * a guard that hid everything from everyone would fail here too (rule 12).
 * e2e: apps/web/tests/89-investor-readonly.spec.ts.
 */

const state = vi.hoisted(() => ({
  role: 'TEMP_INVESTOR' as string,
  shipment: null as unknown,
  gets: [] as string[],
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ cycleId: 'c-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // The Settlements tab keeps its chosen cycle in the address (2026-10-20).
  usePathname: () => '/en/partners',
  useSearchParams: () => new URLSearchParams('view=settlements'),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const cycleRecord = {
  id: 'c-1',
  code: 'CYC-1',
  status: 'SELLING',
  originType: 'UAE_DIRECT',
  currency: 'AED',
  participants: [
    { id: 'p-1', participantType: 'CORE_PARTNER', contributionAmount: '500', partner: { email: 'a@x.z' } },
  ],
  purchaseOrders: [{ id: 'po-1', supplier: { id: 'sup-1', name: 'Dubai Parts' }, items: [{ id: 'poi-1' }] }],
  shippingLegs: [{ id: 'leg-1', providerId: 'prov-1', provider: 'Gulf Freight' }],
  inventoryBatches: [],
};

const settlements = [
  { id: 's-draft', status: 'DRAFT', cycle: { id: 'c-1', code: 'CYC-1', status: 'SETTLEMENT' }, lines: [] },
  { id: 's-approved', status: 'APPROVED', cycle: { id: 'c-2', code: 'CYC-2', status: 'SETTLEMENT' }, lines: [] },
];

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      state.gets.push(url);
      if (url.endsWith('/shipment')) return Promise.resolve({ data: { data: state.shipment } });
      if (url === '/cycles/c-1') return Promise.resolve({ data: { data: cycleRecord } });
      if (url === '/cycles/c-1/account-funding') {
        return Promise.resolve({
          data: { data: accountFundingFixture({ participants: cycleRecord.participants, status: 'SELLING', toFund: 1000 }) },
        });
      }
      if (url.startsWith('/costing/')) return Promise.resolve({ data: { totals: { landedEgp: 1000 } } });
      if (url === '/settlements') return Promise.resolve({ data: { data: settlements } });
      if (url === '/users') return Promise.reject({ response: { status: 403 } });
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
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  state.gets = [];
  state.shipment = everyActionShipment();
});
afterEach(() => cleanup());

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/**
 * A shipment in which every panel action applies at once: a last leg still
 * carrying units (record delivery, mark lost), a delivery with units waiting
 * (receive, delete), a loss with a refund standing (record refund, undo) and a
 * loss with none (take back).
 */
function everyActionShipment(status = 'SELLING', legStatus = 'PARTLY_ARRIVED'): Shipment {
  const refund = {
    id: 'ref-1', amountEgp: '200.00', currency: 'EGP', amount: '200.00', recordedOn: '2026-10-09',
    payerType: 'SHIPPING_PROVIDER', payerName: 'Gulf Freight', reversedAt: null, reversalReason: null,
  };
  return {
    cycleId: 'c-1',
    code: 'CYC-1',
    status,
    accounted: false,
    totals: { ordered: 40, received: 20, lost: 5, onTheWay: 5, waiting: 10 },
    lines: [{ purchaseOrderItemId: 'poi-1', productName: 'Brake pad', ordered: 40, received: 20, lost: 5, onTheWay: 5, waiting: 10, accounted: false }],
    legs: [
      {
        legId: 'leg-1', sequence: 1, isLast: true, status: legStatus, arrivedOn: null,
        entered: 40, delivered: 30, lost: 5, onTheWay: 5, received: 20, waiting: 10,
        departedOn: '2026-09-01', origin: 'Dubai', destination: 'Cairo',
        lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 30, lost: 5, onTheWay: 5, received: 20, waiting: 10 }],
        deliveries: [{ id: 'd-1', arrivedOn: '2026-09-20', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 30, received: 20 }] }],
        losses: [
          { id: 'loss-1', legId: 'leg-1', purchaseOrderItemId: 'poi-1', qty: 3, costEgp: '330.00', createdAt: '2026-10-01T10:00:00Z', refundedEgp: '200.00', unrecoveredEgp: '130.00', refunds: [refund] },
          { id: 'loss-2', legId: 'leg-1', purchaseOrderItemId: 'poi-1', qty: 2, costEgp: '220.00', createdAt: '2026-10-02T10:00:00Z', refundedEgp: '0', unrecoveredEgp: '220.00', refunds: [] },
        ],
      },
    ],
  } as unknown as Shipment;
}

const cycle: PanelCycle = cycleRecord;
const PANEL_ACTIONS = ['record-delivery', 'mark-lost', 'receive-delivery', 'delete-delivery', 'record-refund', 'undo-refund', 'take-back-loss'];

describe('Shipment panel', () => {
  it('an investor reads every figure, delivery and loss, and is offered no action', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<ShipmentPanel cycle={cycle} />);
    await screen.findAllByTestId('shipment-delivery');
    expect(screen.getAllByTestId('shipment-loss')).toHaveLength(2);
    expect(screen.getAllByTestId('loss-refund')).toHaveLength(1);
    for (const id of PANEL_ACTIONS) expect(screen.queryAllByTestId(id), id).toHaveLength(0);
  });

  it('a core partner, on the same shipment, is offered every one of them', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<ShipmentPanel cycle={cycle} />);
    await screen.findAllByTestId('shipment-delivery');
    for (const id of PANEL_ACTIONS) expect(screen.queryAllByTestId(id).length, id).toBeGreaterThan(0);
  });

  it('"Move to Arrived Egypt" is a partner\'s: shown to them, not to an investor', async () => {
    state.shipment = everyActionShipment('IN_TRANSIT_TO_EGYPT', 'PARTLY_ARRIVED');
    const transit = { ...cycle, status: 'IN_TRANSIT_TO_EGYPT' };

    state.role = 'CORE_PARTNER';
    wrap(<ShipmentPanel cycle={transit} />);
    expect(await screen.findByTestId('walk-to-egypt')).toBeTruthy();
    cleanup();

    state.role = 'TEMP_INVESTOR';
    wrap(<ShipmentPanel cycle={transit} />);
    await screen.findByTestId('shipment-panel');
    expect(screen.queryByTestId('walk-to-egypt')).toBeNull();
  });

  it('a role still unknown (or one never heard of) is offered nothing', async () => {
    state.role = 'SOMETHING_NEW';
    wrap(<ShipmentPanel cycle={cycle} />);
    await screen.findAllByTestId('shipment-delivery');
    for (const id of PANEL_ACTIONS) expect(screen.queryAllByTestId(id), id).toHaveLength(0);
  });
});

describe('Settlements page', () => {
  const buttons = () => ({
    calculate: screen.queryByRole('button', { name: en.settlementsPage.calculate }),
    approve: screen.queryByRole('button', { name: en.settlementsPage.approve }),
    pay: screen.queryByRole('button', { name: en.settlementsPage.markPaid }),
    reverse: screen.queryAllByRole('button', { name: en.settlementsPage.reverse }),
  });

  it('an investor sees their settlements and no calculate, approve, pay or reverse — and the cycle picker is not fetched', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<SettlementsPage />);
    await screen.findByText('CYC-2');
    const b = buttons();
    expect(b.calculate).toBeNull();
    expect(b.approve).toBeNull();
    expect(b.pay).toBeNull();
    expect(b.reverse).toHaveLength(0);
    expect(state.gets).not.toContain('/cycles');
  });

  it('a core partner sees all four', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<SettlementsPage />);
    await screen.findByText('CYC-2');
    const b = buttons();
    expect(b.calculate).not.toBeNull();
    expect(b.approve).not.toBeNull();
    expect(b.pay).not.toBeNull();
    expect(b.reverse).toHaveLength(2);
    expect(state.gets).toContain('/cycles');
  });
});

describe('Cycle details page', () => {
  it('an investor never asks for /users and is offered no participant action', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<CycleDetailsPage />);
    await screen.findByText('CYC-1');
    await screen.findAllByTestId('shipment-delivery');
    expect(state.gets).not.toContain('/users');
    expect(screen.queryByRole('button', { name: en.fundingCard.addInvestor })).toBeNull();
    expect(screen.queryByRole('button', { name: en.cycles.splitEqually })).toBeNull();
  });

  it('a core partner is offered both, and the people list loads when Add investor opens', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<CycleDetailsPage />);
    await screen.findByText('CYC-1');
    const add = await screen.findByRole('button', { name: en.fundingCard.addInvestor });
    expect(await screen.findByRole('button', { name: en.cycles.splitEqually })).toBeTruthy();
    expect(state.gets).not.toContain('/users');
    fireEvent.click(add);
    await waitFor(() => expect(state.gets).toContain('/users'));
  });
});
