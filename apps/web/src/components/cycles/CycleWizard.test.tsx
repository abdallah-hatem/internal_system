import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { useCycleWizardDraft } from '@/stores/cycle-wizard-draft';
import CycleWizard from './CycleWizard';
import { statusesToWalk } from './wizard-walk';

// ---------------------------------------------------------------------------
// The API, faked per URL. Every write is recorded, so a test can say exactly
// which transitions finishing asked for — and that nothing else was sent.
// ---------------------------------------------------------------------------

const writes: { method: string; url: string; body: unknown }[] = [];
type Body = Record<string, unknown>;
let cycle: Body;
let refuse: ((url: string, body: Body) => unknown) | null = null;

const ok = (data: unknown) => Promise.resolve({ data: { data: data } });

vi.mock('../../lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === `/cycles/${String(cycle?.id)}`) return ok(cycle);
      if (url.startsWith('/costing/')) return ok({ totals: { landedEgp: 0 }, items: [] });
      if (url === '/currency-rates/map') return ok({});
      if (url === '/providers') return ok([{ id: 'prov-1', name: 'Aramex' }]);
      return ok([]);
    },
    post: (url: string, body: Body) => {
      writes.push({ method: 'POST', url, body });
      const refusal = refuse?.(url, body);
      if (refusal) return Promise.reject(refusal);
      return ok({ id: 'new' });
    },
    put: (url: string, body: Body) => {
      writes.push({ method: 'PUT', url, body });
      return ok({ id: url.split('/').pop() });
    },
  },
}));

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/cycles',
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

// ---------------------------------------------------------------------------
// Fixtures: cycles the business could have produced — orders with lines, legs
// in sequence, the three partners on it.
// ---------------------------------------------------------------------------

const order = (n: number, ref: string, product: string) => ({
  id: `po-${n}`,
  reference: ref,
  status: 'DRAFT',
  currency: 'USD',
  orderedOn: '2026-10-01T00:00:00.000Z',
  supplier: { name: `Supplier ${n}` },
  items: [{ id: `poi-${n}`, product: { name: product }, orderedQty: '40', unitPrice: '12.50' }],
});

const leg = (sequence: number, extra: Record<string, unknown> = {}) => ({
  id: `leg-${sequence}`,
  sequence,
  origin: sequence === 1 ? 'Guangzhou, CN' : 'Dubai, UAE',
  destination: sequence === 1 ? 'Dubai, UAE' : 'Cairo, Egypt',
  provider: null,
  providerId: null,
  trackingRef: `TRK-LEG-${sequence}`,
  departedOn: null,
  arrivedOn: null,
  status: 'PENDING',
  costBasis: 'FLAT',
  amount: '100',
  currency: 'EGP',
  fxRateToEgp: '1',
  ...extra,
});

function chinaCycle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cyc-1',
    code: 'CYC-2026-0001',
    status: 'PLANNING',
    originType: 'CHINA',
    currency: 'USD',
    purchaseOrders: [order(1, 'PO-2026-0001', 'Brake pad')],
    shippingLegs: [leg(1), leg(2)],
    participants: [],
    ...overrides,
  };
}

