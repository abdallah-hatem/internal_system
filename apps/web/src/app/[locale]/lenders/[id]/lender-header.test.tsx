import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * The friend's note under his name is typed in either language. Loose in the
 * Arabic header, an English note was reordered around the phone number and
 * its full stop jumped to the front: "Family friend; lends against a · +20 100
 * 555 7788 / .purchase order, repaid in pounds" (UI audit 2026-11, M5).
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'l-hassan', locale: 'ar' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const NOTE = 'Family friend; lends against a purchase order, repaid in pounds.';
vi.mock('@/lib/api', () => ({
  api: {
    get: () =>
      Promise.resolve({
        data: { data: { id: 'l-hassan', name: 'Hassan El-Masry', phone: '+20 100 555 7788', notes: NOTE, owed: [], financings: [] } },
      }),
    post: vi.fn(),
  },
}));

import LenderPage from './page';

afterEach(cleanup);

describe("the lender's header note", () => {
  it('is its own isolated run, apart from the phone number, full stop included', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
          <ToastProvider>
            <div dir="rtl"><LenderPage /></div>
          </ToastProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const note = await screen.findByText(NOTE);
    expect(note.tagName).toBe('BDI');
    expect(note.getAttribute('dir')).toBe('auto');
    expect(note.textContent).toBe(NOTE);
    const phone = screen.getByText('+20 100 555 7788');
    expect(phone.getAttribute('dir')).toBe('ltr');
    expect(phone.contains(note)).toBe(false);
  });
});
