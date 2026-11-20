import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { HandoverSection, HandOverDialog, RecordArrivalDialog, AllArrivedDialog, HandoverLegCost, handoverLegStatus } from './Handovers';
import type { Handover, LegHandovers, ShipmentLeg } from './shipment-model';

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

const handover = (over: Partial<Handover>): Handover => ({
  id: 'h-1',
  number: 1,
  handedOverOn: '2026-11-18',
  pieces: 150,
  freightAmount: '6000.00',
  freightCurrency: 'AED',
  freightRateToEgp: '15.0000',
  freightAmountEgp: '90000.00',
  providerId: 'prov-1',
  provider: 'Gulf Freight',
  paidByUserId: 'u-shady',
  paidBy: { id: 'u-shady', name: 'Shady' },
  owed: { financingId: 'f-1', currency: 'AED', owed: '6000.00' },
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
      paidByUserId: null,
      paidBy: null,
      owed: null,
      arrived: 40,
      covered: 40,
      toCome: null,
      arrivals: [{ id: 'a-3', arrivedOn: '2026-12-03', lines: [{ purchaseOrderItemId: 'poi-b', qty: 40 }], total: 40 }],
    }),
  ],
  freightEgp: '153000.00',
  freightByCurrency: [{ currency: 'AED', amount: '10200.00' }],
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
    expect(within(one).getByTestId('handover-facts').textContent).toMatch(/150 pieces.*6,000\.00.*Gulf Freight.*paid by Shady/);
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
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightPaid)), { target: { value: '4200' } });
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
    expect(body).toMatchObject({ freightAmount: 4200, freightCurrency: 'AED', freightRateToEgp: 15.2, pieces: 150, paidByUserId: 'u-shady' });
    expect(body).not.toHaveProperty('lines');
  });

  it('pieces left empty are "not known" (null); the business paid is no payer', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightPaid)), { target: { value: '0' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0][2]).toMatchObject({ freightAmount: 0, pieces: null, paidByUserId: undefined });
  });

  it('a refusal is said in the dialog, translated, and what was typed stays', async () => {
    state.answer = () => refusal('HANDOVER_PIECES_EXCEED_WAITING', { available: 210, asked: 300 });
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" onClose={() => {}} />);
    const dlg = await screen.findByTestId('hand-over-dialog');
    fireEvent.change(within(dlg).getByLabelText(new RegExp(en.handovers.freightPaid)), { target: { value: '100' } });
    fireEvent.change(within(dlg).getByLabelText(en.handovers.piecesIfKnown), { target: { value: '300' } });
    fireEvent.click(within(dlg).getByRole('button', { name: en.common.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only 210 pieces are still in the UAE and not already with the forwarder, so 300 cannot have been handed over.',
    );
    expect((within(dlg).getByLabelText(en.handovers.piecesIfKnown) as HTMLInputElement).value).toBe('300');
  });

  it('without a freight it sends nothing', async () => {
    wrap(<HandOverDialog leg={leg()} cycleId="c-1" onClose={() => {}} />);
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