function renderWizard(existingCycleId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <CycleWizard existingCycleId={existingCycleId} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const transitions = () =>
  writes.filter((w) => w.url.endsWith('/transition')).map((w) => (w.body as Body).status);

const finishButton = () => screen.findByRole('button', { name: 'Finish' });

async function finish() {
  fireEvent.click(await finishButton());
  await waitFor(() => expect(push).toHaveBeenCalled());
}

beforeEach(() => {
  writes.length = 0;
  refuse = null;
  push.mockReset();
  replace.mockReset();
  localStorage.clear();
  useCycleWizardDraft.setState({ draft: null, savedAt: null, legFields: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Finishing walks only as far as the dates allow
// ---------------------------------------------------------------------------

describe('finishing the wizard', () => {
  it('with no dates: the cycle stops at PURCHASING, its order stays a draft, nothing is received', async () => {
    cycle = chinaCycle();
    renderWizard('cyc-1');
    await finish();

    // FUNDING and PURCHASING — not IN_TRANSIT, which would confirm the order (§15).
    expect(transitions()).toEqual(['FUNDING', 'PURCHASING']);
    expect(writes.some((w) => w.url.includes('/receipts'))).toBe(false);
    expect(push).toHaveBeenCalledWith('/en/cycles/cyc-1/details');
  });

  it('with leg 1 departed: In transit, and no further', async () => {
    cycle = chinaCycle({
      shippingLegs: [leg(1, { departedOn: '2026-10-02', status: 'IN_TRANSIT' }), leg(2)],
    });
    renderWizard('cyc-1');
    await finish();
    expect(transitions()).toEqual(['FUNDING', 'PURCHASING', 'IN_TRANSIT']);
  });

  it('with deliveries on both legs: Arrived Egypt at most — never Verification or Selling', async () => {
    cycle = chinaCycle({
      status: 'PURCHASING',
      shippingLegs: [
        leg(1, { departedOn: '2026-09-01', arrivedOn: '2026-09-20', status: 'ARRIVED' }),
        leg(2, { departedOn: '2026-09-25', status: 'PARTLY_ARRIVED' }),
      ],
    });
    renderWizard('cyc-1');
    await finish();
    expect(transitions()).toEqual([
      'IN_TRANSIT',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
      'ARRIVED_EGYPT',
    ]);
    expect(writes.some((w) => w.url.includes('/receipts'))).toBe(false);
  });

  it('a departed leg with no delivery does not reach an arrival status', async () => {
    cycle = chinaCycle({
      status: 'IN_TRANSIT',
      shippingLegs: [leg(1, { departedOn: '2026-09-01', status: 'IN_TRANSIT' }), leg(2)],
    });
    renderWizard('cyc-1');
    await finish();
    expect(transitions()).toEqual([]);
  });

  it('the second time: a cycle already as far as its dates go is not moved again', async () => {
    cycle = chinaCycle({ status: 'PURCHASING' });
    renderWizard('cyc-1');
    await finish();
    expect(transitions()).toEqual([]);
    expect(push).toHaveBeenCalledWith('/en/cycles/cyc-1/details');
  });

  it('a refused step stops the walk, says why, and stays on the wizard', async () => {
    cycle = chinaCycle({
      shippingLegs: [leg(1, { departedOn: '2026-10-02', status: 'IN_TRANSIT' }), leg(2)],
    });
    refuse = (url, body) =>
      url.endsWith('/transition') && body.status === 'IN_TRANSIT'
        ? {
            response: {
              data: {
                error: {
                  code: 'LEG_NOT_DEPARTED',
                  message: 'x has not departed',
                  params: { leg: 'Guangzhou, CN → Dubai, UAE' },
                },
              },
            },
          }
        : null;
    renderWizard('cyc-1');
    fireEvent.click(await finishButton());

    await waitFor(() => expect(screen.getByText(/has not departed/i)).toBeTruthy());
    expect(transitions()).toEqual(['FUNDING', 'PURCHASING', 'IN_TRANSIT']);
    expect(push).not.toHaveBeenCalled();
    expect((await finishButton()).hasAttribute('disabled')).toBe(false);
  });

  it('double-clicking Finish walks the cycle once', async () => {
    cycle = chinaCycle();
    renderWizard('cyc-1');
    const button = await finishButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(transitions()).toEqual(['FUNDING', 'PURCHASING']);
  });

  it('has no Receive Inventory step any more', async () => {
    cycle = chinaCycle();
    renderWizard('cyc-1');
    await finishButton();
    expect(screen.queryByText(/receive inventory/i)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Cycle Info|Purchase Order|Shipping Leg|Funding/ })).toHaveLength(4);
  });
});

describe('statusesToWalk', () => {
  it('UAE direct with no departure stays in PURCHASING', () => {
    expect(statusesToWalk('UAE_DIRECT', 'PLANNING', [{ sequence: 1 }])).toEqual([
      'FUNDING',
      'PURCHASING',
    ]);
  });

  it('UAE direct departed → in transit to Egypt; delivered → Arrived Egypt', () => {
    expect(
      statusesToWalk('UAE_DIRECT', 'PURCHASING', [{ sequence: 1, departedOn: '2026-10-01' }]),
    ).toEqual(['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']);
    expect(
      statusesToWalk('UAE_DIRECT', 'IN_TRANSIT_TO_EGYPT', [
        { sequence: 1, departedOn: '2026-10-01', status: 'ARRIVED' },
      ]),
    ).toEqual(['ARRIVED_EGYPT']);
  });

  it('a leg-2 departure without a leg-1 departure moves nothing past PURCHASING', () => {
    expect(
      statusesToWalk('CHINA', 'PLANNING', [
        { sequence: 1 },
        { sequence: 2, departedOn: '2026-10-01' },
      ]),
    ).toEqual(['FUNDING', 'PURCHASING']);
  });

  it('a cycle being received, sold or cancelled is out of reach', () => {
    for (const status of ['VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      expect(statusesToWalk('CHINA', status, [])).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Resume: every order and every leg
// ---------------------------------------------------------------------------

describe('resuming a cycle', () => {
  it('with two orders and two legs shows both of each', async () => {
    cycle = chinaCycle({
      purchaseOrders: [order(1, 'PO-2026-0001', 'Brake pad'), order(2, 'PO-2026-0002', 'Chain kit')],
      shippingLegs: [leg(1), leg(2)],
    });
    renderWizard('cyc-1');
    await finishButton();

    fireEvent.click(screen.getByRole('button', { name: /Purchase Order/ }));
    const orders = await screen.findAllByTestId('wizard-saved-order');
    expect(orders).toHaveLength(2);
    expect(orders[0].textContent).toContain('PO-2026-0001');
    expect(orders[0].textContent).toContain('Brake pad');
    expect(orders[1].textContent).toContain('PO-2026-0002');
    expect(orders[1].textContent).toContain('Chain kit');

    fireEvent.click(screen.getByRole('button', { name: /Shipping Leg/ }));
    await screen.findByTestId('wizard-leg-2');
    expect(
      document.querySelector<HTMLInputElement>('input[name="leg1_trackingRef"]')!.value,
    ).toBe('TRK-LEG-1');
    expect(
      document.querySelector<HTMLInputElement>('input[name="leg2_trackingRef"]')!.value,
    ).toBe('TRK-LEG-2');
  });

  it('seeds a new leg\'s piece count from every order, not the first', async () => {
    cycle = chinaCycle({
      purchaseOrders: [order(1, 'PO-2026-0001', 'Brake pad'), order(2, 'PO-2026-0002', 'Chain kit')],
      shippingLegs: [],
    });
    renderWizard('cyc-1');
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[name="leg1_chargeablePieces"]')?.value,
      ).toBe('80'),
    );
  });

  it('a cycle past Arrived Egypt opens on its own page', async () => {
    cycle = chinaCycle({ status: 'SELLING' });
    renderWizard('cyc-1');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/en/cycles/cyc-1/details'));
  });
});

// ---------------------------------------------------------------------------
// The purchase order step
// ---------------------------------------------------------------------------

describe('the purchase order step', () => {
  it("dates the order Cairo's today, and starts with one item row", async () => {
    // 23:30 UTC on 15 Dec is 01:30 on the 16th in Cairo; the test machine is UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-15T23:30:00Z'));
    cycle = chinaCycle({ purchaseOrders: [], shippingLegs: [] });
    renderWizard('cyc-1');

    await waitFor(() =>
      expect(document.querySelector('input[type="hidden"][name="orderedOn"]')).toBeTruthy(),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[type="hidden"][name="orderedOn"]')!.value,
    ).toBe('2026-12-16');
    expect(screen.getAllByTestId('wizard-line-item')).toHaveLength(1);
  });

  it('a typed quantity survives going back a step and returning', async () => {
    cycle = chinaCycle({ purchaseOrders: [], shippingLegs: [] });
    renderWizard('cyc-1');
    const qty = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('input[data-field="orderedQty"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.change(qty, { target: { value: '37' } });
    fireEvent.change(document.querySelector('input[name="fxRateToEgp"]')!, {
      target: { value: '48.25' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText('Cycle Information');
    fireEvent.click(screen.getByRole('button', { name: /Purchase Order/ }));

    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[data-field="orderedQty"]')!.value,
      ).toBe('37'),
    );
    expect(document.querySelector<HTMLInputElement>('input[name="fxRateToEgp"]')!.value).toBe(
      '48.25',
    );
  });
});

// ---------------------------------------------------------------------------
// The shipping step keeps what was typed and not saved
// ---------------------------------------------------------------------------

describe('the shipping step', () => {
  const tracking = () =>
    document.querySelector<HTMLInputElement>('input[name="leg1_trackingRef"]');

  async function typeTracking(value: string) {
    const input = await waitFor(() => {
      expect(tracking()).toBeTruthy();
      return tracking()!;
    });
    // Let the form record what it opened with first.
    await act(() => new Promise((r) => setTimeout(r, 10)));
    fireEvent.change(input, { target: { value } });
    fireEvent.keyUp(input, { key: 'X' });
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }

  it('a typed value survives going back to the order and forward again', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    renderWizard('cyc-1');
    await typeTracking('TRK-TYPED');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findAllByTestId('wizard-saved-order');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(tracking()?.value).toBe('TRK-TYPED'));
  });

  it('leaving the wizard and coming back keeps it too', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    const first = renderWizard('cyc-1');
    await typeTracking('TRK-LEFT');
    first.unmount();

    renderWizard('cyc-1');
    await waitFor(() => expect(tracking()?.value).toBe('TRK-LEFT'));
  });

  it('saving the legs forgets the unsaved copy', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    renderWizard('cyc-1');
    await typeTracking('TRK-SAVED');
    expect(useCycleWizardDraft.getState().legFields['cyc-1']?.fields.leg1_trackingRef).toBe(
      'TRK-SAVED',
    );

    // The form checks its own required fields (it is noValidate), so it is
    // filled the way a person must before saving: a provider and a rate per leg.
    const unpicked = () =>
      screen
        .queryAllByRole('combobox')
        .filter((b) => b.textContent?.includes(en.wizard.selectShippingProvider));
    await waitFor(() => expect(unpicked().length).toBeGreaterThan(0));
    for (let guard = 0; unpicked().length > 0 && guard < 5; guard++) {
      fireEvent.click(unpicked()[0]);
      fireEvent.click(await screen.findByRole('option', { name: /Aramex/ }));
    }
    document
      .querySelectorAll<HTMLInputElement>('input[data-field$="ratePerUnit"]')
      .forEach((input) => fireEvent.change(input, { target: { value: '2' } }));

    fireEvent.submit(tracking()!.form!);
    await finishButton();
    expect(useCycleWizardDraft.getState().legFields['cyc-1']).toBeUndefined();
    const saved = writes.find((w) => w.url === '/cycles/cyc-1/shipping-legs');
    expect((saved?.body as Body | undefined)?.trackingRef).toBe('TRK-SAVED');
  });

  it('an untouched form keeps nothing', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    renderWizard('cyc-1');
    await waitFor(() => expect(tracking()).toBeTruthy());
    await act(() => new Promise((r) => setTimeout(r, 10)));
    fireEvent.click(screen.getByTestId('wizard-leg-1'));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(useCycleWizardDraft.getState().legFields['cyc-1']).toBeUndefined();
  });
});
