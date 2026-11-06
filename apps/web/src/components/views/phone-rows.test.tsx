import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import SuppliersPage from './suppliers-view';
import CategoriesPage from './categories-view';

/**
 * Rows read on a phone (UI audit 2026-11).
 *
 * M5: a supplier's English name on the Arabic phone card is isolated, or its
 * full stop jumps to the front ("Parts Co." → ".Parts Co").
 * M4: a category's name has a line of its own and is never cut, and a page
 * with no expand arrows spends no row width on the slot for one.
 *
 * jsdom lays nothing out, so these pin the structure that decides it.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => ({ locale: 'ar' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ar/suppliers',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/can', () => ({ useCan: () => true }));

const list = vi.hoisted(() => ({ rows: [] as unknown[], meta: {} as Record<string, unknown> }));
vi.mock('@/lib/server-list', () => ({
  useServerList: () => ({
    rows: list.rows,
    total: list.rows.length,
    meta: list.meta,
    isLoading: false,
    reloading: false,
    filtered: false,
    search: '',
    setSearch: vi.fn(),
    clear: vi.fn(),
    page: 1,
    totalPages: 1,
    pageSize: 25,
    setPage: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  list.rows = [];
  list.meta = {};
});

function show(ui: React.ReactNode, locale: 'ar' | 'en' = 'ar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
        <ToastProvider>
          <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{ui}</div>
        </ToastProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('the supplier card on a phone (M5)', () => {
  it("an English name is isolated, full stop included", () => {
    list.rows = [{ id: 's1', name: 'Guangzhou Moto Parts Co.', country: 'CN', contactJson: {} }];
    show(<SuppliersPage />);
    // The desktop table and the phone card both render it; every copy is isolated.
    const names = screen.getAllByText('Guangzhou Moto Parts Co.');
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const el of names) {
      expect(el.tagName).toBe('BDI');
      expect(el.textContent).toBe('Guangzhou Moto Parts Co.');
    }
  });
});

const category = (over: Record<string, unknown>) => ({
  id: 'c', name: 'Helmet Intercom Accessories', nameAr: 'إكسسوارات الإنتركم', parentId: null,
  parent: null, children: [], _count: { products: 2, children: 0 }, depth: 0, ...over,
});

describe('the category row on a phone (M4)', () => {
  it('the name is never truncated and sits on its own line on a phone', () => {
    list.rows = [category({ id: 'c1' })];
    show(<CategoriesPage />, 'en');
    const name = screen.getByText('Helmet Intercom Accessories');
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(name.hasAttribute('title')).toBe(false);
    // A full line below sm, beside the rest from sm up.
    expect(name.className).toMatch(/(?:^|\s)basis-full(?:\s|$)/);
    expect(name.className).toMatch(/(?:^|\s)sm:basis-auto(?:\s|$)/);
    expect(name.className).toMatch(/\bbreak-words\b/);
  });

  it('the other-language name and the badges wrap under it, none cut or pinned', () => {
    list.rows = [category({ id: 'c1' })];
    show(<CategoriesPage />, 'en');
    const text = screen.getByTestId('category-text');
    expect(text.className).toMatch(/\bflex-wrap\b/);
    expect(text.className).toMatch(/\bflex-1\b/);
    expect(text.className).toMatch(/\bmin-w-0\b/);
    const other = within(text).getByTestId('category-other-name');
    expect(other.textContent).toBe('إكسسوارات الإنتركم');
    expect(other.className).not.toMatch(/\btruncate\b/);
    expect(within(text).getByText('Helmet Intercom Accessories')).toBeTruthy();
    for (const badge of text.querySelectorAll('span.rounded-full')) {
      expect(badge.className).not.toMatch(/\bshrink-0\b/);
    }
  });

  it('a page with no expand arrows has no empty slot for one', () => {
    list.rows = [category({ id: 'c1' }), category({ id: 'c2', name: 'Filters', nameAr: null })];
    show(<CategoriesPage />, 'en');
    expect(screen.queryAllByTestId('toggle-children')).toHaveLength(0);
    // Nothing before the tag icon: no 20px blank slot (it carried no test id before).
    for (const row of screen.getAllByTestId('category-row')) {
      expect(row.querySelector(':scope > span.w-5')).toBeNull();
    }
  });

  it('with one arrow on the page, a leaf keeps the slot, so siblings line up', () => {
    list.rows = [
      category({ id: 'p', name: 'Accessories', children: [{ id: 'c1' }] }),
      category({ id: 'c1', depth: 1, parentId: 'p', parent: { id: 'p', name: 'Accessories' } }),
    ];
    list.meta = { parentIds: ['p'] };
    show(<CategoriesPage />, 'en');
    expect(screen.getAllByTestId('toggle-children')).toHaveLength(1);
    expect(screen.getAllByTestId('toggle-slot')).toHaveLength(1);
  });

  it('in Arabic too: the Arabic name leads on its own line, the English follows', () => {
    list.rows = [category({ id: 'c1' })];
    show(<CategoriesPage />);
    const name = screen.getByText('إكسسوارات الإنتركم');
    expect(name.className).toMatch(/(?:^|\s)basis-full(?:\s|$)/);
    expect(name.className).not.toMatch(/\btruncate\b/);
    expect(screen.getByTestId('category-other-name').textContent).toBe('Helmet Intercom Accessories');
  });
});
