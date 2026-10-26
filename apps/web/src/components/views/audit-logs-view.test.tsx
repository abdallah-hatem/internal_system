import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import AuditLogsView from './audit-logs-view';

/**
 * The audit log's "Who" filter (owner 2026-10-18: "In audit logs I need to
 * filter by the 3 users, me, Fares & Shady"). People are listed and shown by
 * their partner name, never their email; the choice lives in the address; it
 * narrows together with the record type and the search.
 */

// ── The address bar: replace() writes it, useSearchParams() re-reads it ──
const nav = vi.hoisted(() => {
  let query = '';
  const subs = new Set<() => void>();
  return {
    get query() {
      return query;
    },
    set(q: string) {
      query = q;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
    replace: vi.fn(),
  };
});
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(nav.subscribe, () => nav.query, () => nav.query)),
  usePathname: () => '/en/settings',
  useRouter: () => ({
    push: vi.fn(),
    replace: (href: string) => {
      nav.replace(href);
      nav.set(href.split('?')[1] ?? '');
    },
  }),
}));

// ── People and rows ──────────────────────────────────────────────────────
const OWNER = '11111111-1111-4111-8111-111111111111';
const FARES = '22222222-2222-4222-8222-222222222222';
const SHADY = '33333333-3333-4333-8333-333333333333';
const SUPPORT = '44444444-4444-4444-8444-444444444444';
const SHOP = '55555555-5555-4555-8555-555555555555';
const INVESTOR = '66666666-6666-4666-8666-666666666666';
const GHOST = '99999999-9999-4999-8999-999999999999';

const USERS = [
  { id: OWNER, email: 'ahkortam@x.test', role: 'CORE_PARTNER', partner: { displayName: 'Abdallah' } },
  { id: FARES, email: 'f.elsayed@x.test', role: 'CORE_PARTNER', partner: { displayName: 'Fares' } },
  { id: SHADY, email: 's.k@x.test', role: 'CORE_PARTNER', partner: { displayName: 'Shady' } },
  { id: SUPPORT, email: 'support@x.test', role: 'ADMIN_SUPPORT', partner: null },
  { id: SHOP, email: 'nile-motors@x.test', role: 'SHOP_OWNER_PORTAL', partner: null },
  { id: INVESTOR, email: 'ivo@x.test', role: 'TEMP_INVESTOR', partner: { displayName: 'Investor Ivo' } },
];

const row = (id: string, actorUserId: string | null, entityType: string, entityLabel: string) => {
  const u = USERS.find((x) => x.id === actorUserId);
  return {
    id,
    actorUserId,
    // What the API sends: the partner's name beside the email (audit.controller).
    actor: u ? { email: u.email, displayName: u.partner?.displayName ?? null } : null,
    action: 'CREATE',
    entityType,
    entityId: id,
    entityLabel,
    occurredAt: '2026-10-18T09:00:00Z',
  };
};

const ROWS = [
  row('r1', OWNER, 'SaleOrder', 'ORD-2026-00001'),
  row('r2', FARES, 'Payment', 'PAY-FARES'),
  row('r3', SHADY, 'SaleOrder', 'ORD-2026-00003'),
  row('r4', FARES, 'SaleOrder', 'ORD-2026-00004'),
  row('r5', null, 'SaleOrder', 'ORD-SYSTEM'),
  // Someone the users list no longer has, and the API could not name.
  row('r6', GHOST, 'SaleOrder', 'ORD-GHOST'),
];

