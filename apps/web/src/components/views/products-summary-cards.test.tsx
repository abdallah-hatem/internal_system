import { useSyncExternalStore, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import ProductsPage from '@/components/views/products-view';

/**
 * The Products tab's cards follow its filters (owner 2026-10-28: "cards that
 * responds to filter, so when filter by category, it shows number of products
 * in that category, and total number of units as well").
 *
 * The fake server below holds more products than a page and works out the
 * cards' figures itself, from every product the filters match — so a card
 * that added up the rows on screen, or kept the last filter's figures, shows
 * a different number from the one asserted. The filters are changed the way
 * a partner changes them: the status pills clicked, the search typed, the
 * next page clicked; the category as the address carries it (a shared link,
 * the back button).
 */

configure({ asyncUtilTimeout: 5000 });

interface Item {
  id: string;
  sku: string;
  name: string;
  nameAr: string;
  categoryId: string;
  status: 'ACTIVE' | 'INACTIVE';
  onHand: number;
}

const CAT_A = '11111111-1111-4111-8111-111111111111';
const CAT_B = '22222222-2222-4222-8222-222222222222';

/** 12 active in A (1…12 units = 78), 1 inactive in A (40), 2 active in B (5 + 6). */
const ITEMS: Item[] = [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `a${i + 1}`,
    sku: `A-${i + 1}`,
    name: `Brake pad ${i + 1}`,
    nameAr: `تيل فرامل ${i + 1}`,
    categoryId: CAT_A,
    status: 'ACTIVE' as const,
    onHand: i + 1,
  })),
  { id: 'a-off', sku: 'A-OFF', name: 'Old pad', nameAr: 'تيل قديم', categoryId: CAT_A, status: 'INACTIVE', onHand: 40 },
  { id: 'b1', sku: 'B-1', name: 'Helmet', nameAr: 'خوذة', categoryId: CAT_B, status: 'ACTIVE', onHand: 5 },
  { id: 'b2', sku: 'B-2', name: 'Visor', nameAr: 'واقي', categoryId: CAT_B, status: 'ACTIVE', onHand: 6 },
];

type Params = Record<string, string | number>;

const server = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; params: Record<string, string | number> }>,
  /** When set, /products/summary answers wait here until released. */
  hold: null as null | Array<() => void>,
}));

/** Which items the filters match — the server's one where, in miniature. */
function matching(params: Params): Item[] {
  const search = String(params.search ?? '').toLowerCase();
  return ITEMS.filter(
    (p) =>
      (!params.categoryId || p.categoryId === params.categoryId) &&
      (!params.status ||
        (params.status === 'ACTIVE' ? p.status === 'ACTIVE' : p.status !== 'ACTIVE')) &&
      (!search ||
        p.name.toLowerCase().includes(search) ||
        p.nameAr.includes(search) ||
        p.sku.toLowerCase().includes(search)),
  );
}

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string, config: { params?: Params } = {}) => {
      const params = config.params ?? {};
      server.calls.push({ path, params });
      if (path === '/products/summary') {
        const hits = matching(params);
        const body = {
          data: {
            data: { products: hits.length, unitsInStock: hits.reduce((s, p) => s + p.onHand, 0) },
          },
        };
        if (server.hold) {
          const queue = server.hold;
          return new Promise((resolve) => queue.push(() => resolve(body)));
        }
        return Promise.resolve(body);
      }
      if (path === '/products') {
        const hits = matching(params);
        const page = Number(params.page ?? 1);
        const size = Number(params.pageSize ?? 10);
        const rows = hits.slice((page - 1) * size, page * size).map((p) => ({
          ...p,
          category: { id: p.categoryId, name: p.categoryId === CAT_A ? 'Brakes' : 'Helmets' },
          prices: [],
          listPrices: null,
        }));
        return Promise.resolve({
          data: {
            data: rows,
            meta: { page, pageSize: size, total: hits.length, totalPages: Math.ceil(hits.length / size) },
          },
        });
      }
      if (path === '/categories') {
        return Promise.resolve({
          data: { data: [{ id: CAT_A, name: 'Brakes' }, { id: CAT_B, name: 'Helmets' }] },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    },
    post: () => new Promise(() => {}),
    put: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
  },
}));

// The address bar: `router.replace` writes it and the page re-renders, as Next's would.
const nav = vi.hoisted(() => {
  let query = '';
  const listeners = new Set<() => void>();
  return {
    get query() {
      return query;
    },
    set(next: string) {
      query = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
});
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(nav.subscribe, () => nav.query)),
  usePathname: () => '/en/products',
  useParams: () => ({ locale: 'en' }),
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: (url: string) => nav.set(url.split('?')[1] ?? ''),
  }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
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
  nav.set('');
  server.calls.length = 0;
  server.hold = null;
});
afterEach(() => cleanup());

