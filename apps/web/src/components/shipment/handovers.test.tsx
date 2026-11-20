import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import {
  HandoverSection,
  HandOverDialog,
  RecordArrivalDialog,
  AllArrivedDialog,
  HandoverLegCost,
  handoverLegStatus,
  FreightPaymentDialog,
} from './Handovers';
import type { FreightPayer, FreightPayment, Handover, LegHandovers, ShipmentLeg } from './shipment-model';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §18 — owner 2026-11-20, mockup A):
 * the card shows each lot with its arrivals and what is still out, and the two
 * forms send exactly what the API reads. Every figure comes from the server's
 * summary; these tests pin that the screen says it, in both languages.
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

const call = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  answer: (() => Promise.resolve({ data: { data: {} } })) as (m: string, u: string, b?: unknown) => Promise<unknown>,
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
      if (url.startsWith('/currency-rates')) return Promise.resolve({ data: { data: { AED: 15.2, USD: 50 } } });
      if (url === '/providers') return Promise.resolve({ data: { data: [{ id: 'prov-1', name: 'Gulf Freight' }] } });
      if (url === '/partner-accounts')
        return Promise.resolve({ data: { data: [{ partnerUserId: 'u-shady', name: 'Shady', active: true }] } });
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
  state.answer = () => Promise.resolve({ data: { data: {} } });
});
afterEach(() => cleanup());

