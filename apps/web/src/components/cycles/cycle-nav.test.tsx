import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { ContinueSetupLink, canContinueSetup } from './continue-setup';
import { CycleStatusButton, canChangeStatus } from './cycle-status-button';
import { WIZARD_STATUSES } from './wizard-walk';
import { RowAction } from '@/components/ui/fields';
import { FieldWithQuickCreate } from '@/components/ui/quick-create';
import CyclesPage from '@/components/views/cycles-view';
import CycleDetailsPage from '@/app/[locale]/cycles/[cycleId]/details/page';

/**
 * Opening a cycle opens its page; the wizard is a separate, named way back in;
 * a status change is a button on that page (owner, 2026-10-11).
 *
 * Every rule here is tested both ways (CLAUDE.md §12): who is refused, and that
 * the right person still gets it — a control hidden from everybody passes half
 * of these. e2e: apps/web/tests/94-row-alignment-and-cycle-nav.spec.ts.
 */

const state = vi.hoisted(() => ({
  role: 'CORE_PARTNER' as string,
  status: 'PLANNING' as string,
  pushes: [] as string[],
  posts: [] as Array<{ url: string; body: unknown }>,
  postResult: 'ok' as 'ok' | 'refuse' | 'hang',
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ cycleId: 'c-1', locale: 'en' }),
  useRouter: () => ({ push: (to: string) => state.pushes.push(to), replace: vi.fn() }),
  usePathname: () => '/en/cycles',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: { href: string; children: ReactNode; onClick?: (e: React.MouseEvent) => void } & Record<string, unknown>) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault(); // jsdom does not navigate
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const cycle = () => ({
  id: 'c-1',
  code: 'CYC-1',
  status: state.status,
  originType: 'UAE_DIRECT',
  currency: 'AED',
  startedOn: '2026-10-01',
  participants: [],
  purchaseOrders: [],
  shippingLegs: [],
  inventoryBatches: [],
});

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url.endsWith('/shipment')) {
        const totals = { ordered: 0, received: 0, lost: 0, onTheWay: 0, waiting: 0 };
        return Promise.resolve({ data: { data: { cycleId: 'c-1', code: 'CYC-1', status: state.status, accounted: false, totals, lines: [], legs: [] } } });
      }
      if (url === '/cycles/c-1') return Promise.resolve({ data: { data: cycle() } });
      if (url.startsWith('/cycles')) return Promise.resolve({ data: { data: [cycle()], meta: { total: 1 } } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: (url: string, body: unknown) => {
      state.posts.push({ url, body });
      if (state.postResult === 'hang') return new Promise(() => {});
      if (state.postResult === 'refuse') {
        return Promise.reject({
          response: {
            status: 400,
            data: {
              error: {
                code: 'BAD_STATUS_TRANSITION',
                message: 'Cannot transition',
                params: { from: 'SELLING', to: 'SETTLEMENT', allowed: 'SETTLEMENT' },
              },
            },
          },
        });
      }
      return Promise.resolve({ data: { data: {} } });
    },
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
beforeEach(() => {
  state.role = 'CORE_PARTNER';
  state.status = 'PLANNING';
  state.pushes = [];
  state.posts = [];
  state.postResult = 'ok';
});
afterEach(() => cleanup());

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

// The wizard is for setting a cycle up and stops when the goods leave (owner,
// 2026-10-12): from In transit on, the cycle page is where it is worked on.
const NOT_WIZARD = [
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
];

describe('Continue setup', () => {
  it('the wizard statuses are exactly planning, funding and purchasing', () => {
    expect([...WIZARD_STATUSES]).toEqual(['PLANNING', 'FUNDING', 'PURCHASING']);
  });

  it('is offered for every wizard status to a role that may write the cycle, and goes to the wizard', () => {
    for (const status of WIZARD_STATUSES) {
      wrap(<ContinueSetupLink cycleId="c-1" status={status} />);
      const link = screen.getByTestId('continue-setup');
      expect(link.getAttribute('href'), status).toBe('/en/cycles/c-1');
      cleanup();
    }
  });

  it('is not offered once the wizard has nothing left to do, nor for a missing or unknown status', () => {
    for (const status of [...NOT_WIZARD, 'NOT_A_STATUS', '', undefined]) {
      wrap(<ContinueSetupLink cycleId="c-1" status={status} />);
      expect(screen.queryByTestId('continue-setup'), String(status)).toBeNull();
      cleanup();
    }
  });

  it('is not offered to an investor, an office role, or a role never heard of — even in PLANNING', () => {
    for (const role of ['TEMP_INVESTOR', 'SHOP_OWNER', 'SOMETHING_NEW', '']) {
      state.role = role;
      wrap(<ContinueSetupLink cycleId="c-1" status="PLANNING" />);
      expect(screen.queryByTestId('continue-setup'), role).toBeNull();
      cleanup();
    }
    expect(canContinueSetup('PLANNING', false)).toBe(false);
    expect(canContinueSetup('PLANNING', true)).toBe(true);
  });

  it('does not also fire the row it sits in (which opens the details page)', () => {
    const rowClick = vi.fn();
    wrap(
      <div onClick={rowClick}>
        <ContinueSetupLink cycleId="c-1" status="PURCHASING" />
      </div>,
    );
    fireEvent.click(screen.getByTestId('continue-setup'));
    expect(rowClick).not.toHaveBeenCalled();
  });
});

describe('Cycles list', () => {
  it('clicking a cycle still in the wizard opens its details page, not the wizard', async () => {
    state.status = 'PLANNING';
    wrap(<CyclesPage />);
    const row = (await screen.findAllByTestId('cycle-row'))[0];
    fireEvent.click(within(row).getByText('CYC-1'));
    expect(state.pushes).toEqual(['/en/cycles/c-1/details']);
  });

  it('clicking it twice goes to the same place both times (no state left over from the first)', async () => {
    wrap(<CyclesPage />);
    const row = (await screen.findAllByTestId('cycle-row'))[0];
    fireEvent.click(row);
    fireEvent.click(row);
    expect(state.pushes).toEqual(['/en/cycles/c-1/details', '/en/cycles/c-1/details']);
  });

  it('the phone card opens the details page too, and its Continue setup does not', async () => {
    wrap(<CyclesPage />);
    const card = (await screen.findAllByTestId('cycle-card'))[0];
    fireEvent.click(within(card).getByTestId('continue-setup'));
    expect(state.pushes).toEqual([]);
    fireEvent.click(card);
    expect(state.pushes).toEqual(['/en/cycles/c-1/details']);
  });

  it('Details is the last action in every row, with or without Continue setup, and it opens the details', async () => {
    // Details used to sit left of Continue setup, so rows with and without
    // setup left it at two different x positions — a ragged column.
    for (const status of ['PLANNING', 'SELLING']) {
      state.status = status;
      state.pushes = [];
      wrap(<CyclesPage />);
      const row = (await screen.findAllByTestId('cycle-row'))[0];
      const details = within(row).getByTestId('cycle-details');
      const actions = details.parentElement!;
      expect(actions.lastElementChild, status).toBe(details);
      expect(within(row).queryAllByTestId('continue-setup').length, status).toBe(status === 'PLANNING' ? 1 : 0);
      // A button inside the row says what it is; it is not a submit.
      expect(details.getAttribute('type')).toBe('button');
      fireEvent.click(details);
      expect(state.pushes, status).toEqual(['/en/cycles/c-1/details']);
      cleanup();
    }
  });

  it('offers no status change on the list — that lives on the details page', async () => {
    state.status = 'SELLING';
    wrap(<CyclesPage />);
    const row = (await screen.findAllByTestId('cycle-row'))[0];
    fireEvent.click(row);
    expect(screen.queryByTestId('change-status')).toBeNull();
    expect(screen.queryByRole('button', { name: en.cycles.transition })).toBeNull();
  });
});

describe('Change status', () => {
  it('a partner moves a selling cycle to settlement: one POST with that status, then a success toast', async () => {
    state.status = 'SELLING';
    wrap(<CycleStatusButton cycleId="c-1" status="SELLING" />);
    fireEvent.click(screen.getByTestId('change-status'));
    const dialog = await screen.findByTestId('change-status-dialog');
    const options = within(dialog).getAllByRole('button').filter((b) => b.dataset.status);
    expect(options.map((b) => b.dataset.status)).toEqual(['SETTLEMENT']);
    fireEvent.click(options[0]);
    await screen.findByText(en.cycles.statusUpdated);
    expect(state.posts).toEqual([{ url: '/cycles/c-1/transition', body: { status: 'SETTLEMENT' } }]);
    await waitFor(() => expect(screen.queryByTestId('change-status-dialog')).toBeNull());
  });

  it('offers exactly the moves the table allows — never one the server would refuse', async () => {
    wrap(<CycleStatusButton cycleId="c-1" status="PURCHASING" />);
    fireEvent.click(screen.getByTestId('change-status'));
    const dialog = await screen.findByTestId('change-status-dialog');
    const offered = within(dialog).getAllByRole('button').map((b) => b.dataset.status).filter(Boolean);
    expect(offered).toEqual(['IN_TRANSIT', 'ARRIVED_UAE', 'CANCELLED']);
  });

  it('is not offered for a closed, cancelled or unknown status — there is nowhere to go', () => {
    for (const status of ['CLOSED', 'CANCELLED', 'NOT_A_STATUS', undefined]) {
      wrap(<CycleStatusButton cycleId="c-1" status={status} />);
      expect(screen.queryByTestId('change-status'), String(status)).toBeNull();
      cleanup();
    }
  });

  it('is not offered to an investor, an office role or an unknown role', () => {
    for (const role of ['TEMP_INVESTOR', 'SHOP_OWNER', 'SOMETHING_NEW']) {
      state.role = role;
      wrap(<CycleStatusButton cycleId="c-1" status="SELLING" />);
      expect(screen.queryByTestId('change-status'), role).toBeNull();
      cleanup();
    }
    expect(canChangeStatus('SELLING', false)).toBe(false);
  });

  it('a refusal shows the server\'s reason in the reader\'s words, and the dialog stays open to try again', async () => {
    state.postResult = 'refuse';
    wrap(<CycleStatusButton cycleId="c-1" status="SELLING" />);
    fireEvent.click(screen.getByTestId('change-status'));
    const dialog = await screen.findByTestId('change-status-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Settlement/ }));
    await screen.findByText(/A cycle cannot move from/);
    expect(screen.queryByText(en.cycles.statusUpdated)).toBeNull();
    expect(screen.getByTestId('change-status-dialog')).toBeTruthy();
  });

  it('while a move is in flight, a second click on another option sends nothing more', async () => {
    state.postResult = 'hang';
    wrap(<CycleStatusButton cycleId="c-1" status="PURCHASING" />);
    fireEvent.click(screen.getByTestId('change-status'));
    const dialog = await screen.findByTestId('change-status-dialog');
    const [first, second] = within(dialog).getAllByRole('button').filter((b) => b.dataset.status);
    fireEvent.click(first);
    await waitFor(() => expect((second as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(second);
    expect(state.posts).toHaveLength(1);
  });

  it('cancel, then open again: the same options, nothing sent', async () => {
    wrap(<CycleStatusButton cycleId="c-1" status="SETTLEMENT" />);
    fireEvent.click(screen.getByTestId('change-status'));
    await screen.findByTestId('change-status-dialog');
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    await waitFor(() => expect(screen.queryByTestId('change-status-dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('change-status'));
    const dialog = await screen.findByTestId('change-status-dialog');
    expect(within(dialog).getAllByRole('button').map((b) => b.dataset.status).filter(Boolean)).toEqual(['CLOSED', 'SELLING']);
    expect(state.posts).toEqual([]);
  });

  it('sits on the details page for a partner and is absent there for an investor', async () => {
    state.status = 'SELLING';
    wrap(<CycleDetailsPage />);
    await screen.findByTestId('cycle-status');
    expect(screen.getByTestId('change-status')).toBeTruthy();
    cleanup();

    state.role = 'TEMP_INVESTOR';
    wrap(<CycleDetailsPage />);
    await screen.findByTestId('cycle-status');
    expect(screen.queryByTestId('change-status')).toBeNull();
  });
});

describe('Field rows', () => {
  it('RowAction keeps a label-high line above its control and centres it on a box-high band', () => {
    wrap(
      <RowAction labelClassName="block text-xs mb-1">
        <button type="button">x</button>
      </RowAction>,
    );
    const action = document.querySelector('[data-row-action]')!;
    const [spacer, band] = Array.from(action.children) as HTMLElement[];
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.className).toContain('block text-xs mb-1');
    expect(spacer.className).toContain('invisible');
    expect(band.className).toContain('h-(--field-h)');
    expect(band.className).toContain('items-center');
    expect(within(band).getByRole('button')).toBeTruthy();
  });

  it('the + beside a field is a top-aligned field-row with no margin guessing the error line', () => {
    state.role = 'CORE_PARTNER';
    wrap(
      <form>
        <FieldWithQuickCreate entity="category" onCreated={() => {}}>
          <input aria-invalid="true" />
          <p role="alert">Required</p>
        </FieldWithQuickCreate>
      </form>,
    );
    const plus = document.querySelector('[data-quick-create="category"]') as HTMLButtonElement;
    expect(plus.type).toBe('button'); // inside a form: must not submit it
    const row = plus.closest('.field-row');
    expect(row, 'the + sits in a field-row').toBeTruthy();
    expect(row!.className).not.toMatch(/items-end/);
    // Nothing between the + and the row pads it by a guessed error height.
    let el: HTMLElement | null = plus.parentElement;
    while (el && el !== row) {
      expect(el.className).not.toMatch(/\bmb-/);
      el = el.parentElement;
    }
  });

  it('globals.css aligns field rows to the top, unlayered, and gives every box one height', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('/* field-row:start'), css.indexOf('/* field-row:end */'));
    expect(block).toMatch(/\.field-row\s*\{\s*align-items:\s*start;/);
    expect(block).toMatch(/height:\s*var\(--field-h\)/);
    expect(block).toMatch(/--field-h:\s*2\.375rem/);
    // Inside a layer it would lose to an `items-end` utility left on a row.
    const before = css.slice(0, css.indexOf('/* field-row:start'));
    const depth = [...before].reduce((d, c) => d + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
    expect(depth, 'field-row rules sit at the top level').toBe(0);
  });
});
