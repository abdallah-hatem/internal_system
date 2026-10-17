import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { expectedLegs } from '../../../../api/src/common/cycle-routes';
import { expectedLegsOf, nextLegToAdd } from '@/components/cycles/leg-plan';
import { ShipmentPanel, type PanelCycle } from './ShipmentPanel';

/**
 * "Add next leg" and "Edit leg" on the cycle page's Shipment panel (owner,
 * 2026-10-12): the Shipments page's own leg forms (§13), for this cycle. A
 * China cycle's Dubai → Egypt leg is added after leg 1 left; any leg never
 * recorded can be. A leg's cost is edited there only while the rule allows
 * (§2: nothing of the cycle received or lost) — otherwise the form says why
 * and where a late charge goes. Both directions of every rule (§12).
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  status: 'IN_TRANSIT' as string,
  originType: 'CHINA' as 'CHINA' | 'UAE_DIRECT',
  legs: [1] as number[],
  received: 0,
  /** What the server says of the legs' cost (§2, 2026-10-17). */
  cost: { costEditable: true, costLockedReason: null, costLockedParams: {}, costChangeRecosts: false } as {
    costEditable: boolean;
    costLockedReason: string | null;
    costLockedParams: Record<string, string>;
    costChangeRecosts: boolean;
  },
  writes: [] as Array<{ method: string; url: string; body?: Record<string, unknown> }>,
  /** The leg row's cost, over the flat 400 every leg has by default. */
  legCost: {} as Record<string, unknown>,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const legPosition = (sequence: number) => ({
  legId: `leg-${sequence}`,
  sequence,
  isLast: sequence === Math.max(...state.legs),
  status: 'IN_TRANSIT',
  arrivedOn: null,
  entered: 40,
  departed: 40,
  atOrigin: 0,
  delivered: 0,
  lost: 0,
  onTheWay: 40,
  received: 0,
  waiting: 0,
  departedOn: '2026-09-01',
  origin: sequence === 1 && state.originType === 'CHINA' ? 'Guangzhou, CN' : 'Dubai, UAE',
  destination: sequence === 1 && state.originType === 'CHINA' ? 'Dubai, UAE' : 'Cairo, Egypt',
  lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, departed: 40, atOrigin: 0, delivered: 0, lost: 0, onTheWay: 40, received: 0, waiting: 0 }],
  departures: [{ id: `dep-${sequence}`, departedOn: '2026-09-01', lines: [{ purchaseOrderItemId: 'poi-1', qty: 40 }], undoable: false }],
  deliveries: [],
  losses: [],
});

const shipment = () => ({
  cycleId: 'c-1',
  code: 'CYC-1',
  status: state.status,
  accounted: false,
  totals: { ordered: 40, received: state.received, lost: 0, atOrigin: 0, onTheWay: 40, waiting: 0 },
  lines: [{ purchaseOrderItemId: 'poi-1', productId: 'p1', productName: 'Brake pad', ordered: 40, received: 0, lost: 0, onTheWay: 40, waiting: 0, accounted: false }],
  legs: state.legs.map(legPosition),
  nextLeg: [{ purchaseOrderItemId: 'poi-1', waiting: 0 }],
  ...state.cost,
});

vi.mock('@/lib/api', () => {
  const write = (method: string) => (url: string, body?: Record<string, unknown>) => {
    state.writes.push({ method, url, body });
    return Promise.resolve({ data: { data: {}, cycleStatus: null } });
  };
  return {
    api: {
      get: (url: string) => {
        if (url.endsWith('/shipment')) return Promise.resolve({ data: { data: shipment() } });
        if (url === '/providers') return Promise.resolve({ data: { data: [{ id: 'prov-1', name: 'Nile Freight' }] } });
        return Promise.resolve({ data: { data: [] } });
      },
      post: write('post'),
      put: write('put'),
      delete: write('delete'),
    },
  };
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.status = 'IN_TRANSIT';
  state.originType = 'CHINA';
  state.legs = [1];
  state.received = 0;
  state.cost = { costEditable: true, costLockedReason: null, costLockedParams: {}, costChangeRecosts: false };
  state.writes = [];
  state.legCost = {};
});
afterEach(() => cleanup());