function wrap(ui: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const NAMES = { 'poi-a': 'SU8 headset', 'poi-b': 'Y50 headset' };

/** Who can be named as paying, as the shipment sends it: partners and the cycle's investor. */
const PAYERS: FreightPayer[] = [
  { id: 'u-shady', name: 'Shady', kind: 'PARTNER' },
  { id: 'u-youssef', name: 'Mohammed Youssef', kind: 'INVESTOR' },
];

const payment = (over: Partial<FreightPayment>): FreightPayment => ({
  id: 'p-1',
  paidOn: '2026-11-18',
  amount: '6000.00',
  rateToEgp: '15.0000',
  amountEgp: '90000.00',
  paidByUserId: 'u-shady',
  note: null,
  paidBy: { id: 'u-shady', name: 'Shady', kind: 'PARTNER' },
  owed: { financingId: 'f-1', currency: 'AED', owed: '6000.00' },
  ...over,
});

const handover = (over: Partial<Handover>): Handover => ({
  id: 'h-1',
  number: 1,
  handedOverOn: '2026-11-18',
  pieces: 150,
  freightAmount: '6000.00',
  freightCurrency: 'AED',
  freightRateToEgp: '15.0000',
  freightAmountEgp: '90000.00',
  freightPaid: '6000.00',
  freightPaidEgp: '90000.00',
  freightToPay: '0.00',
  freightToPayEgp: '0.00',
  payments: [payment({})],
  providerId: 'prov-1',
  provider: 'Gulf Freight',
  arrived: 110,
  lost: 0,
  covered: 150,
  toCome: 40,
  allArrivedOn: null,
  open: true,
  arrivals: [
    { id: 'a-1', arrivedOn: '2026-11-24', lines: [{ purchaseOrderItemId: 'poi-a', qty: 30 }, { purchaseOrderItemId: 'poi-b', qty: 30 }], total: 60 },
    { id: 'a-2', arrivedOn: '2026-12-02', lines: [{ purchaseOrderItemId: 'poi-a', qty: 50 }], total: 50 },
  ],
  lossIds: [],
  ...over,
});

/** The owner's example: 150 (Shady paid), and a second lot with no count. */
const SUMMARY: LegHandovers = {
  legId: 'leg-2',
  handovers: [
    handover({}),
    handover({
      id: 'h-2',
      number: 2,
      handedOverOn: '2026-11-25',
      pieces: null,
      freightAmount: '4200.00',
      freightAmountEgp: '63000.00',
      freightPaid: '4200.00',
      freightPaidEgp: '63000.00',
      payments: [payment({ id: 'p-2', amount: '4200.00', amountEgp: '63000.00', paidByUserId: null, paidBy: null, owed: null })],
      arrived: 40,
      covered: 40,
      toCome: null,
      arrivals: [{ id: 'a-3', arrivedOn: '2026-12-03', lines: [{ purchaseOrderItemId: 'poi-b', qty: 40 }], total: 40 }],
    }),
  ],
  freightEgp: '153000.00',
  freightByCurrency: [{ currency: 'AED', amount: '10200.00' }],
  paidByCurrency: [{ currency: 'AED', amount: '10200.00' }],
  toPayByCurrency: [],
  covered: 190,
  pieces: 400,
  legCostEgp: '322105.26',
  perPieceEgp: '805.26',
  perPiece: { amount: '53.68', currency: 'AED' },
  final: false,
  stillInUae: 210,
  withForwarder: 40,
  withForwarderUnknown: 1,
  arrived: 150,
};

const leg = (over: Partial<ShipmentLeg> = {}): ShipmentLeg => ({
  legId: 'leg-2',
  sequence: 2,
  isLast: true,
  status: 'PARTLY_ARRIVED',
  arrivedOn: null,
  entered: 400,
  atOrigin: 250,
  delivered: 150,
  lost: 0,
  onTheWay: 0,
  received: 0,
  waiting: 150,
  origin: 'Ajman, UAE',
  destination: 'Cairo, Egypt',
  lines: [
    { purchaseOrderItemId: 'poi-a', entered: 250, atOrigin: 170, delivered: 80, lost: 0, onTheWay: 0, received: 0, waiting: 80 },
    { purchaseOrderItemId: 'poi-b', entered: 150, atOrigin: 80, delivered: 70, lost: 0, onTheWay: 0, received: 0, waiting: 70 },
  ],
  deliveries: [],
  usesHandovers: true,
  handovers: SUMMARY,
  ...over,
});

const refusal = (code: string, params: Record<string, string | number>) =>
  Promise.reject({ response: { data: { error: { code, message: 'English fallback', params } } } });

describe('the handover card', () => {
  it("shows the owner's example as mockup A: the estimate pill, each lot with its facts, progress and arrivals, and the footer", () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg()} productNames={NAMES} frozen={false} />);
    const pill = screen.getByTestId('freight-pill');
    expect(pill.textContent).toMatch(/53\.68/);
    expect(pill.textContent).toMatch(/AED/);
    expect(pill.textContent).toMatch(/estimate/);
    expect(pill.dataset.final).toBe('false');
    const [one, two] = screen.getAllByTestId('handover');
    expect(within(one).getByTestId('handover-facts').textContent).toMatch(/150 pieces.*6,000\.00.*Gulf Freight/);
    expect(within(one).getByTestId('freight-payment-who').textContent).toMatch(/^Paid .* · by Shady$/);
    expect(within(two).getByTestId('freight-payment-who').textContent).toMatch(/by the business$/);
    expect(within(one).getByTestId('handover-progress').textContent).toBe('110 of 150 arrived');
    expect(within(one).getByRole('progressbar')).toBeTruthy();
    expect(within(one).getAllByTestId('handover-arrival')).toHaveLength(2);
    expect(within(one).getByTestId('handover-owed').textContent).toMatch(/Owed to Shady: .*6,000\.00/);
    expect(within(two).getByTestId('handover-facts').textContent).toMatch(/pieces not known/);
    expect(within(two).getByTestId('handover-progress').textContent).toBe('40 arrived so far');
    // No count, no bar: there is nothing to measure progress against.
    expect(within(two).queryByRole('progressbar')).toBeNull();
    // A lot with arrivals cannot be undone; only its arrivals can.
    expect(within(one).queryByTestId('undo-handover')).toBeNull();
    expect(screen.getByTestId('handovers-footer').textContent).toBe(
      'Still in the UAE 210with the forwarder 40 + not knownarrived 150',
    );
    expect(screen.getByTestId('hand-over')).toBeTruthy();
  });

  it('a closed lot says All arrived, offers Undo All arrived and no more arrivals; a final freight says final', () => {
    const closed = { ...SUMMARY, final: true, handovers: [handover({ open: false, allArrivedOn: '2026-12-05', toCome: 0 })] };
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: closed })} productNames={NAMES} frozen={false} />);
    expect(screen.getByTestId('handover-progress').textContent).toBe('All arrived');
    expect(screen.queryByTestId('record-arrival')).toBeNull();
    expect(screen.getByTestId('undo-all-arrived')).toBeTruthy();
    expect(screen.getByTestId('freight-pill').textContent).toMatch(/final/);
  });

  it('a frozen cycle offers nothing to press', () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg()} productNames={NAMES} frozen />);
    expect(screen.queryByTestId('hand-over')).toBeNull();
    expect(screen.queryByTestId('record-arrival')).toBeNull();
    expect(screen.queryByTestId('all-arrived')).toBeNull();
  });

  it('in Arabic: the words are Arabic, a handover is إرسالية (never دفعة), and the Latin names stay isolated', () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg()} productNames={NAMES} frozen={false} />, 'ar');
    const card = screen.getByTestId('handovers');
    expect(card.textContent).toContain(ar.handovers.title);
    expect(card.textContent).toContain('الإرسالية 1');
    expect(card.textContent).toContain('وصل 110 من 150');
    expect(card.textContent).not.toMatch(/دفعة/);
    expect(screen.getByTestId('freight-pill').textContent).toMatch(/تقديري/);
    expect(screen.getByRole('button', { name: new RegExp(ar.handovers.handOver) })).toBeTruthy();
  });

  it('nothing handed over yet: says how many wait in the UAE', () => {
    wrap(
      <HandoverSection
        cycleId="c-1"
        leg={leg({ handovers: { ...SUMMARY, handovers: [], stillInUae: 400, withForwarder: 0, withForwarderUnknown: 0, arrived: 0 } })}
        productNames={NAMES}
        frozen={false}
      />,
    );
    expect(screen.getByTestId('handovers-empty').textContent).toMatch(/400 pieces waiting/);
    expect(screen.queryByTestId('freight-pill')).toBeNull();
  });
});

