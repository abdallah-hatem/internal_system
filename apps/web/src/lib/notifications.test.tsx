import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
// The server's own catalogue, to hold the locale files to.
import { NOTIFICATION_MESSAGES } from '../../../api/src/common/notification-messages';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The Requests page is hidden in production for now (lib/features.ts); a
// request's notification must not link to a page that is not there.
const flags = vi.hoisted(() => ({ requests: true }));
vi.mock('@/lib/features', () => ({
  get REQUESTS_ENABLED() {
    return flags.requests;
  },
  get ENABLED_FEATURES() {
    return flags.requests ? ['requests'] : [];
  },
}));

const stored = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/lib/api', () => ({
  api: {
    get: () =>
      Promise.resolve({ data: { data: stored.items, meta: { unreadCount: stored.items.length } } }),
    post: () => Promise.resolve({ data: {} }),
  },
}));

import { NotificationBell } from '@/components/layout/notification-bell';
import { notificationHref } from '@/lib/notifications';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  flags.requests = true;
});

const NEW = {
  id: 'n-new',
  eventType: 'CYCLE_STATUS_CHANGED',
  code: 'CYCLE_STATUS_CHANGED',
  params: { cycleCode: 'CYC-2026-0007', toStatus: 'SELLING' },
  title: 'Cycle CYC-2026-0007 moved to SELLING',
  payloadJson: { cycleId: 'c-7' },
  readAt: null,
  createdAt: '2026-10-09T10:00:00.000Z',
};

// Written before codes existed: English text, no code, no params.
const OLD = {
  id: 'n-old',
  eventType: 'LOW_STOCK_DETECTED',
  title: 'Low stock detected: Brake pad',
  payloadJson: null,
  readAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
};

// The record code is its own LTR isolate (UI audit #35), so the sentence spans
// several nodes; match the paragraph that holds all of it.
const wholeText = (text: string) => (_: string, el: Element | null) =>
  el?.tagName === 'P' && el.textContent === text;

async function openBellInArabic(items: unknown[]) {
  stored.items = items;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
        <NotificationBell />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(ar.notifications.unread) }));
}

describe('notifications in the reader’s language', () => {
  it('a new notification (code + params) reads in Arabic, its status code translated too', async () => {
    await openBellInArabic([NEW]);
    expect(await screen.findByText(wholeText('انتقلت الدورة CYC-2026-0007 إلى البيع'))).toBeTruthy();
    expect(screen.queryByText(NEW.title)).toBeNull();
  });

  it('an old notification with no code still shows the text it was stored with', async () => {
    await openBellInArabic([OLD, NEW]);
    expect(await screen.findByText(OLD.title)).toBeTruthy();
    expect(screen.getByText(wholeText('انتقلت الدورة CYC-2026-0007 إلى البيع'))).toBeTruthy();
  });

  it('an overdue instalment says its due day as an Arabic date, not a reordered 08-10-2026', async () => {
    await openBellInArabic([
      {
        ...NEW,
        id: 'n-due',
        eventType: 'PAYMENT_OVERDUE',
        code: 'INSTALMENT_OVERDUE',
        params: { customer: 'Heliopolis Bikes', dueOn: '2026-10-08', reference: 'PLAN-2026-0001', amount: '2,500.00' },
        title: 'Heliopolis Bikes missed the instalment due 2026-10-08 on PLAN-2026-0001 — 2,500.00 EGP outstanding',
      },
    ]);
    const line = await screen.findByText(/Heliopolis Bikes/);
    expect(line.textContent).toContain('أكتوبر');
    expect(line.textContent).not.toContain('2026-10-08');
  });

  it('a code this build has never heard of falls back to the stored text, not to a key', async () => {
    await openBellInArabic([{ ...NEW, id: 'n-x', code: 'SOMETHING_NEW', title: 'Something new happened' }]);
    expect(await screen.findByText('Something new happened')).toBeTruthy();
  });
});

