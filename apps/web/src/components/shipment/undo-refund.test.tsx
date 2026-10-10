import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';
import type { Shipment, ShipmentLoss, ShipmentLossRefund } from './shipment-model';

/**
 * B5b — "Undo refund" on a loss in the Shipment panel, reached by clicking
 * (CLAUDE.md §2). e2e: apps/web/tests/88-undo-refund.spec.ts.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const call = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  answer: (() => new Promise(() => {})) as (method: string, url: string, body?: unknown) => Promise<unknown>,
  shipment: null as unknown,
}));
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      call('post', url, body);
      return state.answer('post', url, body);
    },
    delete: (url: string) => {
      call('delete', url);
      return state.answer('delete', url);
    },
    get: (url: string) => {
      if (url.endsWith('/shipment')) return Promise.resolve({ data: { data: state.shipment } });
      return Promise.resolve({ data: { data: [] } });
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
  call.mockReset();
  state.answer = () => new Promise(() => {});
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

const refusal = (code: string, params: Record<string, string | number>) =>
  Promise.reject({ response: { data: { error: { code, message: 'English fallback', params } } } });
const dialog = (name: string) => document.querySelector<HTMLElement>(`[data-shipment-dialog="${name}"]`)!;

const cycle: PanelCycle = {
  id: 'c-1',
  status: 'SELLING',
  originType: 'UAE_DIRECT',
  shippingLegs: [{ id: 'leg-1', providerId: 'prov-1', provider: 'Gulf Freight' }],
  purchaseOrders: [{ supplier: { id: 'sup-1', name: 'Dubai Parts' }, items: [{ id: 'poi-1' }] }],
};

const standing: ShipmentLossRefund = {
  id: 'ref-1',
  amountEgp: '200.00',
  currency: 'EGP',
  amount: '200.00',
  recordedOn: '2026-10-09',
  payerType: 'SHIPPING_PROVIDER',
  payerName: 'Gulf Freight',
  reversedAt: null,
  reversalReason: null,
};

function shipmentWith(loss: Partial<ShipmentLoss>): Shipment {
  const full: ShipmentLoss = {
    id: 'loss-1',
    legId: 'leg-1',
    purchaseOrderItemId: 'poi-1',
    qty: 5,
    costEgp: '550.00',
    createdAt: '2026-10-09T10:00:00Z',
    refundedEgp: '200.00',
    unrecoveredEgp: '350.00',
    refunds: [standing],
    ...loss,
  };
  return {
    cycleId: 'c-1',
    code: 'CYC-1',
    status: 'SELLING',
    accounted: false,
    totals: { ordered: 40, received: 35, lost: 5, onTheWay: 0, waiting: 0 },
    lines: [
      { purchaseOrderItemId: 'poi-1', productName: 'Brake pad', ordered: 40, received: 35, lost: 5, onTheWay: 0, waiting: 0, accounted: true },
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
        deliveries: [],
        losses: [full],
      },
    ],
  } as Shipment;
}

async function openUndo() {
  const button = await screen.findByTestId('undo-refund');
  expect(button.getAttribute('type')).toBe('button');
  fireEvent.click(button);
  return dialog('undo-refund');
}
const confirmButton = () => within(dialog('undo-refund')).getByRole('button', { name: en.shipment.undoRefund });
const reasonBox = () => document.querySelector<HTMLTextAreaElement>('#undo-refund-reason')!;

describe('Undo refund', () => {
  it('a reason is required: an empty or blank one sends nothing and says so', async () => {
    state.shipment = shipmentWith({});
    wrap(<ShipmentPanel cycle={cycle} />);
    const d = await openUndo();
    expect(d.textContent).toContain('200.00 EGP from Gulf Freight goes back to them');

    fireEvent.click(confirmButton());
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByTestId('shipment-refusal').textContent).toBe(en.shipment.undoRefundReasonRequired);

    fireEvent.change(reasonBox(), { target: { value: '   ' } });
    fireEvent.click(confirmButton());
    expect(call).not.toHaveBeenCalled();
  });

  it('a double click on the confirm sends one request, with the reason trimmed', async () => {
    state.shipment = shipmentWith({});
    wrap(<ShipmentPanel cycle={cycle} />);
    await openUndo();
    fireEvent.change(reasonBox(), { target: { value: '  The goods turned up ' } });
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('post', '/purchases/refunds/ref-1/reverse', { reason: 'The goods turned up' });
  });

  it('the form submitted twice before the button disables (Enter pressed twice) still sends one request', async () => {
    state.shipment = shipmentWith({});
    wrap(<ShipmentPanel cycle={cycle} />);
    await openUndo();
    fireEvent.change(reasonBox(), { target: { value: 'turned up' } });
    // A disabled button stops a second click; it does not stop the form being
    // submitted again from the keyboard. Only the in-flight guard does.
    const form = dialog('undo-refund').querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a refusal (already undone) is said in the reader’s words; the dialog stays open with the reason', async () => {
    state.shipment = shipmentWith({});
    state.answer = () => refusal('ENTRY_ALREADY_REVERSED', { date: '2026-10-10' });
    wrap(<ShipmentPanel cycle={cycle} />);
    await openUndo();
    fireEvent.change(reasonBox(), { target: { value: 'turned up' } });
    fireEvent.click(confirmButton());
    expect((await screen.findByTestId('shipment-refusal')).textContent).toBe(
      en.errors.ENTRY_ALREADY_REVERSED.replace('{date}', '2026-10-10'),
    );
    expect(dialog('undo-refund')).toBeTruthy();
    expect(reasonBox().value).toBe('turned up');
  });

  it('an undone refund is listed as undone, with no undo; once every refund is undone the loss can be taken back', async () => {
    state.shipment = shipmentWith({
      refundedEgp: '0.00',
      unrecoveredEgp: '550.00',
      refunds: [{ ...standing, reversedAt: '2026-10-10T08:00:00Z', reversalReason: 'turned up' }],
    });
    wrap(<ShipmentPanel cycle={cycle} />);
    const row = await screen.findByTestId('loss-refund');
    expect(row.getAttribute('data-reversed')).toBe('true');
    expect(row.textContent).toContain(en.shipment.refundUndoneBadge);
    expect(row.textContent).toContain('turned up');
    expect(screen.queryByTestId('undo-refund')).toBeNull();
    expect(screen.getByTestId('take-back-loss')).toBeTruthy();
  });

  it('a loss with a refund still standing offers no take-back', async () => {
    state.shipment = shipmentWith({});
    wrap(<ShipmentPanel cycle={cycle} />);
    await screen.findByTestId('undo-refund');
    expect(screen.queryByTestId('take-back-loss')).toBeNull();
  });
});