describe('Hand over goods', () => {
  it('posts the day, forwarder, freight in AED at the Exchange rates page rate, pieces and who paid — no products', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '4200' } });
    await waitFor(() => expect((within(dlg).getByLabelText(/Rate to EGP for AED/) as HTMLInputElement).value).toBe('15.2'));
    fireEvent.change(within(dlg).getByLabelText(en.handovers.piecesIfKnown), { target: { value: '150' } });
    // Paid by: Shady.
    const combos = within(dlg).getAllByRole('combobox');
    fireEvent.click(combos[combos.length - 1]);
    fireEvent.click(await screen.findByRole('option', { name: /Shady/ }));
    expect(within(dlg).getByTestId('handover-paid-by-hint').textContent).toMatch(/owes Shady this freight in AED/);
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    const [, url, body] = call.mock.calls[0];
    expect(url).toBe('/shipping/legs/leg-2/handovers');
    expect(body).toMatchObject({
      freightAmount: 4200,
      freightCurrency: 'AED',
      paidAmount: 4200,
      freightRateToEgp: 15.2,
      pieces: 150,
      paidByUserId: 'u-shady',
    });
    expect(body).not.toHaveProperty('lines');
  });

  it('pieces left empty are "not known" (null); the business paid is no payer', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '0' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][2]).toMatchObject({ freightAmount: 0, paidAmount: 0, pieces: null, paidByUserId: undefined });
  });

  it('a refusal is said in the dialog, translated, and what was typed stays', async () => {
    state.answer = () => refusal('HANDOVER_PIECES_EXCEED_WAITING', { available: 210, asked: 300 });
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '100' } });
    fireEvent.change(within(dlg).getByLabelText(en.handovers.piecesIfKnown), { target: { value: '300' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only 210 pieces are still in the UAE and not already with the forwarder, so 300 cannot have been handed over.',
    );
    expect((within(dlg).getByLabelText(en.handovers.piecesIfKnown) as HTMLInputElement).value).toBe('300');
  });

  it('the hint shows the sum saved at the rate typed, and names the page rate only when it differs', async () => {
    // Owner 2026-11-20: "I typed 14.8 it shows 15.2 as current and calculate 14.8".
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '4000' } });
    const rateBox = within(dlg).getByLabelText(/Rate to EGP for AED/) as HTMLInputElement;
    await waitFor(() => expect(rateBox.value).toBe('15.2'));
    const hint = () => within(dlg).getByTestId('handover-freight-hint').textContent ?? '';
    // At the page's own rate there is nothing to tell apart: only the sum.
    expect(hint()).toContain('4000 AED × 15.2 =');
    expect(hint()).toContain('60,800.00');
    expect(hint()).not.toContain('Exchange rates page');
    fireEvent.change(rateBox, { target: { value: '14.8' } });
    expect(hint()).toContain('4000 AED × 14.8 =');
    expect(hint()).toContain('59,200.00');
    expect(hint()).toContain('Exchange rates page: 1 AED = 15.2 EGP');
    expect(hint()).not.toMatch(/Current rate/);
  });

  it('without a freight it sends nothing', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.handovers.freightRequired);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('Record arrival', () => {
  it('starts empty per product beside what waits in the UAE, and posts only what was typed, from the handover picked', async () => {
    wrap(<RecordArrivalDialog leg={leg()} handoverId="h-1" productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('record-arrival-dialog');
    const inputs = within(dlg).getAllByTestId('arrival-qty') as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(['', '']);
    fireEvent.change(inputs[0], { target: { value: '20' } });
    expect(within(dlg).getByTestId('arrival-total').textContent).toMatch(/^20 pieces/);
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][1]).toBe('/shipping/legs/leg-2/arrivals');
    expect(call.mock.calls[0][2]).toMatchObject({ handoverId: 'h-1', lines: [{ purchaseOrderItemId: 'poi-a', qty: 20 }] });
  });

  it('with two open lots and none picked it asks which, and sends nothing', async () => {
    wrap(<RecordArrivalDialog leg={leg()} productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('record-arrival-dialog');
    fireEvent.change((within(dlg).getAllByTestId('arrival-qty') as HTMLInputElement[])[0], { target: { value: '1' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.handovers.pickHandover);
    expect(call).not.toHaveBeenCalled();
  });

  it('with one open lot it is picked by itself', async () => {
    const one = { ...SUMMARY, handovers: [SUMMARY.handovers[1]] };
    wrap(<RecordArrivalDialog leg={leg({ handovers: one })} productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('record-arrival-dialog');
    fireEvent.change((within(dlg).getAllByTestId('arrival-qty') as HTMLInputElement[])[1], { target: { value: '5' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][2]).toMatchObject({ handoverId: 'h-2' });
  });

  it('a refusal over the handover count is translated and the counts stay', async () => {
    state.answer = () => refusal('ARRIVAL_EXCEEDS_HANDOVER', { handover: 1, pieces: 150, arrived: 110, toCome: 40, asked: 50 });
    wrap(<RecordArrivalDialog leg={leg()} handoverId="h-1" productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('record-arrival-dialog');
    const input = (within(dlg).getAllByTestId('arrival-qty') as HTMLInputElement[])[0];
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Handover 1 was 150 pieces and 110 arrived from it, so 50 more cannot have.',
    );
    expect(input.value).toBe('50');
  });

  it('in Arabic the form is Arabic', async () => {
    wrap(<RecordArrivalDialog leg={leg()} handoverId="h-1" productNames={NAMES} onClose={() => {}} />, 'ar');
    const dlg = await screen.findByTestId('record-arrival-dialog');
    expect(dlg.textContent).toContain(ar.handovers.arrivalTitle);
    expect(dlg.textContent).toContain(ar.handovers.inUae);
  });
});

describe('All arrived', () => {
  it('with pieces missing, asks which products they were and posts them as lost', async () => {
    wrap(<AllArrivedDialog leg={leg()} handover={handover({ arrived: 145, toCome: 5 })} productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('all-arrived-dialog');
    expect(within(dlg).getByTestId('all-arrived-missing').textContent).toMatch(/150 pieces and 145 arrived: 5 never came/);
    fireEvent.change((within(dlg).getAllByTestId('lost-qty') as HTMLInputElement[])[1], { target: { value: '5' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.handovers.allArrived }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][1]).toBe('/shipping/handovers/h-1/all-arrived');
    expect(call.mock.calls[0][2]).toMatchObject({ lost: [{ purchaseOrderItemId: 'poi-b', qty: 5 }] });
  });

  it('with no count, says nothing is marked lost and posts no lost lines', async () => {
    wrap(<AllArrivedDialog leg={leg()} handover={SUMMARY.handovers[1]} productNames={NAMES} onClose={() => {}} />);
    const dlg = await screen.findByTestId('all-arrived-dialog');
    expect(within(dlg).getByTestId('all-arrived-nothing-missing').textContent).toBe(en.handovers.closeNoCount);
    fireEvent.click(within(dlg).getByRole('button', { name: en.handovers.allArrived }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][2]).toMatchObject({ lost: [] });
  });
});

describe('the leg header on a handover leg', () => {
  it('says what was paid — each handover at its own rate — and labels the whole-leg figure as an estimate', () => {
    wrap(<HandoverLegCost leg={leg()} />);
    expect(screen.getByTestId('leg-freight-paid').textContent).toMatch(/10,200\.00.* paid · .*153,000\.00/);
    // 10,200 × 400 ÷ 190, said as what the whole leg comes to at the estimate.
    expect(screen.getByTestId('leg-cost-estimate').textContent).toMatch(/≈ .*21,473\.68.* for all 400 at the estimate/);
    // The extrapolated pounds the costing carries are never shown bare.
    expect(screen.getByTestId('leg-cost').textContent).not.toMatch(/322,105/);
  });

  it('final: no estimate line; nothing handed over: says no freight is paid', () => {
    wrap(<HandoverLegCost leg={leg({ handovers: { ...SUMMARY, final: true } })} />);
    expect(screen.queryByTestId('leg-cost-estimate')).toBeNull();
    cleanup();
    wrap(<HandoverLegCost leg={leg({ handovers: { ...SUMMARY, handovers: [] } })} />);
    expect(screen.getByTestId('leg-cost').textContent).toBe(en.handovers.nothingPaidYet);
  });

  it('one status: not left, in transit while nothing came back, then partly arrived / arrived — never partly departed', () => {
    expect(handoverLegStatus(leg({ handovers: { ...SUMMARY, handovers: [] } }))).toBe('PENDING');
    expect(handoverLegStatus(leg({ status: 'PARTLY_DEPARTED', delivered: 0 }))).toBe('IN_TRANSIT');
    expect(handoverLegStatus(leg({ status: 'PARTLY_ARRIVED' }))).toBe('PARTLY_ARRIVED');
    expect(handoverLegStatus(leg({ status: 'ARRIVED' }))).toBe('ARRIVED');
  });

  it('an arrival reads date, then its products on their own line, then the count', () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg()} productNames={NAMES} frozen={false} />);
    const first = screen.getAllByTestId('handover-arrival')[0];
    expect(within(first).getByTestId('arrival-day').textContent).toMatch(/^Arrived /);
    expect(within(first).getByTestId('arrival-products').textContent).toBe('SU8 headset ×30, Y50 headset ×30');
  });
});

// ─── Freight paid in parts (owner 2026-11-20, mockup approved) ─────────────

/** CYC-2026-0002 leg 2, Handover 1: 8,000 AED, Youssef paid 4,000 at 14.8, 4,000 to pay at the page's 15.2. */
const OWED_LOT = handover({
  pieces: 400,
  freightAmount: '8000.00',
  freightRateToEgp: '15.2000',
  freightAmountEgp: '120000.00',
  freightPaid: '4000.00',
  freightPaidEgp: '59200.00',
  freightToPay: '4000.00',
  freightToPayEgp: '60800.00',
  payments: [
    payment({
      paidOn: '2026-11-20',
      amount: '4000.00',
      rateToEgp: '14.8000',
      amountEgp: '59200.00',
      paidByUserId: 'u-youssef',
      paidBy: { id: 'u-youssef', name: 'Mohammed Youssef', kind: 'INVESTOR' },
      owed: null,
    }),
  ],
  arrived: 0,
  covered: 400,
  toCome: 400,
  arrivals: [],
});
const OWED: LegHandovers = {
  ...SUMMARY,
  handovers: [OWED_LOT],
  freightEgp: '120000.00',
  freightByCurrency: [{ currency: 'AED', amount: '8000.00' }],
  paidByCurrency: [{ currency: 'AED', amount: '4000.00' }],
  toPayByCurrency: [{ currency: 'AED', amount: '4000.00', rateToEgp: '15.2000', amountEgp: '60800.00' }],
  covered: 400,
  legCostEgp: '120000.00',
  perPiece: { amount: '20.00', currency: 'AED' },
  perPieceEgp: '300.00',
  stillInUae: 0,
  withForwarder: 400,
  withForwarderUnknown: 0,
  arrived: 0,
};

describe('freight paid in parts on the card', () => {
  it('a green row for what Youssef paid, an amber row for what is to pay at the page rate (today), Record payment — and no "paid" pill yet', async () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: OWED })} productNames={NAMES} frozen={false} payers={PAYERS} />);
    const paid = screen.getByTestId('freight-payment');
    expect(paid.textContent).toMatch(/Paid Nov 20, 2026 · by Mohammed Youssef/);
    expect(paid.textContent).toMatch(/4,000\.00.*AED × 14\.80/);
    expect(paid.textContent).toMatch(/59,200\.00/);
    const rest = screen.getByTestId('freight-to-pay');
    expect(rest.textContent).toMatch(/To pay · rate not known yet/);
    expect(rest.textContent).toMatch(/4,000\.00.*AED × 15\.20/);
    // The page's rate is 15.2 too: the row says it is today's.
    await waitFor(() => expect(rest.textContent).toMatch(/\(today\)/));
    expect(rest.textContent).toMatch(/≈ .*60,800\.00/);
    expect(within(rest).getByTestId('record-payment')).toBeTruthy();
    expect(screen.queryByTestId('freight-paid-pill')).toBeNull();
    // An investor's payment is his contribution: nothing is owed to him.
    expect(screen.queryByTestId('handover-owed')).toBeNull();
    expect(screen.queryByTestId('page-rate-moved')).toBeNull();
  });

  it('the leg header: "4,000.00 AED paid · 4,000.00 AED to pay", "≈ 120,000.00 EGP so far · to pay counted at 15.20 until paid"', () => {
    wrap(<HandoverLegCost leg={leg({ handovers: OWED })} />);
    expect(screen.getByTestId('leg-freight-paid').textContent).toMatch(/4,000\.00.*AED paid · .*4,000\.00.*AED to pay/);
    expect(screen.getByTestId('leg-cost-so-far').textContent).toMatch(/≈ .*120,000\.00.* so far · to pay counted at 15\.20 until paid/);
  });

  it('once paid: "Freight paid · 8,000.00 AED", two green rows, no amber row, no Record payment', () => {
    const done = handover({
      ...OWED_LOT,
      freightToPay: '0.00',
      freightToPayEgp: '0.00',
      freightPaid: '8000.00',
      freightAmountEgp: '121200.00',
      payments: [
        OWED_LOT.payments[0],
        payment({ id: 'p-9', paidOn: '2026-11-20', amount: '4000.00', rateToEgp: '15.5000', amountEgp: '62000.00', paidByUserId: null, paidBy: null, owed: null }),
      ],
    });
    wrap(
      <HandoverSection
        cycleId="c-1"
        leg={leg({ handovers: { ...OWED, handovers: [done], toPayByCurrency: [], freightEgp: '121200.00' } })}
        productNames={NAMES}
        frozen={false}
        payers={PAYERS}
      />,
    );
    expect(screen.getByTestId('freight-paid-pill').textContent).toMatch(/Freight paid · .*8,000\.00/);
    const rows = screen.getAllByTestId('freight-payment');
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toMatch(/by the business.*4,000\.00.*AED × 15\.50.*62,000\.00/);
    expect(screen.queryByTestId('freight-to-pay')).toBeNull();
    expect(screen.queryByTestId('record-payment')).toBeNull();
  });

  it('Undo on a payment asks first and then deletes that payment', async () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: OWED })} productNames={NAMES} frozen={false} payers={PAYERS} />);
    fireEvent.click(screen.getByTestId('undo-payment'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(en.handovers.undoPaymentConfirm);
    fireEvent.click(within(dialog).getByRole('button', { name: en.handovers.undoPayment }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('delete', '/shipping/freight-payments/p-1'));
  });

  it('a frozen cycle offers no Record payment and no undo', () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: OWED })} productNames={NAMES} frozen payers={PAYERS} />);
    expect(screen.queryByTestId('record-payment')).toBeNull();
    expect(screen.queryByTestId('undo-payment')).toBeNull();
  });

  it("when the Exchange rates page moved since, the card says so (no \"today\") and Count at today's rate recounts the leg", async () => {
    const stale = {
      ...OWED,
      handovers: [{ ...OWED_LOT, freightRateToEgp: '15.0000', freightToPayEgp: '60000.00' }],
      toPayByCurrency: [{ currency: 'AED', amount: '4000.00', rateToEgp: '15.0000', amountEgp: '60000.00' }],
    };
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: stale })} productNames={NAMES} frozen={false} payers={PAYERS} />);
    const note = await screen.findByTestId('page-rate-moved');
    expect(note.textContent).toMatch(/now says 1 AED = 15\.20 EGP; the rest to pay is still counted at 15\.00/);
    expect(screen.getByTestId('freight-to-pay').textContent).not.toMatch(/\(today\)/);
    fireEvent.click(within(note).getByTestId('recount'));
    await waitFor(() => expect(call).toHaveBeenCalledWith('post', '/shipping/legs/leg-2/freight/recount', {}));
  });

  it('in Arabic: the rows, the button and the header are Arabic; a payment is سداد, a handover still never دفعة', () => {
    wrap(<HandoverSection cycleId="c-1" leg={leg({ handovers: OWED })} productNames={NAMES} frozen={false} payers={PAYERS} />, 'ar');
    const card = screen.getByTestId('handovers');
    expect(card.textContent).toContain('للسداد · السعر غير معروف بعد');
    expect(card.textContent).toContain(ar.handovers.recordPayment);
    expect(card.textContent).toContain(ar.handovers.freight);
    expect(screen.getByTestId('freight-payment-who').textContent).toMatch(/^دُفع .* · من Mohammed Youssef$/);
    expect(card.textContent).not.toMatch(/دفعة/);
    cleanup();
    wrap(<HandoverLegCost leg={leg({ handovers: OWED })} />, 'ar');
    expect(screen.getByTestId('leg-freight-paid').textContent).toMatch(/مدفوع .*للسداد/);
    expect(screen.getByTestId('leg-cost-so-far').textContent).toMatch(/حتى الآن/);
  });
});

