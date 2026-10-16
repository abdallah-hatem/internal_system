import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { ENTITY_FORMS } from './entity-forms';
import SuppliersPage from '@/app/[locale]/suppliers/page';

/**
 * A supplier's country is a picker, not a text box (owner 2026-10-16, §21):
 * the value is the ISO code the API checks, the label the reader's own name for
 * it, and the Suppliers list shows that name — never the code. The form here
 * is the one the Suppliers page and the `+` beside a supplier picker both
 * render (entity-forms.tsx), so it is tested once.
 */

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ar' }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: state.locale }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/${state.locale}/suppliers`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) =>
      Promise.resolve({
        data: {
          data:
            url === '/suppliers'
              ? [
                  { id: 'sup-1', name: 'Dubai Parts', country: 'AE', contactJson: {} },
                  { id: 'sup-2', name: 'Old Text Co', country: 'Narnia', contactJson: {} },
                ]
              : [],
        },
      }),
    post: () => new Promise(() => {}),
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
});
afterEach(() => cleanup());

function wrap(ui: ReactNode, locale: 'en' | 'ar') {
  state.locale = locale;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const Fields = ENTITY_FORMS.supplier.Fields;

function renderForm(locale: 'en' | 'ar', record?: Record<string, unknown>) {
  wrap(
    <form data-testid="supplier-form">
      <Fields record={record} />
    </form>,
    locale,
  );
}

const countryValue = () =>
  document.querySelector<HTMLInputElement>('input[type="hidden"][name="country"]')?.value;
/** The country picker's trigger: the only combobox in the supplier form. */
const trigger = () => screen.getByRole('combobox');
const payload = () =>
  ENTITY_FORMS.supplier.toPayload(new FormData(screen.getByTestId('supplier-form') as HTMLFormElement));

describe('the supplier form’s country', () => {
  it('is a picker, not a text box', () => {
    renderForm('en');
    expect(document.querySelector('input[name="country"]:not([type="hidden"])')).toBeNull();
    expect(trigger().textContent).toContain(en.placeholders.chooseCountry);
    expect(countryValue()).toBe('');
  });

  it('offers the business’s countries first, named in the reader’s language', async () => {
    renderForm('ar');
    fireEvent.click(trigger());
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options[0]).toBe('الصين');
    expect(options[2]).toBe('مصر');
    expect(options.length).toBe(249);
  });

  it('searching "مصر" on /en finds Egypt, and saving sends the code EG', async () => {
    renderForm('en');
    fireEvent.click(trigger());
    const search = await screen.findByPlaceholderText(en.placeholders.searchCountries);
    fireEvent.change(search, { target: { value: 'مصر' } });

    const found = screen.getAllByRole('option');
    expect(found.map((o) => o.textContent)).toEqual(['Egypt']);
    fireEvent.click(found[0]);

    expect(trigger().textContent).toContain('Egypt');
    expect(countryValue()).toBe('EG');
    expect(payload().country).toBe('EG');
  });

  it('on /ar, the English name and the code find it too', async () => {
    renderForm('ar');
    fireEvent.click(trigger());
    const search = await screen.findByPlaceholderText(ar.placeholders.searchCountries);
    fireEvent.change(search, { target: { value: 'egypt' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['مصر']);
    fireEvent.change(search, { target: { value: 'CN' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['الصين']);
  });

  it('editing a supplier opens on its country, labelled, with the code as the value', () => {
    renderForm('ar', { name: 'Dubai Parts', country: 'AE', contactJson: {} });
    expect(trigger().textContent).toMatch(/الإمارات/);
    expect(countryValue()).toBe('AE');
    expect(payload().country).toBe('AE');
  });

  it('a supplier still holding free text opens with nothing chosen, so saving asks for a country', () => {
    renderForm('en', { name: 'Old Text Co', country: 'Egypt (Cairo)', contactJson: {} });
    expect(countryValue()).toBe('');
    expect(trigger().textContent).toContain(en.placeholders.chooseCountry);
    // The required mirror the shared Select renders while nothing is chosen.
    expect(
      within(screen.getByTestId('supplier-form')).getByRole('combobox').parentElement!.querySelector(
        'input[required]',
      ),
    ).not.toBeNull();
  });
});

describe('the Suppliers list', () => {
  it('shows the country’s Arabic name on /ar, never the code', async () => {
    wrap(<SuppliersPage />, 'ar');
    expect((await screen.findAllByText('Dubai Parts')).length).toBeGreaterThan(0);
    const named = screen.getAllByText(/الإمارات العربية المتحدة/);
    expect(named.length).toBeGreaterThan(0);
    expect(screen.queryAllByText('AE', { exact: true })).toHaveLength(0);
    // Free text from before the codes is shown as it was, not blank.
    expect(screen.getAllByText('Narnia').length).toBeGreaterThan(0);
  });

  it('…and its English name on /en', async () => {
    wrap(<SuppliersPage />, 'en');
    expect((await screen.findAllByText('United Arab Emirates')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('AE', { exact: true })).toHaveLength(0);
  });
});
