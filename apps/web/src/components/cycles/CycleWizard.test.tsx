import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
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
let costingTotals: Record<string, unknown> = { landedEgp: 0 };

const ok = (data: unknown) => Promise.resolve({ data: { data: data } });

vi.mock('../../lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === `/cycles/${String(cycle?.id)}`) return ok(cycle);
      if (url.startsWith('/costing/')) return ok({ totals: costingTotals, items: [] });
      if (url === '/currency-rates/map') return ok({ USD: 50.5, AED: 13.85 });
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
      const refusal = refuse?.(url, body);
      if (refusal) return Promise.reject(refusal);
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
  // The wizard's pickers render EmptyState, which reaches next-intl's navigation;
  // building it reads these two at import time.
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
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
  // A provider and a cost, as a saved leg has: finishing submits this form,
  // which checks its own required fields.
  provider: 'Aramex',
  providerId: 'prov-1',
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

/** The shipping step's submit — the last step's, so it says Finish (2026-10-18). */
const finishButton = () => screen.findByRole('button', { name: 'Finish' });

async function finish() {
  fireEvent.click(await finishButton());
  await waitFor(() => expect(push).toHaveBeenCalled());
}

const contributionWrites = () => writes.filter((w) => w.url.startsWith('/cycles/participants/'));

beforeEach(() => {
  costingTotals = { landedEgp: 0 };
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

  it('a cycle whose goods have left is not set up any more: the wizard sends it to its page and writes nothing (owner, 2026-10-12)', async () => {
    for (const status of ['IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT']) {
      replace.mockReset();
      writes.length = 0;
      cycle = chinaCycle({
        status,
        shippingLegs: [leg(1, { departedOn: '2026-09-01', status: 'IN_TRANSIT' }), leg(2)],
      });
      renderWizard('cyc-1');
      await waitFor(() => expect(replace, status).toHaveBeenCalledWith('/en/cycles/cyc-1/details'));
      expect(screen.queryByRole('button', { name: /^finish$/i }), status).toBeNull();
      expect(writes, status).toEqual([]);
      cleanup();
    }
  });

  it('a cycle still purchasing opens in the wizard as before', async () => {
    cycle = chinaCycle({ status: 'PURCHASING' });
    renderWizard('cyc-1');
    expect(await finishButton()).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
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

  it('has three steps — no Receive Inventory, no Funding (owner 2026-10-18)', async () => {
    cycle = chinaCycle();
    renderWizard('cyc-1');
    await finishButton();
    expect(screen.queryByText(/receive inventory/i)).toBeNull();
    const steps = screen.getAllByRole('button', { name: /Cycle Info|Purchase Order|Shipping Leg|Funding/ });
    expect(steps.map((b) => b.textContent?.replace(/^\d/, '').trim())).toEqual([
      'Cycle Info',
      'Purchase Order',
      'Shipping Leg',
    ]);
    expect(screen.queryByText(/who is funding/i)).toBeNull();
    expect(document.querySelector('[data-field^="contribution-"]')).toBeNull();
  });

  it('the shipping step is the last: saving it saves the legs, walks the cycle, and lands on the details page', async () => {
    cycle = chinaCycle({ participants: [] });
    renderWizard('cyc-1');
    await finish();
    // The legs first, then the walk — in that order.
    const legWrite = writes.findIndex((w) => w.url.startsWith('/shipping/legs/'));
    const firstTransition = writes.findIndex((w) => w.url.endsWith('/transition'));
    expect(legWrite).toBeGreaterThanOrEqual(0);
    expect(firstTransition).toBeGreaterThan(legWrite);
    expect(push).toHaveBeenCalledWith('/en/cycles/cyc-1/details');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('finishing writes no contribution: the partners stay at zero for the cycle page to ask', async () => {
    cycle = chinaCycle({
      participants: [
        { id: 'part-1', participantType: 'CORE_PARTNER', contributionAmount: '0' },
        { id: 'part-2', participantType: 'CORE_PARTNER', contributionAmount: '0' },
      ],
    });
    renderWizard('cyc-1');
    await finish();
    expect(contributionWrites()).toEqual([]);
    expect(writes.some((w) => w.url.endsWith('/participants'))).toBe(false);
  });

  it('a leg the server refuses keeps the wizard on the shipping step and goes nowhere', async () => {
    cycle = chinaCycle();
    refuse = (url) =>
      url.startsWith('/cycles/cyc-1/shipping-legs') || url.startsWith('/shipping/legs/')
        ? { response: { data: { error: { code: 'X', message: 'leg refused' } } } }
        : null;
    renderWizard('cyc-1');
    fireEvent.click(await finishButton());
    await waitFor(() => expect(screen.getByText(/leg refused/i)).toBeTruthy());
    expect(transitions()).toEqual([]);
    expect(push).not.toHaveBeenCalled();
    expect(await screen.findByTestId('wizard-leg-1')).toBeTruthy();
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
    // Leg 2: a China cycle's leg 1 starts at a flat amount (§2, 2026-10-20).
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[name="leg2_chargeablePieces"]')?.value,
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
      .querySelectorAll<HTMLInputElement>('input[data-field$="ratePerUnit"], input[data-field$="amount"]')
      .forEach((input) => fireEvent.change(input, { target: { value: '2' } }));

    fireEvent.submit(tracking()!.form!);
    // The last step: saving it finishes, and the cycle's page opens.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/en/cycles/cyc-1/details'));
    expect(useCycleWizardDraft.getState().legFields['cyc-1']).toBeUndefined();
    const saved = writes.find((w) => w.url === '/cycles/cyc-1/shipping-legs');
    expect((saved?.body as Body | undefined)?.trackingRef).toBe('TRK-SAVED');
  });

  // Where a leg leaves from sets where it starts (owner, 2026-10-20, §2).
  const costOf = (prefix: string) => ({
    currency: document.querySelector<HTMLInputElement>(`input[name="${prefix}currency"]`)?.value,
    basis: document.querySelector<HTMLInputElement>(`input[name="${prefix}costBasis"]`)?.value,
    fx: document.querySelector<HTMLInputElement>(`input[name="${prefix}fxRateToEgp"]`)?.value,
  });

  it('a new China cycle: leg 1 leaves China in USD at a flat amount, leg 2 leaves the UAE in AED per piece — each at today’s rate', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    renderWizard('cyc-1');
    await waitFor(() => expect(costOf('leg1_').fx).toBe('50.5'));
    expect(costOf('leg1_')).toEqual({ currency: 'USD', basis: 'FLAT', fx: '50.5' });
    expect(costOf('leg2_')).toEqual({ currency: 'AED', basis: 'PER_PIECE', fx: '13.85' });
  });

  it('a new UAE-direct cycle: its only leg leaves the UAE — AED, per piece', async () => {
    cycle = chinaCycle({ originType: 'UAE_DIRECT', currency: 'AED', shippingLegs: [] });
    renderWizard('cyc-1');
    await waitFor(() => expect(costOf('leg1_').fx).toBe('13.85'));
    expect(costOf('leg1_')).toEqual({ currency: 'AED', basis: 'PER_PIECE', fx: '13.85' });
  });

  it('a leg already saved keeps its own currency and basis — EGP stays EGP', async () => {
    cycle = chinaCycle();
    renderWizard('cyc-1');
    await waitFor(() => expect(costOf('leg1_').currency).toBe('EGP'));
    expect(costOf('leg1_')).toEqual({ currency: 'EGP', basis: 'FLAT', fx: '1' });
    expect(costOf('leg2_')).toEqual({ currency: 'EGP', basis: 'FLAT', fx: '1' });
  });

  it('a currency picked is never put back: leg 1 moved to CNY survives going back and forward', async () => {
    cycle = chinaCycle({ shippingLegs: [] });
    renderWizard('cyc-1');
    await waitFor(() => expect(costOf('leg1_').currency).toBe('USD'));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    const picker = screen.getAllByRole('combobox').find((b) => b.textContent?.includes('USD'))!;
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole('option', { name: /CNY/ }));
    const fx = document.querySelector<HTMLInputElement>('input[name="leg1_fxRateToEgp"]')!;
    fireEvent.change(fx, { target: { value: '7.1' } });
    fireEvent.keyUp(fx, { key: '1' });
    await act(() => new Promise((r) => setTimeout(r, 10)));

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findAllByTestId('wizard-saved-order');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(costOf('leg1_').currency).toBe('CNY'));
    expect(costOf('leg1_').fx).toBe('7.1');
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

describe('A reload restores the draft (spec 39, 47)', () => {
  it('under StrictMode, a draft with a saved cycle comes back on its step', async () => {
    // Development mounts every effect twice. The restore marked itself done
    // before the cycle check answered, so the second run returned early and
    // the check's answer was thrown away with the first run: a reload of
    // /cycles/new landed on an empty step 1.
    cycle = chinaCycle({ purchaseOrders: [], shippingLegs: [] });
    useCycleWizardDraft.setState({
      hydrated: true,
      savedAt: Date.now(),
      draft: {
        currentStep: 1,
        maxStepReached: 1,
        cycleId: 'cyc-1',
        cycleCode: 'CYC-2026-0001',
        poId: null,
        poReference: null,
        legIds: {},
        originType: 'CHINA',
        poSupplierId: 'sup-1',
        poCurrency: 'USD',
        poFxRate: '50',
        poOrderedOn: '',
        lineItems: [],
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <StrictMode>
        <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
          <QueryClientProvider client={client}>
            <ToastProvider>
              <CycleWizard />
            </ToastProvider>
          </QueryClientProvider>
        </NextIntlClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByTestId('wizard-draft-restored')).toBeTruthy();
  });

  it('a draft left on the old Funding step (step 4) comes back on the shipping step', async () => {
    cycle = chinaCycle({ status: 'PURCHASING' });
    useCycleWizardDraft.setState({
      hydrated: true,
      savedAt: Date.now(),
      draft: {
        currentStep: 3,
        maxStepReached: 3,
        cycleId: 'cyc-1',
        cycleCode: 'CYC-2026-0001',
        poId: 'po-1',
        poReference: 'PO-2026-0001',
        legIds: { 1: 'leg-1', 2: 'leg-2' },
        originType: 'CHINA',
        poSupplierId: '',
        poCurrency: 'USD',
        poFxRate: '50',
        poOrderedOn: '',
        lineItems: [],
      },
    });
    renderWizard();
    expect(await screen.findByTestId('wizard-leg-2')).toBeTruthy();
    expect(await finishButton()).toBeTruthy();
    expect(screen.getByRole('button', { name: /Shipping Leg/ }).getAttribute('aria-current')).toBe('step');
  });
});