describe('Hand over goods: Paid now', () => {
  it('Paid now follows the freight; 4,000 of 8,000 at 14.8 by Youssef says what is left and posts paidAmount', async () => {
    wrap(<HandOverDialog leg={leg({ handovers: { ...SUMMARY, handovers: [], stillInUae: 400 } })} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    const freight = () => within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot));
    fireEvent.change(freight(), { target: { value: '8000' } });
    const paidNow = within(dlg).getByLabelText(en.handovers.paidNow) as HTMLInputElement;
    expect(paidNow.value).toBe('8,000');
    expect(within(dlg).queryByTestId('left-to-pay')).toBeNull();
    fireEvent.change(paidNow, { target: { value: '4000' } });
    // Typed once, it is never put back by a change to the freight.
    fireEvent.change(freight(), { target: { value: '8000.0' } });
    fireEvent.change(freight(), { target: { value: '8000' } });
    expect(paidNow.value).toBe('4,000');
    const rateBox = within(dlg).getByLabelText(/Rate to EGP for AED/) as HTMLInputElement;
    await waitFor(() => expect(rateBox.value).toBe('15.2'));
    fireEvent.change(rateBox, { target: { value: '14.8' } });
    expect(within(dlg).getByTestId('handover-freight-hint').textContent).toMatch(
      /4000 AED × 14\.8 = .*59,200\.00.*Exchange rates page: 1 AED = 15\.2 EGP/,
    );
    expect(within(dlg).getByTestId('left-to-pay').textContent).toMatch(/4,000\.00.*AED left to pay later\. Its rate is asked when you pay it\./);
    const combos = within(dlg).getAllByRole('combobox');
    fireEvent.click(combos[combos.length - 1]);
    fireEvent.click(await screen.findByRole('option', { name: /Mohammed Youssef/ }));
    expect(within(dlg).getByTestId('handover-paid-by-hint').textContent).toBe(en.handovers.paidByInvestorHint);
    fireEvent.change(within(dlg).getByLabelText(en.handovers.piecesIfKnown), { target: { value: '400' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][2]).toMatchObject({
      freightAmount: 8000,
      freightCurrency: 'AED',
      paidAmount: 4000,
      freightRateToEgp: 14.8,
      pieces: 400,
      paidByUserId: 'u-youssef',
    });
  });

  it('more paid now than the freight is said in the dialog and nothing is sent', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '100' } });
    fireEvent.change(within(dlg).getByLabelText(en.handovers.paidNow), { target: { value: '101' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.handovers.paidNowMore);
    expect(call).not.toHaveBeenCalled();
  });

  it('nothing paid now: no rate, no payer, paidAmount 0', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightForLot)), { target: { value: '8000' } });
    fireEvent.change(within(dlg).getByLabelText(en.handovers.paidNow), { target: { value: '0' } });
    expect(within(dlg).queryByLabelText(/Rate to EGP for AED/)).toBeNull();
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    const body = call.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({ freightAmount: 8000, paidAmount: 0, paidByUserId: undefined });
    expect(body).not.toHaveProperty('freightRateToEgp');
  });

  it('in Arabic the Paid now block is Arabic', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" payers={PAYERS} onClose={() => {}} />, 'ar');
    const dlg = await screen.findByTestId('hand-over-dialog');
    expect(dlg.textContent).toContain(ar.handovers.freightForLot);
    expect(dlg.textContent).toContain(ar.handovers.paidNow);
  });
});