const gets: { url: string; params: Record<string, unknown> }[] = [];
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: { params?: Record<string, unknown> }) => {
      const params = opts?.params ?? {};
      gets.push({ url, params });
      if (url === '/users') return Promise.resolve({ data: { data: USERS, meta: { nextCursor: null } } });
      if (url === '/audit-logs') {
        // The server's own filtering and search (audit.controller findAll):
        // who, by name or email, and the record.
        const term = String(params.search ?? '').toLowerCase();
        const data = ROWS.filter(
          (r) =>
            (!params.entityType || r.entityType === params.entityType) &&
            (!params.actorUserId || r.actorUserId === params.actorUserId) &&
            (!term ||
              [r.actor?.email, r.actor?.displayName, r.entityLabel].some((v) => v?.toLowerCase().includes(term))),
        );
        return Promise.resolve({
          data: { data, meta: { nextCursor: null, total: data.length, totalPages: Math.ceil(data.length / 10) } },
        });
      }
      if (url.startsWith('/audit-logs/')) {
        return Promise.resolve({ data: { data: ROWS.find((r) => url.endsWith(r.id)) } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
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

function renderIn(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <AuditLogsView />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The actor column of the desktop table, top to bottom. */
const actors = () => screen.queryAllByTestId('audit-actor').map((c) => c.textContent);
/** The records the table shows, by the label they read as. */
const records = () =>
  [...document.querySelectorAll('[data-testid="audit-actor"]')].map(
    (c) => c.closest('tr')!.textContent!.match(/ORD-[\w-]+|PAY-\w+/)![0],
  );
const whoTrigger = () => within(screen.getByTestId('audit-actor-filter')).getByRole('combobox');
const typeTrigger = () => screen.getAllByRole('combobox').find((c) => !screen.getByTestId('audit-actor-filter').contains(c))!;

async function pickWho(name: string) {
  fireEvent.click(whoTrigger());
  const option = (await screen.findAllByRole('option')).find((o) => o.textContent === name);
  if (!option) throw new Error(`no option ${name}`);
  fireEvent.click(option);
}

async function pickType(label: string) {
  fireEvent.click(typeTrigger());
  const option = (await screen.findAllByRole('option')).find((o) => o.textContent === label);
  fireEvent.click(option!);
}

const allLoaded = () => waitFor(() => expect(records()).toHaveLength(ROWS.length));

beforeEach(() => {
  nav.set('view=audit-logs');
  nav.replace.mockReset();
  gets.length = 0;
});
afterEach(cleanup);

describe('the audit log’s Who filter', () => {
  it('lists Everyone, then the office’s people by name — never by email, and not shops or investors', async () => {
    renderIn();
    await allLoaded();
    expect(whoTrigger().textContent).toContain('Everyone');
    fireEvent.click(whoTrigger());
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Everyone', 'Abdallah', 'Fares', 'Shady', 'support@x.test']);
  });

  it('the rows name each person the way the filter does; the system and a gone account get words, not blanks or ids', async () => {
    renderIn();
    await allLoaded();
    expect(actors()).toEqual(['Abdallah', 'Fares', 'Shady', 'Fares', 'System', 'Former user']);
    expect(document.body.textContent).not.toContain('f.elsayed@x.test');
    expect(document.body.textContent).not.toContain(GHOST);
  });

  it('in Arabic, the same people and the Arabic words for the rest', async () => {
    renderIn('ar');
    await waitFor(() => expect(actors()).toHaveLength(ROWS.length));
    expect(actors()).toEqual(['Abdallah', 'Fares', 'Shady', 'Fares', ar.auditLogs.systemActor, ar.auditLogs.formerUser]);
    expect(whoTrigger().textContent).toContain(ar.auditLogs.everyone);
  });

  it('choosing Fares shows only Fares’s rows, asks the API for him, and writes him into the address beside the view', async () => {
    renderIn();
    await allLoaded();
    await pickWho('Fares');
    await waitFor(() => expect(records()).toEqual(['PAY-FARES', 'ORD-2026-00004']));
    expect(new Set(actors())).toEqual(new Set(['Fares']));
    expect(gets.some((g) => g.url === '/audit-logs' && g.params.actorUserId === FARES)).toBe(true);
    expect(nav.replace).toHaveBeenLastCalledWith(`/en/settings?view=audit-logs&actor=${FARES}`);
    expect(whoTrigger().textContent).toContain('Fares');
  });

  it('with the record type too: Fares’s sale orders only', async () => {
    renderIn();
    await allLoaded();
    await pickWho('Fares');
    await pickType(en.codes.entityType.SaleOrder);
    await waitFor(() => expect(records()).toEqual(['ORD-2026-00004']));
  });

  it('with the search too: a search inside Fares’s rows, and one that only someone else matches finds nothing', async () => {
    renderIn();
    await allLoaded();
    await pickWho('Fares');
    await waitFor(() => expect(records()).toHaveLength(2));
    const search = screen.getByPlaceholderText(en.auditLogs.search);
    // The search is sent to the server once typing rests (2026-10-25).
    fireEvent.change(search, { target: { value: '00004' } });
    await waitFor(() => expect(records()).toEqual(['ORD-2026-00004']));
    expect(gets.at(-1)?.params).toMatchObject({ search: '00004', actorUserId: FARES });
    fireEvent.change(search, { target: { value: 'Shady' } });
    await waitFor(() => expect(records()).toEqual([]));
  });

  it('the search finds a person by name, not only by email', async () => {
    renderIn();
    await allLoaded();
    fireEvent.change(screen.getByPlaceholderText(en.auditLogs.search), { target: { value: 'shady' } });
    await waitFor(() => expect(records()).toEqual(['ORD-2026-00003']));
  });

  it('Everyone restores every row and takes the person out of the address, the view kept', async () => {
    renderIn();
    await allLoaded();
    await pickWho('Shady');
    await waitFor(() => expect(records()).toEqual(['ORD-2026-00003']));
    await pickWho('Everyone');
    await allLoaded();
    expect(nav.replace).toHaveBeenLastCalledWith('/en/settings?view=audit-logs');
    expect(whoTrigger().textContent).toContain('Everyone');
  });

  it('a second visit: the person is read back from the address, and only their rows are asked for', async () => {
    nav.set(`view=audit-logs&actor=${SHADY}`);
    renderIn();
    await waitFor(() => expect(records()).toEqual(['ORD-2026-00003']));
    expect(whoTrigger().textContent).toContain('Shady');
    // Never an unfiltered fetch first: the address names a person, so the list waits for the people.
    expect(gets.filter((g) => g.url === '/audit-logs').every((g) => g.params.actorUserId === SHADY)).toBe(true);
  });

  it('a stale link to someone who is not on the list falls back to everyone, and never asks the API for them', async () => {
    nav.set(`view=audit-logs&actor=${GHOST}`);
    renderIn();
    await allLoaded();
    expect(whoTrigger().textContent).toContain('Everyone');
    expect(gets.some((g) => g.params.actorUserId === GHOST)).toBe(false);
  });

  it('an address with something that is not an id is ignored, not sent', async () => {
    nav.set('view=audit-logs&actor=fares');
    renderIn();
    await allLoaded();
    expect(whoTrigger().textContent).toContain('Everyone');
    expect(gets.some((g) => 'actorUserId' in g.params)).toBe(false);
  });

  it('the clear button on an empty result clears the person too', async () => {
    renderIn();
    await allLoaded();
    await pickWho('Shady');
    await waitFor(() => expect(records()).toHaveLength(1));
    fireEvent.change(screen.getByPlaceholderText(en.auditLogs.search), { target: { value: 'nothing-like-this' } });
    const clear = (await screen.findAllByRole('button', { name: en.common.clearSearchAndFilters }))[0];
    fireEvent.click(clear);
    await allLoaded();
    expect(nav.replace).toHaveBeenLastCalledWith('/en/settings?view=audit-logs');
  });

  it('the detail dialog names the person, and says System for an action with no one behind it', async () => {
    renderIn();
    await allLoaded();
    const viewButtons = () => screen.getAllByTitle(en.common.view);
    fireEvent.click(viewButtons()[1]);
    expect((await screen.findByTestId('audit-detail-actor')).textContent).toBe('Fares');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('audit-detail-actor')).toBeNull());
    fireEvent.click(viewButtons()[4]);
    expect((await screen.findByTestId('audit-detail-actor')).textContent).toBe('System');
  });
});
