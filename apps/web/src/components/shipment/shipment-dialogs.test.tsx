import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { RecordDeliveryDialog } from './RecordDeliveryDialog';
import { ReceiveDeliveryDialog } from './ReceiveDeliveryDialog';
import { MarkLostDialog } from './MarkLostDialog';
import { RecordRefundDialog } from './RecordRefundDialog';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';
import type { Shipment, ShipmentLeg, ShipmentLoss } from './shipment-model';

// The panel's buttons follow the reader's role (R1b); these tests are a partner's.
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

// `call` records every request; `answer` decides the reply. Kept apart because
// a vi.fn returning a rejected promise chains its own copy nobody listens to.
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
      if (url.startsWith('/costing/')) {
        return Promise.resolve({
          data: { items: [{ purchaseOrderItemId: 'poi-1', landedUnitCostEgp: '110.0000' }] },
        });
      }
      if (url.endsWith('/shipment')) return Promise.resolve({ data: { data: state.shipment } });
      if (url.startsWith('/currency-rates')) return Promise.resolve({ data: { data: { USD: 50 } } });
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The app's English, plus the two refusal codes loss refunds (B5) add to `errors`. */
const messages = {
  ...en,
  errors: {
    ...en.errors,
    REFUND_EXCEEDS_LOSS: 'Only {unrecovered} of this loss is unrecovered, so {asked} cannot be refunded on it.',
    LOSS_REFUNDED: 'This loss has a refund recorded against it, so it cannot be taken back.',
  },
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (node: ReactNode) => (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  const view = render(tree(ui));
  return { ...view, rerender: (node: ReactNode) => view.rerender(tree(node)) };
}

const refusal = (code: string, params: Record<string, string | number>) =>
  Promise.reject({ response: { data: { error: { code, message: 'English fallback', params } } } });

const NAMES = { 'poi-1': 'Brake pad', 'poi-2': 'Chain kit' };

const leg = (over: Partial<ShipmentLeg> = {}): ShipmentLeg => ({
  legId: 'leg-1',
  sequence: 1,
  isLast: true,
  status: 'IN_TRANSIT',
  arrivedOn: null,
  entered: 60,
  delivered: 0,
  lost: 0,
  onTheWay: 60,
  received: 0,
  waiting: 0,
  departedOn: '2026-09-20',
  origin: 'Dubai, UAE',
  destination: 'Cairo, Egypt',
  lines: [
    { purchaseOrderItemId: 'poi-1', entered: 40, delivered: 0, lost: 0, onTheWay: 40, received: 0, waiting: 0 },
    { purchaseOrderItemId: 'poi-2', entered: 20, delivered: 0, lost: 0, onTheWay: 20, received: 0, waiting: 0 },
  ],
  deliveries: [],
  losses: [],
  ...over,
});

const qty = (testId: string, line: string) =>
  document.querySelector<HTMLInputElement>(`[data-testid="${testId}"][data-line="${line}"]`)!;
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const dialog = (name: string) => document.querySelector<HTMLElement>(`[data-shipment-dialog="${name}"]`)!;

describe('Record delivery', () => {
  it('prefills what is on the way; a typed value survives a refetch that changes the figures', () => {
    const onClose = vi.fn();
    const { rerender } = wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    expect(qty('delivery-qty', 'poi-1').value).toBe('40');
    expect(qty('delivery-qty', 'poi-2').value).toBe('20');

    type(qty('delivery-qty', 'poi-1'), '15');

    // The panel refetches: someone else recorded 5 of each meanwhile.
    rerender(
      <RecordDeliveryDialog
        leg={leg({
          lines: [
            { purchaseOrderItemId: 'poi-1', entered: 40, delivered: 5, lost: 0, onTheWay: 35, received: 0, waiting: 0 },
            { purchaseOrderItemId: 'poi-2', entered: 20, delivered: 5, lost: 0, onTheWay: 15, received: 0, waiting: 0 },
          ],
        })}
        productNames={NAMES}
        onClose={onClose}
      />,
    );
    expect(qty('delivery-qty', 'poi-1').value).toBe('15');
    // Untouched, so it follows the server.
    expect(qty('delivery-qty', 'poi-2').value).toBe('15');
  });

  it("the date is Cairo's today, not the browser's", () => {
    // 23:30 UTC on 15 Dec is 01:30 on the 16th in Cairo; the test machine is UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T23:30:00Z'));
    wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="arrivedOn"]')!.value).toBe('2026-12-16');
  });

  it('sends only the products with a quantity, to the leg', async () => {
    state.answer = () => Promise.resolve({ data: { data: { id: 'd-1' } } });
    const onClose = vi.fn();
    wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    type(qty('delivery-qty', 'poi-1'), '15');
    type(qty('delivery-qty', 'poi-2'), '');
    fireEvent.click(within(dialog('record-delivery')).getByRole('button', { name: 'Record delivery' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe('/shipping/legs/leg-1/deliveries');
    expect(call.mock.calls[0][2]).toMatchObject({ lines: [{ purchaseOrderItemId: 'poi-1', qty: 15 }] });
  });

  it('more than is on the way: the refusal in the reader’s words, the dialog open, every value kept', async () => {
    state.answer = () => refusal('DELIVERY_EXCEEDS_IN_TRANSIT', { line: 'Brake pad', onTheWay: 40, asked: 41 });
    const onClose = vi.fn();
    wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    type(qty('delivery-qty', 'poi-1'), '41');
    fireEvent.change(document.querySelector('#delivery-note')!, { target: { value: 'second truck' } });
    fireEvent.click(within(dialog('record-delivery')).getByRole('button', { name: 'Record delivery' }));

    const alert = await screen.findByTestId('shipment-refusal');
    expect(alert.textContent).toBe('Only 40 of Brake pad are on the way, so a delivery of 41 cannot be recorded.');
    expect(onClose).not.toHaveBeenCalled();
    expect(qty('delivery-qty', 'poi-1').value).toBe('41');
    expect(document.querySelector<HTMLTextAreaElement>('#delivery-note')!.value).toBe('second truck');
  });

  it('nothing entered is said, and nothing is sent', () => {
    wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    type(qty('delivery-qty', 'poi-1'), '0');
    type(qty('delivery-qty', 'poi-2'), '');
    fireEvent.click(within(dialog('record-delivery')).getByRole('button', { name: 'Record delivery' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByTestId('shipment-refusal').textContent).toBe(en.shipment.nothingEntered);
  });

  it('renders in <body>, outside any form it is opened from, and only its submit button submits', () => {
    const { container } = wrap(
      <form data-testid="outer">
        <RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={vi.fn()} />
      </form>,
    );
    expect(container.querySelector('[data-shipment-dialog]')).toBeNull();
    expect(dialog('record-delivery').closest('[data-testid="outer"]')).toBeNull();
    const submits = Array.from(dialog('record-delivery').querySelectorAll('button')).filter(
      (b) => b.getAttribute('type') !== 'button',
    );
    expect(submits.map((b) => b.textContent)).toEqual(['Record delivery']);
  });
});

describe('Receive into stock', () => {
  const lastLeg = leg({
    status: 'PARTLY_ARRIVED',
    delivered: 15,
    onTheWay: 45,
    lines: [
      { purchaseOrderItemId: 'poi-1', entered: 40, delivered: 15, lost: 0, onTheWay: 25, received: 0, waiting: 15 },
      { purchaseOrderItemId: 'poi-2', entered: 20, delivered: 0, lost: 0, onTheWay: 20, received: 0, waiting: 0 },
    ],
    deliveries: [
      { id: 'd-1', arrivedOn: '2026-10-08', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 15, received: 0 }] },
    ],
  });

  it('prefills what is waiting and shows the landed cost per unit from the costing endpoint', async () => {
    wrap(
      <ReceiveDeliveryDialog cycleId="c-1" leg={lastLeg} delivery={lastLeg.deliveries[0]} productNames={NAMES} onClose={vi.fn()} />,
    );
    expect(qty('receive-qty', 'dl-1').value).toBe('15');
    await waitFor(() => expect(screen.getByTestId('receive-unit-cost').textContent).toMatch(/110\.00/));
  });

  it('a double click sends one receipt', async () => {
    let release: (v: unknown) => void = () => {};
    state.answer = () => new Promise((r) => (release = r));
    const onClose = vi.fn();
    wrap(
      <ReceiveDeliveryDialog cycleId="c-1" leg={lastLeg} delivery={lastLeg.deliveries[0]} productNames={NAMES} onClose={onClose} />,
    );
    type(qty('receive-qty', 'dl-1'), '14');
    const button = within(dialog('receive-delivery')).getByRole('button', { name: 'Receive into stock' });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.closest('form')!);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual([
      'post',
      '/receipts/verify',
      { cycleId: 'c-1', deliveryId: 'd-1', items: [{ deliveryLineId: 'dl-1', receivedQty: 14 }] },
    ]);
    release({ data: { data: [] } });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('sends a cost override only when one is typed', async () => {
    state.answer = () => Promise.resolve({ data: { data: [] } });
    wrap(
      <ReceiveDeliveryDialog cycleId="c-1" leg={lastLeg} delivery={lastLeg.deliveries[0]} productNames={NAMES} onClose={vi.fn()} />,
    );
    type(document.querySelector<HTMLInputElement>('[data-testid="receive-cost-override"]')!, '120');
    fireEvent.click(within(dialog('receive-delivery')).getByRole('button', { name: 'Receive into stock' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0][2]).toMatchObject({ items: [{ deliveryLineId: 'dl-1', receivedQty: 15, landedUnitCostEgp: 120 }] });
  });

  it('a refusal stays in the dialog, translated, with the count kept', async () => {
    state.answer = () => refusal('RECEIVED_EXCEEDS_DELIVERED', { received: 16, product: 'Brake pad', available: 15 });
    const onClose = vi.fn();
    wrap(
      <ReceiveDeliveryDialog cycleId="c-1" leg={lastLeg} delivery={lastLeg.deliveries[0]} productNames={NAMES} onClose={onClose} />,
    );
    type(qty('receive-qty', 'dl-1'), '16');
    fireEvent.click(within(dialog('receive-delivery')).getByRole('button', { name: 'Receive into stock' }));
    expect((await screen.findByTestId('shipment-refusal')).textContent).toBe(
      '16 of Brake pad cannot be received: only 15 are waiting to be received from this delivery.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(qty('receive-qty', 'dl-1').value).toBe('16');
  });
});

describe('Mark lost (rule 11: whose figure is shown)', () => {
  async function toConfirmStep(lines: Record<string, string>) {
    for (const [line, value] of Object.entries(lines)) type(qty('lost-qty', line), value);
    fireEvent.click(within(dialog('mark-lost')).getByRole('button', { name: en.shipment.continue }));
    return within(dialog('mark-lost')).findByTestId('loss-estimate');
  }

  /** The confirm button arrives disabled and arms itself; click it then. */
  async function confirmWhenArmed() {
    const confirm = within(dialog('mark-lost')).getByRole('button', { name: en.shipment.confirmLoss });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
  }

  it('the confirm step shows an estimate from the server’s landed unit cost, labelled as one', async () => {
    wrap(<MarkLostDialog cycleId="c-1" leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    const estimate = await toConfirmStep({ 'poi-1': '5' });
    await waitFor(() => expect(estimate.textContent).toMatch(/550\.00 EGP/));
    expect(estimate.textContent).toMatch(/Estimated loss/);
  });

  it('once booked, it shows the amount the server booked — not the estimate', async () => {
    // The residual on the line's last units: 550.00 estimated, 549.97 booked.
    state.answer = () => Promise.resolve({ data: { data: [{ id: 'l-1', costEgp: '549.97' }] } });
    wrap(<MarkLostDialog cycleId="c-1" leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    await toConfirmStep({ 'poi-1': '5' });
    // A deliberate second click, once the confirm button has armed itself.
    await confirmWhenArmed();

    const booked = await within(dialog('mark-lost')).findByTestId('loss-booked');
    expect(booked.textContent).toMatch(/549\.97 EGP/);
    expect(booked.textContent).not.toMatch(/550\.00/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe('/shipping/legs/leg-1/losses');
    expect(call.mock.calls[0][2]).toEqual({ lines: [{ purchaseOrderItemId: 'poi-1', qty: 5 }] });
  });

  it('a double click on Continue does not book the loss with its second click', async () => {
    wrap(<MarkLostDialog cycleId="c-1" leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    type(qty('lost-qty', 'poi-1'), '5');
    const continueButton = within(dialog('mark-lost')).getByRole('button', { name: en.shipment.continue });
    fireEvent.click(continueButton);
    // The second click of the pair lands on the button now in its place, which
    // is disabled until it arms — visibly, not by silently dropping the click.
    const confirm = within(dialog('mark-lost')).getByRole('button', { name: en.shipment.confirmLoss });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(call).not.toHaveBeenCalled();
  });

  it('more than is still to come: translated refusal, still on the confirm step, quantities kept on going back', async () => {
    state.answer = () => refusal('LOSS_EXCEEDS_IN_TRANSIT', { line: 'Brake pad', onTheWay: 40, asked: 41 });
    wrap(<MarkLostDialog cycleId="c-1" leg={leg()} productNames={NAMES} onClose={vi.fn()} />);
    await toConfirmStep({ 'poi-1': '41' });
    await confirmWhenArmed();
    expect((await screen.findByTestId('shipment-refusal')).textContent).toBe(
      'Only 40 of Brake pad are still to come, so 41 cannot be marked lost.',
    );
    fireEvent.click(within(dialog('mark-lost')).getByRole('button', { name: en.shipment.back }));
    expect(qty('lost-qty', 'poi-1').value).toBe('41');
  });
});

describe('Record refund on a loss', () => {
  const loss: ShipmentLoss = {
    id: 'loss-1',
    legId: 'leg-1',
    purchaseOrderItemId: 'poi-1',
    qty: 5,
    costEgp: '550.00',
    createdAt: '2026-10-09T10:00:00Z',
    refundedEgp: '200.00',
    unrecoveredEgp: '350.00',
    refunds: [],
  };
  const payers = [
    { type: 'SHIPPING_PROVIDER' as const, id: 'prov-1', name: 'Gulf Freight' },
    { type: 'SUPPLIER' as const, id: 'sup-1', name: 'Dubai Parts' },
  ];

  it('shows the loss, refunded so far and what is unrecovered, as the server states them', () => {
    wrap(<RecordRefundDialog loss={loss} productName="Brake pad" payers={payers} onClose={vi.fn()} />);
    const summary = screen.getByTestId('refund-summary').textContent!;
    expect(summary).toMatch(/Loss\s*550\.00 EGP/);
    expect(summary).toMatch(/Refunded so far\s*200\.00 EGP/);
    expect(summary).toMatch(/Unrecovered\s*350\.00 EGP/);
  });

  it('before refunds exist on the server, nothing reads as refunded', () => {
    const bare = { ...loss, refundedEgp: undefined, unrecoveredEgp: undefined, refunds: undefined };
    wrap(<RecordRefundDialog loss={bare} productName="Brake pad" payers={payers} onClose={vi.fn()} />);
    expect(screen.getByTestId('refund-summary').textContent).toMatch(/Unrecovered\s*550\.00 EGP/);
  });

  it('too much: REFUND_EXCEEDS_LOSS translated, the dialog open, its values kept', async () => {
    state.answer = () => refusal('REFUND_EXCEEDS_LOSS', { unrecovered: '350.00', asked: '400.00' });
    const onClose = vi.fn();
    wrap(<RecordRefundDialog loss={loss} productName="Brake pad" payers={payers.slice(0, 1)} onClose={onClose} />);
    const amount = document.querySelector<HTMLInputElement>('#refund-amount')!;
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '400' } });
    fireEvent.blur(amount);
    fireEvent.change(document.querySelector('#refund-reason')!, { target: { value: 'claim' } });
    fireEvent.click(within(dialog('record-refund')).getByRole('button', { name: en.shipment.recordRefund }));

    expect((await screen.findByTestId('shipment-refusal')).textContent).toBe(
      'Only 350.00 of this loss is unrecovered, so 400.00 cannot be refunded on it.',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(amount.value).toBe('400');
    expect(document.querySelector<HTMLTextAreaElement>('#refund-reason')!.value).toBe('claim');
    expect(call.mock.calls[0][1]).toBe('/shipping/losses/loss-1/refunds');
    expect(call.mock.calls[0][2]).toMatchObject({
      amount: 400,
      currency: 'EGP',
      fxRateToEgp: 1,
      payer: { type: 'SHIPPING_PROVIDER', id: 'prov-1' },
      reason: 'claim',
    });
  });

  it('with two possible payers, nobody is chosen for the reader', () => {
    wrap(<RecordRefundDialog loss={loss} productName="Brake pad" payers={payers} onClose={vi.fn()} />);
    const amount = document.querySelector<HTMLInputElement>('#refund-amount')!;
    fireEvent.change(amount, { target: { value: '100' } });
    fireEvent.click(within(dialog('record-refund')).getByRole('button', { name: en.shipment.recordRefund }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByTestId('shipment-refusal').textContent).toBe(en.shipment.payerRequired);
  });
});

describe('Shipment panel: losses', () => {
  const cycle: PanelCycle = {
    id: 'c-1',
    status: 'SELLING',
    originType: 'UAE_DIRECT',
    shippingLegs: [{ id: 'leg-1', providerId: 'prov-1', provider: 'Gulf Freight' }],
    purchaseOrders: [{ supplier: { id: 'sup-1', name: 'Dubai Parts' }, items: [{ id: 'poi-1' }, { id: 'poi-2' }] }],
  };
  const lossBase: ShipmentLoss = {
    id: 'loss-1',
    legId: 'leg-1',
    purchaseOrderItemId: 'poi-1',
    qty: 5,
    costEgp: '550.00',
    createdAt: '2026-10-09T10:00:00Z',
  };
  const withLoss = (loss: ShipmentLoss): Shipment => ({
    cycleId: 'c-1',
    code: 'CYC-1',
    status: 'SELLING',
    accounted: false,
    totals: { ordered: 60, received: 14, lost: 5, onTheWay: 40, waiting: 1 },
    lines: [
      { purchaseOrderItemId: 'poi-1', productName: 'Brake pad', ordered: 40, received: 14, lost: 5, onTheWay: 20, waiting: 1, accounted: false },
      { purchaseOrderItemId: 'poi-2', productName: 'Chain kit', ordered: 20, received: 0, lost: 0, onTheWay: 20, waiting: 0, accounted: false },
    ],
    legs: [leg({ status: 'PARTLY_ARRIVED', losses: [loss] })],
  });

  it('an unrefunded loss can be taken back', async () => {
    state.shipment = withLoss(lossBase);
    wrap(<ShipmentPanel cycle={cycle} />);
    expect(await screen.findByTestId('take-back-loss')).toBeTruthy();
  });

  it('a refunded loss offers no take-back', async () => {
    state.shipment = withLoss({ ...lossBase, refundedEgp: '100.00', unrecoveredEgp: '450.00', refunds: [] });
    wrap(<ShipmentPanel cycle={cycle} />);
    await screen.findByTestId('shipment-loss');
    expect(screen.queryByTestId('take-back-loss')).toBeNull();
    expect(screen.getByTestId('record-refund')).toBeTruthy();
  });

  it('a take-back the server refuses (LOSS_REFUNDED, refunded meanwhile) is said in the reader’s words', async () => {
    state.shipment = withLoss(lossBase);
    state.answer = () => refusal('LOSS_REFUNDED', {});
    wrap(<ShipmentPanel cycle={cycle} />);
    fireEvent.click(await screen.findByTestId('take-back-loss'));
    fireEvent.click(within(dialog('take-back-loss')).getByRole('button', { name: en.shipment.takeBack }));
    expect((await screen.findByTestId('shipment-refusal')).textContent).toBe(messages.errors.LOSS_REFUNDED);
    expect(call).toHaveBeenCalledWith('delete', '/shipping/losses/loss-1');
  });

  it('the refund payers are the leg’s provider and the order’s supplier', async () => {
    state.shipment = withLoss(lossBase);
    wrap(<ShipmentPanel cycle={cycle} />);
    fireEvent.click(await screen.findByTestId('record-refund'));
    const amount = document.querySelector<HTMLInputElement>('#refund-amount')!;
    fireEvent.change(amount, { target: { value: '100' } });
    // Two payers: one must be chosen. Choosing is covered above; here the options.
    fireEvent.click(within(dialog('record-refund')).getAllByRole('combobox')[0]);
    // The provider is also named in the leg's header now (I3); look in the picker.
    expect(await screen.findByRole('option', { name: /Gulf Freight/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Dubai Parts/ })).toBeTruthy();
  });
});

// L3 (§1, 2026-10-11): the record moves the cycle on by itself, and the
// success toast says where it now stands.
describe('the status a record moved the cycle to', () => {
  const move = (over: Record<string, unknown> = {}) => ({
    cycleId: 'c-1',
    from: 'IN_TRANSIT_TO_EGYPT',
    to: 'ARRIVED_EGYPT',
    moved: true,
    steps: ['ARRIVED_EGYPT'],
    stoppedAt: null,
    ordersConfirmed: [],
    ...over,
  });
  const submitDelivery = async () => {
    const onClose = vi.fn();
    wrap(<RecordDeliveryDialog leg={leg()} productNames={NAMES} onClose={onClose} />);
    type(qty('delivery-qty', 'poi-1'), '15');
    type(qty('delivery-qty', 'poi-2'), '');
    fireEvent.click(within(dialog('record-delivery')).getByRole('button', { name: 'Record delivery' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  };

  it('a delivery that moved the cycle: "Delivery recorded — cycle is now Arrived Egypt"', async () => {
    state.answer = () => Promise.resolve({ data: { data: { id: 'd-1' }, cycleStatus: move() } });
    await submitDelivery();
    expect(await screen.findByText('Delivery recorded — cycle is now Arrived Egypt')).toBeTruthy();
  });

  it('a delivery that did not move it says only that it was recorded', async () => {
    state.answer = () =>
      Promise.resolve({ data: { data: { id: 'd-1' }, cycleStatus: move({ from: 'ARRIVED_EGYPT', moved: false, steps: [] }) } });
    await submitDelivery();
    expect(await screen.findByText('Delivery recorded')).toBeTruthy();
    expect(screen.queryByText(/cycle is now/)).toBeNull();
  });

  it('a step that refused: the record saved, and a warning names where the cycle stayed and why', async () => {
    state.answer = () =>
      Promise.resolve({
        data: {
          data: { id: 'd-1' },
          cycleStatus: move({
            from: 'PLANNING',
            to: 'PURCHASING',
            steps: ['FUNDING', 'PURCHASING'],
            stoppedAt: {
              status: 'ARRIVED_UAE',
              code: 'PO_HAS_NO_ITEMS',
              message: 'English fallback',
              params: { reference: 'PO-2026-0009' },
            },
          }),
        },
      });
    await submitDelivery();
    expect(await screen.findByText('Delivery recorded — cycle is now Purchasing')).toBeTruthy();
    const warning = await screen.findByText(/^The cycle stayed Purchasing: /);
    expect(warning.textContent).toContain('This purchase order has no items.');
    expect(warning.textContent).not.toContain('English fallback');
  });
});