describe('Record freight payment', () => {
  it('starts on the rest (4,000 AED) at the page rate; at 15.5 the hint is the shipped one; posts day, amount, rate and payer', async () => {
    wrap(<FreightPaymentDialog handover={OWED_LOT} payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('freight-payment-dialog');
    expect(screen.getByTestId('freight-payment-hint').textContent).toMatch(/Handover 1 · .*4,000\.00.*AED still to pay/);
    const amount = within(dlg).getByLabelText(new RegExp(`^${en.handovers.amount}`)) as HTMLInputElement;
    expect(amount.value).toBe('4,000');
    expect(within(dlg).getByTestId('less-leaves-rest').textContent).toBe('Less than 4,000 leaves the rest still to pay');
    const rateBox = within(dlg).getByLabelText(/Rate to EGP for AED/) as HTMLInputElement;
    await waitFor(() => expect(rateBox.value).toBe('15.2'));
    fireEvent.change(rateBox, { target: { value: '15.5' } });
    expect(within(dlg).getByTestId('freight-payment-rate-hint').textContent).toMatch(
      /4000 AED × 15\.5 = .*62,000\.00.* · Exchange rates page: 1 AED = 15\.2 EGP/,
    );
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    const [method, url, body] = call.mock.calls[0];
    expect([method, url]).toEqual(['post', '/shipping/handovers/h-1/freight-payments']);
    expect(body).toMatchObject({ amount: 4000, rateToEgp: 15.5, paidByUserId: undefined });
    expect((body as { paidOn: string }).paidOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a partner named as paying is told the business owes him; a refusal is translated and what was typed stays', async () => {
    state.answer = () => refusal('FREIGHT_PAYMENT_EXCEEDS_UNPAID', { toPay: '4000.00', currency: 'AED', asked: '4500.00', handover: 1 });
    wrap(<FreightPaymentDialog handover={OWED_LOT} payers={PAYERS} onClose={() => {}} />);
    const dlg = await screen.findByTestId('freight-payment-dialog');
    const amount = within(dlg).getByLabelText(new RegExp(`^${en.handovers.amount}`)) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '4500' } });
    const combos = within(dlg).getAllByRole('combobox');
    fireEvent.click(combos[combos.length - 1]);
    fireEvent.click(await screen.findByRole('option', { name: /Shady/ }));
    expect(within(dlg).getByTestId('handover-paid-by-hint').textContent).toMatch(/owes Shady this freight in AED/);
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Only 4000.00 AED of handover 1's freight is still to pay, so 4500.00 cannot be paid on it.",
    );
    expect(amount.value).toBe('4,500');
    expect(call.mock.calls[0][2]).toMatchObject({ paidByUserId: 'u-shady' });
  });

  it('in Arabic the form is Arabic', async () => {
    wrap(<FreightPaymentDialog handover={OWED_LOT} payers={PAYERS} onClose={() => {}} />, 'ar');
    const dlg = await screen.findByTestId('freight-payment-dialog');
    expect(dlg.textContent).toContain(ar.handovers.paymentTitle);
    expect(dlg.textContent).toContain(ar.handovers.rateGot);
    expect(dlg.textContent).toContain(ar.handovers.paidOn);
  });
});

it('fully paid with every piece counted: the header is what was paid, with no "for all 400 at the estimate" line', () => {
  wrap(<HandoverLegCost leg={leg({ handovers: { ...OWED, toPayByCurrency: [], paidByCurrency: [{ currency: 'AED', amount: '8000.00' }], freightEgp: '121200.00' } })} />);
  expect(screen.getByTestId('leg-freight-paid').textContent).toMatch(/8,000\.00.* paid · .*121,200\.00/);
  expect(screen.queryByTestId('leg-cost-estimate')).toBeNull();
});