function open(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ProductsPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The two figures on the cards, as shown: [products, units]. */
async function figures() {
  const strip = await screen.findByTestId('products-summary');
  const [products, units] = within(strip).getAllByTestId('summary-card');
  const value = (card: HTMLElement) => card.querySelector('[data-testid="summary-card-value"]')?.textContent
    ?? card.textContent ?? '';
  return [value(products), value(units)];
}

/** Waits until the cards say these figures. */
const cardsSay = (products: string, units: string) =>
  waitFor(async () => {
    const [p, u] = await figures();
    expect(p).toContain(products);
    expect(u).toContain(units);
  });

const summaryCalls = () => server.calls.filter((c) => c.path === '/products/summary');
const listCalls = () => server.calls.filter((c) => c.path === '/products');
const withoutPaging = (params: Params) =>
  Object.fromEntries(Object.entries(params).filter(([name]) => !['page', 'pageSize', 'sort'].includes(name)));

describe('the Products tab’s cards follow its filters', () => {
  it('opens on Active: 14 products and 89 units — every match, not the 10 rows of the first page (55 + …)', async () => {
    open();
    // 12 + 2 active; units 78 + 11. The first page alone holds 10 rows / 55 units.
    await cardsSay('14', '89');
    expect(screen.getAllByTestId('product-on-hand')).toHaveLength(10);
    // The cards asked for exactly what the table asked for, less its page.
    expect(withoutPaging(summaryCalls().at(-1)!.params)).toEqual(withoutPaging(listCalls().at(-1)!.params));
    expect(summaryCalls().at(-1)!.params).toEqual({ status: 'ACTIVE' });
  });

  it('a category: its count and units; its inactive product only once the status filter takes it in', async () => {
    nav.set(`category=${CAT_A}`);
    open();
    await cardsSay('12', '78');
    fireEvent.click(within(screen.getByTestId('status-filter')).getByRole('button', { name: en.products.inactive }));
    await cardsSay('1', '40');
    fireEvent.click(within(screen.getByTestId('status-filter')).getByRole('button', { name: en.products.filterAll }));
    await cardsSay('13', '118');
    // All sends an empty status, as the table does; the server reads it as no filter.
    expect(summaryCalls().at(-1)!.params).toEqual({ categoryId: CAT_A, status: '' });
    expect(withoutPaging(summaryCalls().at(-1)!.params)).toEqual(withoutPaging(listCalls().at(-1)!.params));
  });

  it('search, typed in English and in Arabic, reaches the cards', async () => {
    open();
    await cardsSay('14', '89');
    const box = screen.getByRole('textbox', { name: en.products.search });
    fireEvent.change(box, { target: { value: 'helmet' } });
    await cardsSay('1', '5');
    expect(summaryCalls().at(-1)!.params).toMatchObject({ search: 'helmet' });
    fireEvent.change(box, { target: { value: 'تيل' } });
    await cardsSay('12', '78');
    expect(summaryCalls().at(-1)!.params).toMatchObject({ search: 'تيل' });
  });

  it('nothing matches: the cards say 0 and 0, they do not vanish or keep the last figures', async () => {
    open();
    await cardsSay('14', '89');
    fireEvent.change(screen.getByRole('textbox', { name: en.products.search }), { target: { value: 'no such part' } });
    await cardsSay('0', '0');
  });

  it('another page changes the rows, never the cards — and asks for no new figures', async () => {
    open();
    await cardsSay('14', '89');
    const asked = summaryCalls().length;
    fireEvent.click(screen.getByRole('button', { name: en.pagination.next }));
    await waitFor(() => expect(screen.getAllByTestId('product-on-hand')).toHaveLength(4));
    await cardsSay('14', '89');
    expect(summaryCalls()).toHaveLength(asked);
  });

  it('skeletons while the figures load', async () => {
    server.hold = [];
    open();
    expect(await screen.findByTestId('products-summary-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('products-summary')).toBeNull();
    await act(async () => server.hold!.splice(0).forEach((go) => go()));
    await cardsSay('14', '89');
    expect(screen.queryByTestId('products-summary-skeleton')).toBeNull();
  });

  it('the second visit: after the filter changes, the last filter’s figures are never shown under it — skeletons until its own arrive; back again shows that filter’s own', async () => {
    open();
    await cardsSay('14', '89');
    server.hold = [];
    nav.set(`category=${CAT_B}`); // a link, or the back button
    // While category B's figures are on their way, the cards do not say 14 / 89.
    expect(await screen.findByTestId('products-summary-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('products-summary')).toBeNull();
    await act(async () => server.hold!.splice(0).forEach((go) => go()));
    await cardsSay('2', '11');
    // And back to every category: that filter's own figures, not B's.
    server.hold = null;
    nav.set('');
    await cardsSay('14', '89');
  });

  it('in Arabic: the cards’ words are Arabic', async () => {
    open('ar');
    const strip = await screen.findByTestId('products-summary');
    await waitFor(() => expect(strip.textContent).toContain(ar.tabSummary.productsMatchSub));
    expect(strip.textContent).toContain(ar.tabSummary.unitsInStock);
    expect(strip.textContent).toContain(ar.tabSummary.unitsHeldSub);
  });
});
