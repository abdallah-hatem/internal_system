import { type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import {
  EditOrderButton,
  EditOrderDialog,
  canOfferOrderEdit,
  changedLines,
  currentLines,
  type EditSale,
} from './edit-order';

/**
 * The Edit order popup on a confirmed sale (BUSINESS_LOGIC §4 "Editing a
 * confirmed order", owner 2026-10-25). The rules are the server's
 * (order-edit.db.spec.ts); this checks the popup sends only what was changed,
 * never replaces what was typed, shows the server's preview and refusals in
 * the reader's language, and saves at the version it previewed, once.
 */

type Refusal = { code: string; message: string; params?: Record<string, string | number> };
type Body = { editedOn: string; lines: { productId: string; quantity: number; unitPrice?: number }[]; version?: number };

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  history: null as unknown,
  previewRefusal: null as ((body: Body) => Refusal | null) | null,
  posts: [] as { url: string; body: Body }[],
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
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/sales/orders/sale-1/history') return Promise.resolve({ data: { data: state.history } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: Body) => {
      state.posts.push({ url, body });
      const refusal = state.previewRefusal?.(body) ?? null;
      if (refusal) return Promise.reject({ response: { status: 400, data: { error: refusal } } });
      return Promise.resolve({
        data: {
          data: {
            version: 7,
            editedOn: body.editedOn,
            lines: body.lines.map((l) => ({
              productId: l.productId,
              product: l.productId,
              productAr: null,
              qtyBefore: '10',
              qtyAfter: String(l.quantity),
              priceBefore: '1250.00',
              priceAfter: (l.unitPrice ?? 1250).toFixed(2),
            })),
            stockTaken: [],
            stockBack: [],
            changeEgp: '1250.00',
            owedBefore: '7500.00',
            owedAfter: '8750.00',
            profitChangeEgp: '300.00',
          },
        },
      });
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

const row = (saleItemId: string, productId: string, holds: string, priceNow: string, addedOn: string | null = null) => ({
  saleItemId,
  productId,
  product: productId,
  productAr: null,
  startedWith: holds,
  returned: '0',
  holds,
  soldAt: priceNow,
  priceNow,
  addedOn,
});

const HISTORY = {
  orderId: 'sale-1',
  orderNo: 'ORD-2026-00009',
  status: 'PARTIALLY_PAID',
  events: [],
  products: [row('si-1', 'helmet', '10', '1250.00'), row('si-2', 'gloves', '0', '1000.00')],
  owes: '7500.00',
  replayedOwes: '7500.00',
};

const SALE: EditSale = {
  id: 'sale-1',
  orderNo: 'ORD-2026-00009',
  status: 'PARTIALLY_PAID',
  currency: 'EGP',
  orderedAt: '2026-10-01T10:00:00.000Z',
  contractPlan: null,
};

beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.history = structuredClone(HISTORY);
  state.previewRefusal = null;
  state.posts = [];
});
afterEach(() => cleanup());

function wrap(node: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const dialog = () => screen.getByTestId('edit-order-dialog');
const previews = () => state.posts.filter((p) => p.url.endsWith('/edits/preview'));
const saves = () => state.posts.filter((p) => p.url.endsWith('/edits'));

async function open(locale: 'en' | 'ar' = 'en') {
  const onClose = vi.fn();
  wrap(<EditOrderDialog sale={SALE} products={[]} stock={[]} onClose={onClose} />, locale);
  await waitFor(() => expect(within(dialog()).getByTestId('edit-line-helmet')).toBeTruthy());
  return { onClose };
}

function typeQty(productId: string, value: string) {
  const input = within(screen.getByTestId(`edit-line-${productId}`)).getByTestId('edit-qty') as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('which sales offer Edit order', () => {
  it('confirmed, partly paid and paid sales — not a walk-in, not any other status', () => {
    for (const status of ['CONFIRMED', 'PARTIALLY_PAID', 'PAID']) expect(canOfferOrderEdit({ status })).toBe(true);
    for (const status of ['DRAFT', 'CANCELLED', 'RETURNED', 'SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF']) {
      expect(canOfferOrderEdit({ status })).toBe(false);
    }
    expect(canOfferOrderEdit({ status: 'PAID', customer: { isWalkIn: true } })).toBe(false);
  });

  it('only for a core partner', () => {
    state.role = 'ADMIN_SUPPORT';
    wrap(<EditOrderButton sale={SALE} onOpen={vi.fn()} />);
    expect(screen.queryByTestId('order-edit')).toBeNull();
    cleanup();
    state.role = 'CORE_PARTNER';
    const onOpen = vi.fn();
    wrap(<EditOrderButton sale={SALE} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('order-edit'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('what is sent', () => {
  it('one line per product: an added line of the same product is summed into it, a fully returned product is not offered', () => {
    const lines = currentLines([
      row('si-1', 'helmet', '10', '1250.00'),
      row('si-3', 'helmet', '2', '1300.00', '2026-10-20'),
      row('si-2', 'gloves', '0', '1000.00'),
    ]);
    expect(lines).toEqual([
      { productId: 'helmet', product: 'helmet', productAr: null, holds: 12, priceNow: '1300.00' },
    ]);
  });

  it('only what changed: an untouched line, or a price typed back to what it is, is not sent', () => {
    const cur = [{ productId: 'helmet', product: 'helmet', holds: 10, priceNow: '1250.00' }];
    expect(changedLines(cur, {}, {}, [])).toEqual([]);
    expect(changedLines(cur, { helmet: '10' }, { helmet: '1250' }, [])).toEqual([]);
    expect(changedLines(cur, { helmet: '0' }, {}, [])).toEqual([{ productId: 'helmet', quantity: 0 }]);
    expect(changedLines(cur, {}, { helmet: '1300' }, [])).toEqual([
      { productId: 'helmet', quantity: 10, unitPrice: 1300 },
    ]);
    expect(changedLines(cur, {}, {}, ['gloves'])).toEqual([{ productId: 'gloves', quantity: 1 }]);
  });
});

describe('the popup', () => {
  it('shows the server’s preview of the whole edit, then saves exactly that at the version previewed, once', async () => {
    const { onClose } = await open();
    expect(within(dialog()).getByTestId('edit-preview-empty')).toBeTruthy();
    typeQty('helmet', '11');
    await waitFor(() => expect(within(dialog()).getByTestId('edit-preview-owes').textContent).toMatch(/8,750\.00/));
    expect(previews().at(-1)!.body.lines).toEqual([{ productId: 'helmet', quantity: 11 }]);
    const save = within(dialog()).getByTestId('edit-order-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saves()).toHaveLength(1);
    expect(saves()[0].body).toMatchObject({ version: 7, lines: [{ productId: 'helmet', quantity: 11 }] });
  });

  it('what was typed is never replaced when the history is fetched again', async () => {
    await open();
    const input = typeQty('helmet', '9');
    state.history = { ...structuredClone(HISTORY), products: [row('si-1', 'helmet', '8', '1250.00')] };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(input.value).toBe('9');
  });

  it('a refusal is the server’s, in the reader’s language, and Save stays off', async () => {
    state.previewRefusal = () => ({
      code: 'EDIT_ORDER_BELOW_PAID',
      message: 'english',
      params: { order: 'ORD-2026-00009', amount: '8750.00', owed: '7500.00' },
    });
    await open('ar');
    typeQty('helmet', '3');
    await waitFor(() => expect(within(dialog()).getByTestId('edit-order-refusal').textContent).toContain('سيصبح أقل مما دُفع'));
    expect((within(dialog()).getByTestId('edit-order-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
