import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import ProductsPage from '@/components/views/products-view';
import ProductDetailPage from '@/app/[locale]/products/[id]/page';

/**
 * A product's default price on the office screens (BUSINESS_LOGIC §3, owner
 * 2026-10-18): where no price is set, the API sends landed + 20% as a DEFAULT,
 * and the screen shows it with "Default (landed + 20%)" under it. A set price
 * is shown bare. The server's rule is pinned in apps/api (default-price.spec);
 * this is what a partner sees of it.
 */

const state = vi.hoisted(() => ({ role: 'CORE_PARTNER' as string }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prod-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/en/products',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

// B2B: nothing set, landed 100 → the default 120. B2C: set at 150.
const product = {
  id: 'prod-1', sku: 'BRK-1', name: 'Brake pad', status: 'ACTIVE', minStock: 2, onHand: 5,
  category: { id: 'cat-1', name: 'Brakes' }, categoryId: 'cat-1',
  prices: [
    { id: 'pr-2', channel: 'B2C', amount: 150, currency: 'EGP', effectiveFrom: '2026-09-01', effectiveTo: null },
  ],
  listPrices: {
    B2B: { amount: '120.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
    B2C: { amount: '150.00', currency: 'EGP', source: 'SET' },
  },
};

// The mirror case: B2B set at 150, B2C has nothing set → the default 120.
// Both channels default the same way (owner 2026-10-18).
const b2cDefaultProduct = {
  ...product,
  prices: [
    { id: 'pr-1', channel: 'B2B', amount: 150, currency: 'EGP', effectiveFrom: '2026-09-01', effectiveTo: null },
  ],
  listPrices: {
    B2B: { amount: '150.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '120.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
  },
};
const fixture = vi.hoisted(() => ({ current: null as unknown }));

const post = vi.fn(() => new Promise(() => {}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/products/prod-1') return Promise.resolve({ data: { data: fixture.current ?? product } });
      if (url === '/products') return Promise.resolve({ data: { data: [product] } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (...args: unknown[]) => post(...(args as [])),
    put: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  URL.createObjectURL ??= () => 'blob:x';
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  cleanup();
  post.mockClear();
  fixture.current = null;
});

function wrap(ui: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('the products list', () => {
  // Since 2026-10-21 (owner) a small "Default" tag on the price's own line, the
  // full wording on hover and for a screen reader, so every row is one line tall.
  it('a channel with no price set shows the default with its tag; a set one shows bare', async () => {
    wrap(<ProductsPage />);
    await screen.findAllByText('BRK-1');
    const hints = screen.getAllByTestId('default-price-hint');
    // Once per place the B2B price is shown (the table and the phone card),
    // never for B2C.
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h.textContent).toBe('Default');
      expect(h.getAttribute('title')).toBe('Default (landed + 20%)');
      expect(h.getAttribute('aria-label')).toBe('Default (landed + 20%)');
      // Beside the price, not under it.
      expect(h.parentElement?.className).toContain('inline-flex');
      expect(h.parentElement?.textContent).toMatch(/120\.00/);
      expect(h.parentElement?.textContent).not.toMatch(/150\.00/);
    }
    expect(screen.getAllByText(/150\.00/).length).toBeGreaterThan(0);
  });

  it('in Arabic, the hint is Arabic', async () => {
    wrap(<ProductsPage />, 'ar');
    await screen.findAllByText('BRK-1');
    for (const h of screen.getAllByTestId('default-price-hint')) {
      expect(h.textContent).toBe('افتراضي');
      expect(h.getAttribute('title')).toBe('افتراضي (التكلفة الإجمالية + 20٪)');
    }
  });
});

describe('the product page, B2B price card', () => {
  it('a partner sees the default under an empty field — shown, not filled in, so nothing is saved by it', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<ProductDetailPage />);
    const line = await screen.findByTestId('default-price');
    expect(line.textContent).toMatch(/120\.00/);
    expect(within(line).getByTestId('default-price-hint').textContent).toBe('Default (landed + 20%)');
    // The B2B field is empty, and so is its placeholder: grey "120" read as a typed
    // price (2026-10-22). Save is off until a price is typed.
    const card = line.parentElement!;
    const input = card.querySelector('input')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('');
    expect(within(card).getByTestId('set-price-action').hasAttribute('disabled')).toBe(true);
    expect(post).not.toHaveBeenCalledWith(expect.stringMatching(/\/prices$/), expect.anything());
    // Only one hint on the page: the set B2C price carries none.
    expect(screen.getAllByTestId('default-price-hint')).toHaveLength(1);
  });

  it('a reader without the right to set it sees the default figure and the hint', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<ProductDetailPage />);
    const readonly = await screen.findAllByTestId('price-readonly');
    const b2b = readonly.find((el) => el.textContent?.includes('120.00'))!;
    expect(b2b).toBeTruthy();
    expect(within(b2b).getByTestId('default-price-hint').textContent).toBe('Default (landed + 20%)');
    const b2c = readonly.find((el) => el.textContent?.includes('150.00'));
    if (b2c) expect(within(b2c).queryByTestId('default-price-hint')).toBeNull();
    state.role = 'CORE_PARTNER';
  });
});

describe('the product page, B2C price card', () => {
  it('a B2C channel with no price set shows the default under an empty field, like B2B does', async () => {
    state.role = 'CORE_PARTNER';
    fixture.current = b2cDefaultProduct;
    wrap(<ProductDetailPage />);
    const line = await screen.findByTestId('default-price');
    expect(line.textContent).toMatch(/120\.00/);
    expect(within(line).getByTestId('default-price-hint').textContent).toBe('Default (landed + 20%)');
    const card = line.parentElement!;
    // It is the B2C card, not the B2B one.
    expect(card.textContent).toContain(en.products.b2cPrice);
    const input = card.querySelector('input')!;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('');
    expect(within(card).getByTestId('set-price-action').hasAttribute('disabled')).toBe(true);
    expect(post).not.toHaveBeenCalledWith(expect.stringMatching(/\/prices$/), expect.anything());
    // The set B2B price carries no hint: one hint on the page.
    expect(screen.getAllByTestId('default-price-hint')).toHaveLength(1);
  });

  it('a reader sees the B2C default with the hint, and the set B2B price bare', async () => {
    state.role = 'TEMP_INVESTOR';
    fixture.current = b2cDefaultProduct;
    wrap(<ProductDetailPage />);
    const readonly = await screen.findAllByTestId('price-readonly');
    const b2c = readonly.find((el) => el.textContent?.includes('120.00'))!;
    expect(b2c).toBeTruthy();
    expect(within(b2c).getByTestId('default-price-hint').textContent).toBe('Default (landed + 20%)');
    const b2b = readonly.find((el) => el.textContent?.includes('150.00'))!;
    expect(b2b).toBeTruthy();
    expect(within(b2b).queryByTestId('default-price-hint')).toBeNull();
    state.role = 'CORE_PARTNER';
  });
});
