import { useState, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { businessToday } from '@/lib/dates';
import {
  AdjustPriceButton,
  AdjustPriceDialog,
  PRICE_ADJUSTMENT_INVALIDATES,
  canOfferPriceAdjustment,
  type AdjustSale,
} from './adjust-price';

/**
 * The Adjust price popup on a confirmed sale (BUSINESS_LOGIC §4 "Lowering a
 * price after the order is confirmed", owner 2026-10-22). The rules are the
 * server's (price-adjustment.db.spec.ts); this checks that the popup shows the
 * server's own preview as the person types, says its refusals in the reader's
 * language, never replaces what was typed, sends once, and opens clean.
 */

type Refusal = { code: string; message: string; params?: Record<string, string | number> };

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  history: null as unknown,
  /** Answers the preview: a refusal, or null to compute one. */
  previewRefusal: null as ((body: { newUnitPrice: number }) => Refusal | null) | null,
  /** What the save answers; undefined computes a success. */
  saveAnswer: undefined as undefined | (() => Promise<unknown>),
  posts: [] as { url: string; body: { saleItemId: string; newUnitPrice: number; adjustedOn: string; reason?: string } }[],
  gets: [] as string[],
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const PRICE: Record<string, number> = { 'si-q58': 1250, 'si-y30': 1200 };
const HELD: Record<string, number> = { 'si-q58': 3, 'si-y30': 10 };
const OWED = 22250;

function computed(body: { saleItemId: string; newUnitPrice: number; adjustedOn: string }) {
  const cut = (PRICE[body.saleItemId] - body.newUnitPrice) * HELD[body.saleItemId];
  return {
    saleItemId: body.saleItemId,
    product: body.saleItemId,
    adjustedOn: body.adjustedOn,
    previousUnitPrice: PRICE[body.saleItemId].toFixed(2),
    newUnitPrice: body.newUnitPrice.toFixed(2),
    qty: String(HELD[body.saleItemId]),
    amountEgp: cut.toFixed(2),
    owedBefore: OWED.toFixed(2),
    owedAfter: (OWED - cut).toFixed(2),
  };
}

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      state.gets.push(url);
      if (url === '/sales/orders/sale-1/history') return Promise.resolve({ data: { data: state.history } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: (typeof state.posts)[number]['body']) => {
      state.posts.push({ url, body });
      const refusal = state.previewRefusal?.(body) ?? null;
      if (refusal) return Promise.reject({ response: { status: 400, data: { error: refusal } } });
      if (url.endsWith('/price-adjustments') && state.saveAnswer) return state.saveAnswer();
      return Promise.resolve({ data: { data: computed(body) } });
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

const product = (id: string, name: string, holds: string, priceNow: string, nameAr: string | null = null) => ({
  saleItemId: id,
  product: name,
  productAr: nameAr,
  startedWith: '10',
  returned: String(10 - Number(holds)),
  holds,
  soldAt: priceNow,
  priceNow,
});

const HISTORY = {
  orderId: 'sale-1',
  orderNo: 'ORD-2026-00002',
  status: 'PARTIALLY_PAID',
  events: [],
  products: [
    product('si-q58', 'Q58', '3', '1250.00', 'كيو 58'),
    product('si-gone', 'Y20 MAX', '0', '1150.00'),
    product('si-y30', 'Y30', '10', '1200.00'),
  ],
  owes: '22250.00',
  replayedOwes: '22250.00',
};

const SALE: AdjustSale = {
  id: 'sale-1',
  orderNo: 'ORD-2026-00002',
  status: 'PARTIALLY_PAID',
  currency: 'EGP',
  orderedAt: '2026-10-01T10:00:00.000Z',
  contractPlan: null,
};

beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.history = structuredClone(HISTORY);
  state.previewRefusal = null;
  state.saveAnswer = undefined;
  state.posts = [];
  state.gets = [];
});
afterEach(() => cleanup());

let client: QueryClient;
function wrap(node: ReactNode, locale: 'en' | 'ar' = 'en') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{node}</div>
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const dialog = () => screen.getByTestId('adjust-price-dialog');
const priceInput = () => within(dialog()).getByTestId('adjust-price-input') as HTMLInputElement;
const saveButton = () => within(dialog()).getByTestId('adjust-price-save') as HTMLButtonElement;
const previews = () => state.posts.filter((p) => p.url.endsWith('/preview'));
const saves = () => state.posts.filter((p) => p.url.endsWith('/price-adjustments'));

async function open(sale: AdjustSale = SALE, locale: 'en' | 'ar' = 'en') {
  const onClose = vi.fn();
  wrap(<AdjustPriceDialog sale={sale} onClose={onClose} />, locale);
  await waitFor(() => expect(within(dialog()).getByRole('combobox')).toBeTruthy());
  return { onClose };
}

async function pickLine(name: string) {
  fireEvent.click(within(dialog()).getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

/** Types into the price field the way a person does: focus, then keystrokes. */
function typePrice(text: string) {
  const input = priceInput();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}

const text = (id: string) => within(dialog()).getByTestId(id).textContent ?? '';

describe('which sales offer Adjust price', () => {
  it('a confirmed or partly paid sale', () => {
    expect(canOfferPriceAdjustment({ status: 'CONFIRMED' })).toBe(true);
    expect(canOfferPriceAdjustment({ status: 'PARTIALLY_PAID' })).toBe(true);
  });

  it.each(['DRAFT', 'PAID', 'CANCELLED', 'RETURNED', 'SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF'])(
    'not a %s one — the server would refuse it up front',
    (status) => {
      expect(canOfferPriceAdjustment({ status })).toBe(false);
      wrap(<AdjustPriceButton sale={{ ...SALE, status }} onOpen={vi.fn()} />);
      expect(screen.queryByTestId('order-adjust-price')).toBeNull();
    },
  );

  it('not for a role the server refuses, and it opens the popup for a partner', () => {
    state.role = 'ADMIN_SUPPORT';
    wrap(<AdjustPriceButton sale={SALE} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('order-adjust-price')).toBeNull();
    cleanup();

    state.role = 'CORE_PARTNER';
    const onOpen = vi.fn();
    wrap(<AdjustPriceButton sale={SALE} onOpen={onOpen} />);
    const button = screen.getByTestId('order-adjust-price');
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('the line picker', () => {
  it('lists only the lines the shop still holds, each with units held and its price now', async () => {
    await open();
    fireEvent.click(within(dialog()).getByRole('combobox'));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options.join('|')).not.toContain('Y20 MAX');
    expect(options[0]).toContain('Q58');
    expect(options[0]).toContain('3 held');
    expect(options[0]).toContain('1,250.00');
    expect(options[1]).toContain('10 held');
  });

  it('with nothing held anywhere, says so and offers no Save that could work', async () => {
    state.history = { ...HISTORY, products: [product('si-gone', 'Y20 MAX', '0', '1150.00')] };
    wrap(<AdjustPriceDialog sale={SALE} onClose={vi.fn()} />);
    expect(await screen.findByTestId('adjust-price-no-lines')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('a sale under an instalment contract is refused before anything is typed, with the reason', async () => {
    wrap(
      <AdjustPriceDialog
        sale={{ ...SALE, contractPlan: { reference: 'PLAN-2026-0001', status: 'ACTIVE' } }}
        onClose={vi.fn()}
      />,
    );
    const blocked = await screen.findByTestId('adjust-price-blocked');
    expect(blocked.textContent).toContain('PLAN-2026-0001');
    expect(blocked.textContent).toContain('Cancel the contract');
    expect(screen.queryByTestId('adjust-price-save')).toBeNull();
    expect(previews()).toHaveLength(0);
  });
});

describe('the preview', () => {
  it("shows the server's figures and follows the price as it is typed", async () => {
    await open();
    await pickLine('Q58');
    expect(within(dialog()).getByTestId('adjust-preview-empty')).toBeTruthy();

    typePrice('1150');
    await waitFor(() => expect(text('adjust-preview-cut')).toContain('300.00'));
    expect(text('adjust-preview-units')).toBe('3');
    expect(text('adjust-preview-owes')).toContain('22,250.00');
    expect(text('adjust-preview-owes')).toContain('21,950.00');
    expect(previews().at(-1)?.body).toMatchObject({ saleItemId: 'si-q58', newUnitPrice: 1150, adjustedOn: businessToday() });

    typePrice('1000');
    await waitFor(() => expect(text('adjust-preview-cut')).toContain('750.00'));
    expect(text('adjust-preview-owes')).toContain('21,500.00');
  });

  it('asks once the typing pauses, not on every keystroke', async () => {
    await open();
    await pickLine('Q58');
    for (const partial of ['1', '11', '115', '1150']) typePrice(partial);
    await waitFor(() => expect(text('adjust-preview-cut')).toContain('300.00'));
    expect(previews().map((p) => p.body.newUnitPrice)).toEqual([1150]);
  });

  it('a price typed is never overwritten when the order and its history are refetched', async () => {
    await open();
    await pickLine('Q58');
    typePrice('1100');
    await waitFor(() => expect(text('adjust-preview-cut')).toContain('450.00'));

    // Someone else lowers it meanwhile: the refetched history says 1,200 now.
    state.history = {
      ...HISTORY,
      products: [product('si-q58', 'Q58', '3', '1200.00'), product('si-y30', 'Y30', '10', '1200.00')],
    };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sale', 'sale-1'] });
    });
    await waitFor(() => expect(text('adjust-price-current')).toContain('1,200.00'));
    expect(priceInput().value).toBe('1,100');
    expect(state.gets.filter((g) => g.endsWith('/history')).length).toBeGreaterThanOrEqual(2);
    // And it is what is asked and sent — not a value swapped in behind the field.
    await new Promise((r) => setTimeout(r, 500));
    expect(previews().map((p) => p.body.newUnitPrice)).toEqual([1100]);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body.newUnitPrice).toBe(1100);
  });

  it.each([
    [
      'a price above the current one',
      '1300',
      { code: 'PRICE_ADJUSTMENT_NOT_LOWER', message: 'x', params: { product: 'Q58', current: '1250.00', price: '1300.00' } },
      'Q58 is at 1250.00 a unit; a price can only be lowered here.',
    ],
    [
      'the same price',
      '1250',
      { code: 'PRICE_ADJUSTMENT_NOT_LOWER', message: 'x', params: { product: 'Q58', current: '1250.00', price: '1250.00' } },
      'a price can only be lowered here',
    ],
    [
      'zero, when that is more off than the order owes',
      '0',
      {
        code: 'PRICE_ADJUSTMENT_EXCEEDS_OWED',
        message: 'x',
        params: { product: 'Q58', amount: '3750.00', owed: '500.00', order: 'ORD-2026-00002' },
      },
      'owes only 500.00',
    ],
    [
      'a price the server cannot read',
      '5',
      { code: 'PRICE_ADJUSTMENT_BAD_PRICE', message: 'x', params: { value: 'x' } },
      'The new price must be a number, zero or more.',
    ],
  ])("%s shows the server's coded refusal and Save stays off", async (_name, typed, refusal, said) => {
    state.previewRefusal = () => refusal;
    await open();
    await pickLine('Q58');
    typePrice(typed);
    await waitFor(() => expect(text('adjust-price-refusal')).toContain(said));
    expect(saveButton().disabled).toBe(true);
  });

  it('a minus sign never reaches the server: the field holds an amount, nothing below zero', async () => {
    await open();
    await pickLine('Q58');
    typePrice('-100');
    await waitFor(() => expect(previews().length).toBe(1));
    expect(priceInput().value).toBe('100');
    expect(previews()[0].body.newUnitPrice).toBe(100);
  });

  it('says a refusal in Arabic on /ar', async () => {
    state.previewRefusal = () => ({
      code: 'PRICE_ADJUSTMENT_NOT_LOWER',
      message: 'Q58 is at 1250.00 a unit; a price can only be lowered here.',
      params: { product: 'Q58', current: '1250.00', price: '1300.00' },
    });
    await open(SALE, 'ar');
    // On /ar the line is named in Arabic where it has an Arabic name.
    await pickLine('كيو 58');
    typePrice('1300');
    await waitFor(() => expect(text('adjust-price-refusal')).toContain('هنا يمكن تخفيض السعر فقط'));
    expect(text('adjust-price-refusal')).not.toContain('can only be lowered');
  });

  it('an order paid up meanwhile is refused with its status said in Arabic, not the code', async () => {
    state.previewRefusal = () => ({
      code: 'PRICE_ADJUSTMENT_ORDER_NOT_OPEN',
      message: 'Only a confirmed sale that is still owed can have its price lowered. ORD-2026-00002 is PAID.',
      params: { order: 'ORD-2026-00002', status: 'PAID' },
    });
    await open(SALE, 'ar');
    await pickLine('كيو 58');
    typePrice('1100');
    await waitFor(() => expect(text('adjust-price-refusal')).toContain('مدفوع'));
    expect(text('adjust-price-refusal')).not.toContain('PAID');
  });
});

describe('the day', () => {
  it('opens on Cairo today, and a future day cannot be picked', async () => {
    await open();
    const trigger = document.getElementById('adjust-day') as HTMLButtonElement;
    fireEvent.click(trigger);
    const today = businessToday();
    const todayCell = document.querySelector<HTMLButtonElement>(`[data-day="${today}"]`);
    expect(todayCell?.disabled).toBe(false);
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = document.querySelector<HTMLButtonElement>(`[data-day="${next.toISOString().slice(0, 10)}"]`);
    // Shown only when tomorrow falls in this month's grid; when shown, it is off.
    if (tomorrow) expect(tomorrow.disabled).toBe(true);
  });

  it('a day before the sale cannot be picked either (the server refuses it: PRICE_ADJUSTMENT_BEFORE_SALE)', async () => {
    const today = businessToday();
    // Sold yesterday (Cairo): yesterday is pickable, the day before is not.
    const day = (n: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    await open({ ...SALE, orderedAt: `${day(-1)}T10:00:00Z` });
    fireEvent.click(document.getElementById('adjust-day') as HTMLButtonElement);
    const cell = (iso: string) => document.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`);
    if (cell(day(-1))) expect(cell(day(-1))!.disabled).toBe(false);
    if (cell(day(-2))) expect(cell(day(-2))!.disabled).toBe(true);
  });
});

describe('saving', () => {
  it('sends once, busy and disabled while it runs, and Cancel waits too', async () => {
    let finish: (v: unknown) => void = () => {};
    state.saveAnswer = () => new Promise((resolve) => (finish = resolve));
    await open();
    await pickLine('Q58');
    typePrice('1150');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(saveButton().getAttribute('type')).toBe('submit');

    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect((within(dialog()).getByRole('button', { name: en.common.cancel }) as HTMLButtonElement).disabled).toBe(true);
    expect(saves()).toHaveLength(1);
    expect(saves()[0].body).toMatchObject({ saleItemId: 'si-q58', newUnitPrice: 1150 });
    await act(async () => finish({ data: { data: computed(saves()[0].body) } }));
  });

  it('sends the note when one is written, trimmed', async () => {
    await open();
    await pickLine('Q58');
    fireEvent.change(within(dialog()).getByTestId('adjust-price-note'), { target: { value: '  100 off, agreed  ' } });
    typePrice('1150');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0].body.reason).toBe('100 off, agreed');
  });

  it('on success refreshes exactly what changes, says so, and closes', async () => {
    const { onClose } = await open();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await pickLine('Q58');
    typePrice('1150');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const keys = spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    for (const key of PRICE_ADJUSTMENT_INVALIDATES('sale-1')) expect(keys).toContain(JSON.stringify(key));
    expect(keys).toContain(JSON.stringify(['sale', 'sale-1']));
    expect(keys).toContain(JSON.stringify(['customer']));
    expect(keys).toContain(JSON.stringify(['analytics']));
    // Stock and payments do not move.
    expect(keys).not.toContain(JSON.stringify(['inventory']));
    expect(keys).not.toContain(JSON.stringify(['payments']));
    expect(await screen.findByText(/Price lowered\. ORD-2026-00002 now owes 21,950\.00/)).toBeTruthy();
  });

  it('a refusal at save time is said, and the popup stays open with what was typed', async () => {
    // The preview passes; the save is refused (the cycle went into settlement meanwhile).
    state.previewRefusal = () =>
      saves().length > 0
        ? { code: 'PRICE_ADJUSTMENT_CYCLE_SETTLED', message: 'x', params: { cycle: 'CYC-2026-0001' } }
        : null;
    const { onClose } = await open();
    await pickLine('Q58');
    typePrice('1150');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    expect(await screen.findByText(/cycle CYC-2026-0001, which is being settled/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(priceInput().value).toBe('1,150');
  });
});

describe('a second open', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
          open
        </button>
        {open && <AdjustPriceDialog sale={SALE} onClose={() => setOpen(false)} />}
      </>
    );
  }

  it.each([
    ['Cancel', () => fireEvent.click(within(dialog()).getByRole('button', { name: en.common.cancel }))],
    ['the X', () => fireEvent.click(within(dialog()).getByRole('button', { name: en.common.close }))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('starts clean after closing with %s', async (_name, close) => {
    wrap(<Harness />);
    fireEvent.click(screen.getByTestId('opener'));
    await waitFor(() => expect(within(dialog()).getByRole('combobox')).toBeTruthy());
    await pickLine('Y30');
    typePrice('900');
    fireEvent.change(within(dialog()).getByTestId('adjust-price-note'), { target: { value: 'gone' } });
    await waitFor(() => expect(text('adjust-preview-cut')).toContain('3,000.00'));

    close();
    await waitFor(() => expect(screen.queryByTestId('adjust-price-dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('opener'));
    await waitFor(() => expect(within(dialog()).getByRole('combobox')).toBeTruthy());
    expect(priceInput().value).toBe('');
    expect((within(dialog()).getByTestId('adjust-price-note') as HTMLTextAreaElement).value).toBe('');
    expect(within(dialog()).getByRole('combobox').textContent).toContain(en.sales.adjustPrice.linePlaceholder);
    expect(within(dialog()).getByTestId('adjust-preview-empty')).toBeTruthy();
  });
});