describe('the locale files and the server catalogue agree', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const codes = Object.keys(NOTIFICATION_MESSAGES);
  const isCode = (key: string) => /^[A-Z][A-Z0-9_]+$/.test(key);

  it('every code the server writes has words in en and ar, with the params it sends', () => {
    for (const code of codes) {
      for (const messages of [en, ar] as const) {
        const text = (messages.notifications as Record<string, string>)[code];
        expect([code, typeof text]).toEqual([code, 'string']);
        const server = NOTIFICATION_MESSAGES[code as keyof typeof NOTIFICATION_MESSAGES].en.title;
        expect([code, placeholders(text)]).toEqual([code, placeholders(server)]);
      }
    }
  });

  it('no translation is left for a code nothing writes any more', () => {
    for (const messages of [en, ar]) {
      const orphans = Object.keys(messages.notifications).filter((k) => isCode(k) && !codes.includes(k));
      expect(orphans).toEqual([]);
    }
  });
});

describe('where a notification the API actually raises takes you', () => {
  const href = (eventType: string, payloadJson: Record<string, unknown> = {}) =>
    notificationHref({ ...NEW, eventType, payloadJson } as Parameters<typeof notificationHref>[0]);

  it('an overdue instalment (eventType PAYMENT_OVERDUE) opens the contracts', () => {
    expect(href('PAYMENT_OVERDUE', { planId: 'p', instalmentId: 'i' })).toBe('/payments?view=contracts');
  });

  it('low stock (eventType LOW_STOCK_DETECTED, after a receipt or a sale) opens the stock page', () => {
    expect(href('LOW_STOCK_DETECTED', { products: [{ productId: 'x' }] })).toBe('/inventory');
  });
});

describe('a notification about a shop’s request (Requests page, owner 2026-10-17)', () => {
  const href = (eventType: string, enabled?: boolean) =>
    notificationHref({ ...NEW, eventType, payloadJson: {} } as Parameters<typeof notificationHref>[0], enabled);

  it('opens the tab it is about when the page is switched on', () => {
    expect(href('ORDER_REQUEST_SUBMITTED', true)).toBe('/requests');
    expect(href('HOLD_EXPIRING', true)).toBe('/requests');
    expect(href('IMPORT_REQUEST_SUBMITTED', true)).toBe('/requests?view=imports');
  });

  it('is not a link at all when the page is switched off', () => {
    for (const e of ['ORDER_REQUEST_SUBMITTED', 'HOLD_EXPIRING', 'IMPORT_REQUEST_SUBMITTED']) {
      expect([e, href(e, false)]).toEqual([e, null]);
    }
  });

  it('no notification links to the old addresses any more', () => {
    for (const e of ['ORDER_REQUEST_SUBMITTED', 'HOLD_EXPIRING', 'IMPORT_REQUEST_SUBMITTED']) {
      expect(href(e, true)).not.toMatch(/order-requests|import-requests/);
    }
  });

  it('switched off, switching it off does not take the links off anything else', () => {
    expect(href('SALE_CONFIRMED', false)).toBe('/sales');
  });

  it('in the bell, switched off, the request still shows but as plain text — not a link', async () => {
    flags.requests = false;
    await openBellInArabic([
      { ...NEW, id: 'n-req', eventType: 'IMPORT_REQUEST_SUBMITTED', code: 'SOMETHING_NEW', title: 'Shop asked for a part' },
    ]);
    const line = await screen.findByText('Shop asked for a part');
    expect(line.closest('a')).toBeNull();
  });

  it('in the bell, switched on, the same request links to its tab', async () => {
    await openBellInArabic([
      { ...NEW, id: 'n-req', eventType: 'IMPORT_REQUEST_SUBMITTED', code: 'SOMETHING_NEW', title: 'Shop asked for a part' },
    ]);
    const line = await screen.findByText('Shop asked for a part');
    expect(line.closest('a')?.getAttribute('href')).toBe('/requests?view=imports');
  });
});