const panelCycle = (): PanelCycle => ({
  id: 'c-1',
  status: state.status,
  originType: state.originType,
  shippingLegs: state.legs.map((s) => ({
    id: `leg-${s}`,
    providerId: 'prov-1',
    provider: 'Nile Freight',
    trackingRef: 'TRK-1',
    costBasis: 'FLAT' as const,
    amount: 400,
    amountEgp: 400,
    currency: 'EGP',
    fxRateToEgp: 1,
    ...state.legCost,
  })),
  purchaseOrders: [],
});

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ShipmentPanel cycle={panelCycle()} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const form = (kind: string) => document.querySelector<HTMLElement>(`[data-leg-form="${kind}"]`);
const field = (root: HTMLElement, name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]`);

describe('the route the web offers is the API’s', () => {
  it('expectedLegsOf matches common/cycle-routes.ts for both routes', () => {
    for (const route of ['CHINA', 'UAE_DIRECT']) expect(expectedLegsOf(route)).toEqual(expectedLegs(route));
  });

  it('nextLegToAdd: the first leg not recorded, or nothing — never a third China leg or a second UAE one', () => {
    expect(nextLegToAdd('CHINA', [1])?.sequence).toBe(2);
    expect(nextLegToAdd('CHINA', [2])?.sequence).toBe(1);
    expect(nextLegToAdd('CHINA', [1, 2])).toBeNull();
    expect(nextLegToAdd('UAE_DIRECT', [1])).toBeNull();
    expect(nextLegToAdd('UAE_DIRECT', [])?.sequence).toBe(1);
  });
});

describe('Add next leg', () => {
  it('a China cycle whose leg 1 left offers "Add leg 2", opening the shared create form at Dubai → Egypt for this cycle', async () => {
    wrap();
    const add = await screen.findByTestId('add-next-leg');
    expect(add.textContent).toContain(en.shipment.addLeg.replace('{leg}', '2'));
    expect(add.getAttribute('type')).toBe('button');
    fireEvent.click(add);
    const f = form('add-leg')!;
    expect(f).toBeTruthy();
    // Portalled: not inside the panel, so never a form inside a form.
    expect(screen.getByTestId('shipment-panel').contains(f)).toBe(false);
    expect(within(f).getByTestId('leg-create-form')).toBeTruthy();
    expect(field(f, 'cycleId')!.value).toBe('c-1');
    expect(field(f, 'sequence')!.value).toBe('2');
    expect(field(f, 'origin')!.value).toBe('Dubai, UAE');
    expect(field(f, 'destination')!.value).toBe('Cairo, Egypt');
    // The provider picker carries its quick-create +.
    expect(f.querySelector('[data-quick-create="provider"]')).toBeTruthy();
  });

  it('saving posts the leg to this cycle, with the provider and the cost', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('add-next-leg'));
    const f = form('add-leg')!;
    fireEvent.click(within(f).getAllByRole('combobox')[0]);
    fireEvent.click(await screen.findByRole('option', { name: /Nile Freight/ }));
    // Charged per piece, the form's default basis.
    fireEvent.change(f.querySelector<HTMLInputElement>('input[data-field="ratePerUnit"]')!, { target: { value: '2.5' } });
    fireEvent.change(field(f, 'chargeablePieces')!, { target: { value: '40' } });
    fireEvent.click(within(f).getByRole('button', { name: en.common.create }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({
      method: 'post',
      url: '/cycles/c-1/shipping-legs',
      body: expect.objectContaining({
        sequence: 2,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        providerId: 'prov-1',
        costBasis: 'PER_PIECE',
        ratePerUnit: 2.5,
        chargeablePieces: 40,
      }),
    });
    // The body carries no cycle id of its own: the URL names the cycle.
    expect(state.writes[0].body).not.toHaveProperty('cycleId');
    await waitFor(() => expect(form('add-leg')).toBeNull());
  });

  it('every way out clears it: cancel, then open again starts from the route, not what was typed', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('add-next-leg'));
    fireEvent.change(field(form('add-leg')!, 'origin')!, { target: { value: 'Jebel Ali' } });
    fireEvent.click(within(form('add-leg')!).getByRole('button', { name: en.common.cancel }));
    expect(form('add-leg')).toBeNull();
    fireEvent.click(screen.getByTestId('add-next-leg'));
    expect(field(form('add-leg')!, 'origin')!.value).toBe('Dubai, UAE');
    expect(state.writes).toEqual([]);
  });

  it('a cycle with every leg recorded offers no next leg — China with two, UAE-direct with one', async () => {
    state.legs = [1, 2];
    wrap();
    await screen.findAllByTestId('shipment-leg');
    expect(screen.queryByTestId('add-next-leg')).toBeNull();
    cleanup();
    state.originType = 'UAE_DIRECT';
    state.legs = [1];
    wrap();
    await screen.findAllByTestId('shipment-leg');
    expect(screen.queryByTestId('add-next-leg')).toBeNull();
  });

  it('a cycle with no legs offers its first leg in the empty state', async () => {
    state.legs = [];
    state.originType = 'UAE_DIRECT';
    wrap();
    const button = await screen.findByRole('button', { name: en.shipment.addLeg.replace('{leg}', '1') });
    fireEvent.click(button);
    expect(field(form('add-leg')!, 'sequence')!.value).toBe('1');
  });

  it('not offered to an investor or an office role, nor on a cycle being settled, closed or cancelled', async () => {
    for (const role of ['TEMP_INVESTOR', 'ADMIN_SUPPORT']) {
      state.role = role;
      wrap();
      await screen.findAllByTestId('shipment-leg');
      expect(screen.queryByTestId('add-next-leg'), role).toBeNull();
      expect(screen.queryByTestId('edit-leg'), role).toBeNull();
      cleanup();
    }
    state.role = 'CORE_PARTNER';
    for (const status of ['SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      state.status = status;
      wrap();
      await screen.findAllByTestId('shipment-leg');
      expect(screen.queryByTestId('add-next-leg'), status).toBeNull();
      expect(screen.queryByTestId('edit-leg'), status).toBeNull();
      cleanup();
    }
  });
});

describe('Edit leg — the cost, while it can still change', () => {
  it('nothing received or lost: the cost fields are there, filled from the leg, and saving sends them', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('edit-leg'));
    const f = form('edit-leg')!;
    await waitFor(() => expect(field(f, 'amount')).toBeTruthy());
    expect(within(f).queryByTestId('leg-cost-locked')).toBeNull();
    fireEvent.change(f.querySelector<HTMLInputElement>('input[data-field="amount"]')!, { target: { value: '900' } });
    fireEvent.click(within(f).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ method: 'put', url: '/shipping/legs/leg-1', body: expect.objectContaining({ amount: 900, costBasis: 'FLAT' }) });
  });

  it('nothing received: no re-pricing warning', async () => {
    wrap();
    fireEvent.click(await screen.findByTestId('edit-leg'));
    const f = form('edit-leg')!;
    await waitFor(() => expect(field(f, 'amount')).toBeTruthy());
    expect(within(f).queryByTestId('leg-cost-recost-warning')).toBeNull();
  });

  it('received, and the server says the cost can still be corrected: the fields, one warning that it re-prices sold units, and saving sends the cost', async () => {
    state.received = 5;
    state.cost = { costEditable: true, costLockedReason: null, costLockedParams: {}, costChangeRecosts: true };
    wrap();
    fireEvent.click(await screen.findByTestId('edit-leg'));
    const f = form('edit-leg')!;
    const warning = await within(f).findByTestId('leg-cost-recost-warning');
    expect(warning.textContent).toBe(en.shipments.costRecostWarning);
    expect(within(f).queryByTestId('leg-cost-locked')).toBeNull();
    fireEvent.change(f.querySelector<HTMLInputElement>('input[data-field="amount"]')!, { target: { value: '1000' } });
    fireEvent.click(within(f).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].body).toEqual(expect.objectContaining({ amount: 1000, costBasis: 'FLAT' }));
  });

  // Each refusal the server can name, said in its own words (rule 9), the
  // same sentence the toast would say — and no cost sent with the save.
  const reasons: Array<[string, Record<string, string>, string]> = [
    ['LEG_COST_LOCKED_SETTLEMENT', { cycle: 'CYC-1' }, en.errors.LEG_COST_LOCKED_SETTLEMENT.replace('{cycle}', 'CYC-1')],
    ['LEG_COST_LOCKED_LOSSES', { cycle: 'CYC-1' }, en.errors.LEG_COST_LOCKED_LOSSES.replace('{cycle}', 'CYC-1')],
    ['LEG_COST_LOCKED_TRANSFERS', { cycle: 'CYC-1' }, en.errors.LEG_COST_LOCKED_TRANSFERS.replace('{cycle}', 'CYC-1')],
    [
      'LEG_COST_LOCKED_OVERRIDE',
      { cycle: 'CYC-1', product: 'Brake pad' },
      en.errors.LEG_COST_LOCKED_OVERRIDE.replace('{cycle}', 'CYC-1').replace('{product}', 'Brake pad'),
    ],
    [
      'LEG_COST_LOCKED_LEDGER',
      { cycle: 'CYC-1', product: 'Brake pad' },
      en.errors.LEG_COST_LOCKED_LEDGER.replace('{cycle}', 'CYC-1').replace('{product}', 'Brake pad'),
    ],
    ['LEG_COST_LOCKED', { cycle: 'CYC-1' }, en.errors.LEG_COST_LOCKED.replace('{cycle}', 'CYC-1')],
  ];
  for (const [code, params, text] of reasons) {
    it(`locked by ${code}: no cost fields, that reason and the ledger instead — and saving sends no cost at all`, async () => {
      state.received = 5;
      state.cost = { costEditable: false, costLockedReason: code, costLockedParams: params, costChangeRecosts: false };
      wrap();
      fireEvent.click(await screen.findByTestId('edit-leg'));
      const f = form('edit-leg')!;
      const note = await within(f).findByTestId('leg-cost-locked');
      expect(note.textContent).toContain(text);
      expect(within(note).getByRole('link', { name: en.shipments.costLockedLedger }).getAttribute('href')).toBe('/ledger');
      expect(field(f, 'amount')).toBeNull();
      expect(within(f).queryByTestId('leg-cost-recost-warning')).toBeNull();
      fireEvent.click(within(f).getByRole('button', { name: en.common.save }));
      await waitFor(() => expect(state.writes).toHaveLength(1));
      const body = state.writes[0].body!;
      for (const k of ['amount', 'costBasis', 'ratePerUnit', 'currency', 'fxRateToEgp']) expect(body, k).not.toHaveProperty(k);
    });
  }

  it('received, but the server sent no reason (an older API): the general note, still no cost sent', async () => {
    state.received = 5;
    state.cost = { costEditable: false, costLockedReason: null, costLockedParams: {}, costChangeRecosts: false };
    wrap();
    fireEvent.click(await screen.findByTestId('edit-leg'));
    const note = await within(form('edit-leg')!).findByTestId('leg-cost-locked');
    expect(note.textContent).toContain(en.shipments.costLocked);
  });
});

// Owner 2026-10-17: leg 2 was saved at 20 AED × 100 pieces while 230 units went
// on it ("why not force the 230?"). Once the shipment knows what went on the
// leg (40 here), that is the count: shown, not typed. The server sets it the
// same way (deliveries.service.spec), so no caller can save another.
describe('a per-piece cost is for the pieces that travelled on the leg', () => {
  const openPerPiece = async (pieces: number | null) => {
    state.received = 40;
    state.cost = { costEditable: true, costLockedReason: null, costLockedParams: {}, costChangeRecosts: true };
    state.legCost = { costBasis: 'PER_PIECE', ratePerUnit: 20, chargeablePieces: pieces, amount: pieces ? 20 * pieces : 0 };
    wrap();
    fireEvent.click(await screen.findByTestId('edit-leg'));
    const f = form('edit-leg')!;
    await waitFor(() => expect(field(f, 'chargeablePieces')).toBeTruthy());
    return f;
  };

  it('a stored count that disagrees is shown as what travelled, read-only, with the reason', async () => {
    const f = await openPerPiece(100);
    await waitFor(() => expect(field(f, 'chargeablePieces')!.value).toBe('40'));
    expect(field(f, 'chargeablePieces')!.readOnly).toBe(true);
    expect(within(f).getByTestId('leg-pieces-note').textContent).toBe(en.shippingCost.legHasPieces.replace('{count}', '40'));
  });

  it('typing into it changes nothing, and saving sends the leg\'s count', async () => {
    const f = await openPerPiece(null);
    await waitFor(() => expect(field(f, 'chargeablePieces')!.value).toBe('40'));
    fireEvent.change(field(f, 'chargeablePieces')!, { target: { value: '100' } });
    expect(field(f, 'chargeablePieces')!.value).toBe('40');
    fireEvent.click(within(f).getByRole('button', { name: en.common.save }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].body).toEqual(expect.objectContaining({ costBasis: 'PER_PIECE', chargeablePieces: 40, ratePerUnit: 20 }));
  });
});
