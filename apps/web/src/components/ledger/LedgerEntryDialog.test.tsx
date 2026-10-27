import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { MANUAL_EXPENSE_CATEGORIES, OTHER_INCOME_CATEGORIES } from '@/lib/ledger-categories';
import { LedgerEntryDialog } from './LedgerEntryDialog';

/**
 * L6 — "Record money in or out" (BUSINESS_LOGIC §9, 2026-10-11).
 *
 * The old form offered system types, a free-text category, an Inflow/Outflow
 * radio, a free-text cycle id and no date. Each test here fails against it.
 */

const post = vi.fn();
let answer: (url: string, body: unknown) => Promise<unknown> = () => new Promise(() => {});
const CYCLES = [
  { id: 'cyc-open', code: 'CYC-2026-001', status: 'SELLING' },
  { id: 'cyc-settling', code: 'CYC-2026-002', status: 'SETTLEMENT' },
  { id: 'cyc-closed', code: 'CYC-2026-003', status: 'CLOSED' },
  { id: 'cyc-cancelled', code: 'CYC-2026-004', status: 'CANCELLED' },
];
vi.mock('@/lib/api', () => ({
  api: {
    post: (url: string, body: unknown) => {
      post(url, body);
      return answer(url, body);
    },
    get: (url: string) =>
      Promise.resolve({
        data: {
          data: url.startsWith('/cycles')
            ? CYCLES
            : url.startsWith('/currency-rates')
              ? { USD: 48.5, AED: 13.2 }
              : url === '/partner-accounts'
                ? [{ partnerUserId: 'u-shady', name: 'Shady', active: true }]
                : [],
        },
      }),
  },
}));

// A core partner: the one role that may write the ledger, and read who can pay.
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'x@y.z', role: 'CORE_PARTNER' } }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

function renderDialog(presetCategory?: string) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <LedgerEntryDialog open onClose={onClose} presetCategory={presetCategory} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onClose };
}

const L = en.ledger;
const card = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });
const combo = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const hidden = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
const amountInput = () => document.querySelector<HTMLInputElement>('#ledger-amount')!;
const save = () => screen.getByRole('button', { name: en.common.save });

/** A label as a pattern: "Extra freight (for a cycle)" has parentheses. */
const re = (label: string) => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

async function pick(id: string, option: RegExp) {
  fireEvent.click(combo(id));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
function typeAmount(value: string) {
  fireEvent.focus(amountInput());
  fireEvent.change(amountInput(), { target: { value } });
  fireEvent.blur(amountInput());
}
async function optionsOf(id: string) {
  fireEvent.click(combo(id));
  await screen.findAllByRole('option');
  const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  return names;
}

beforeEach(() => {
  post.mockReset();
  answer = () => new Promise(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('what is it? — the kind cards', () => {
  it('two cards, no Inflow/Outflow radio and no type picker', () => {
    renderDialog();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(card(L.kindExpense)).toBeTruthy();
    expect(card(L.kindIncome)).toBeTruthy();
    expect(screen.queryByText(L.inflow)).toBeNull();
    expect(screen.queryByText(L.outflow)).toBeNull();
    expect(document.querySelector('input[name="direction"]')).toBeNull();
    expect(document.querySelector('[name="type"]')).toBeNull();
  });

  it('an expense is sent as money out', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'tx' } } });
    const { onClose } = renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.rent));
    typeAmount('1500');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      '/ledger',
      expect.objectContaining({ kind: 'EXPENSE', direction: 'OUTFLOW', category: 'rent', amount: 1500, currency: 'EGP' }),
    );
  });

  it('other income is sent as money in', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'tx' } } });
    const { onClose } = renderDialog();
    fireEvent.click(card(L.kindIncome));
    expect(card(L.kindIncome).getAttribute('aria-checked')).toBe('true');
    expect(card(L.kindExpense).getAttribute('aria-checked')).toBe('false');
    await pick('ledger-category', re(en.codes.ledgerCategory.interest));
    typeAmount('250');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ kind: 'OTHER_INCOME', direction: 'INFLOW', category: 'interest' });
  });
});

describe('the category list follows the kind', () => {
  it('an expense offers exactly the expense list, in words', async () => {
    renderDialog();
    fireEvent.click(card(L.kindExpense));
    const names = await optionsOf('ledger-category');
    expect(names).toHaveLength(MANUAL_EXPENSE_CATEGORIES.length);
    for (const c of MANUAL_EXPENSE_CATEGORIES) {
      expect(names.some((n) => n.includes(en.codes.ledgerCategory[c]))).toBe(true);
    }
    // Nothing a flow writes.
    for (const system of ['Purchase', 'Settlement', 'Contribution', 'purchase']) {
      expect(names.some((n) => n === system)).toBe(false);
    }
  });

  it('other income offers exactly the income list', async () => {
    renderDialog();
    fireEvent.click(card(L.kindIncome));
    const names = await optionsOf('ledger-category');
    expect(names).toHaveLength(OTHER_INCOME_CATEGORIES.length);
    for (const c of OTHER_INCOME_CATEGORIES) {
      expect(names.some((n) => n.includes(en.codes.ledgerCategory[c]))).toBe(true);
    }
  });

  it('switching kind drops a category that belongs to the other one', async () => {
    renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.rent));
    expect(hidden('category')?.value).toBe('rent');
    fireEvent.click(card(L.kindIncome));
    expect(hidden('category')?.value ?? '').toBe('');
  });
});

describe('extra freight and the cycle', () => {
  it('extra freight without a cycle is stopped before it is sent, in the server’s words', async () => {
    renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.extra_freight));
    typeAmount('300');
    fireEvent.click(save());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('ledger-refusal').textContent).toBe(
      en.errors.LEDGER_CYCLE_REQUIRED.replace('{category}', en.codes.ledgerCategory.extra_freight),
    );
  });

  it('with a cycle it goes, charged to that cycle', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'tx' } } });
    const { onClose } = renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.extra_freight));
    await pick('ledger-cycle', /CYC-2026-001/);
    typeAmount('300');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ category: 'extra_freight', cycleId: 'cyc-open' });
  });

  it('the cycle list is "CYC-… · status", without closed or cancelled cycles', async () => {
    renderDialog();
    const names = await optionsOf('ledger-cycle');
    expect(names).toEqual([
      `CYC-2026-001 · ${en.codes.cycleStatus.SELLING}`,
      `CYC-2026-002 · ${en.codes.cycleStatus.SETTLEMENT}`,
    ]);
  });
});

describe('currency, rate and date', () => {
  it('the rate field is hidden for EGP and appears, prefilled and editable, for a foreign currency', async () => {
    renderDialog();
    const rateInput = () => document.querySelector<HTMLInputElement>('input[name="fxRateToEgp"]:not([type="hidden"])');
    expect(rateInput()).toBeNull();
    fireEvent.click(screen.getAllByRole('combobox').find((b) => b.textContent?.includes('EGP'))!);
    fireEvent.click(await screen.findByRole('option', { name: /USD/ }));
    await waitFor(() => expect(rateInput()?.value).toBe('48.5'));
    fireEvent.change(rateInput()!, { target: { value: '49' } });
    expect(rateInput()!.value).toBe('49');
  });

  it("the date defaults to Cairo's today, not the machine's", () => {
    // 23:30 UTC on 10 Oct is 02:30 on the 11th in Cairo; the test machine is UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T23:30:00Z'));
    renderDialog();
    expect(hidden('occurredOn')?.value).toBe('2026-10-11');
  });

  it('a future day cannot be picked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    renderDialog();
    const trigger = document.querySelector<HTMLElement>('[data-ledger-date] button')!;
    fireEvent.click(trigger);
    const tomorrow = await screen.findByRole('gridcell', { name: /12/ }).catch(() => null);
    const day = tomorrow?.querySelector('button') ?? tomorrow;
    expect(day).toBeTruthy();
    expect(
      (day as HTMLButtonElement).disabled || day!.getAttribute('aria-disabled') === 'true',
    ).toBe(true);
  });

  it('a non-positive amount is stopped before it is sent', async () => {
    renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.rent));
    typeAmount('0');
    fireEvent.click(save());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('ledger-refusal').textContent).toBe(en.errors.LEDGER_AMOUNT_NOT_POSITIVE);
  });
});

describe('a refusal keeps the form', () => {
  it('stays open with every value, and says the refusal translated', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: {
            error: {
              code: 'LEDGER_CYCLE_NOT_OPEN',
              message: 'English fallback',
              params: { cycle: 'CYC-2026-001', status: 'CLOSED' },
            },
          },
        },
      });
    const { onClose } = renderDialog();
    fireEvent.click(card(L.kindExpense));
    await pick('ledger-category', re(en.codes.ledgerCategory.rent));
    await pick('ledger-cycle', /CYC-2026-001/);
    typeAmount('1500');
    fireEvent.click(save());
    const alert = await screen.findByTestId('ledger-refusal');
    expect(alert.textContent).toBe(
      en.errors.LEDGER_CYCLE_NOT_OPEN.replace('{cycle}', 'CYC-2026-001').replace(
        '{status}',
        en.codes.cycleStatus.CLOSED,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(amountInput().value).toBe('1,500');
    expect(hidden('category')?.value).toBe('rent');
  });
});

describe('Escape', () => {
  it('inside an open picker closes the picker, not the form', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(combo('ledger-category'));
    await screen.findAllByRole('option');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with nothing open closes the form', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('no native controls (LEARNINGS: interface)', () => {
  it('no <select>, no date input, no radio input', () => {
    renderDialog();
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('the source names none either', () => {
    // A variable, not a literal: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL.
    const rel = './LedgerEntryDialog.tsx';
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(src).not.toMatch(/<select|type="date"|type="radio"/);
  });
});

describe('the Fuel shortcut (§9, 2026-10-17)', () => {
  it('opens as an expense on Fuel, with the amount, cycle and note left empty', () => {
    renderDialog('fuel');
    expect(card(L.kindExpense).getAttribute('aria-checked')).toBe('true');
    expect(hidden('category')?.value).toBe('fuel');
    expect(combo('ledger-category').textContent).toContain(en.codes.ledgerCategory.fuel);
    expect(amountInput().value).toBe('');
    expect(hidden('cycleId')?.value ?? '').toBe('');
  });

  it('saves a fuel expense as money out, as a running cost with no cycle', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'tx' } } });
    const { onClose } = renderDialog('fuel');
    typeAmount('600');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'EXPENSE', direction: 'OUTFLOW', category: 'fuel', amount: 600, currency: 'EGP' });
    expect(body).not.toHaveProperty('cycleId');
  });

  it('still needs an amount: Save with none sends nothing', async () => {
    renderDialog('fuel');
    fireEvent.click(save());
    expect((await screen.findByTestId('ledger-refusal')).textContent).toBe(en.errors.LEDGER_AMOUNT_NOT_POSITIVE);
    expect(post).not.toHaveBeenCalled();
  });

  it('switching to other income drops Fuel rather than sending an expense category as income', () => {
    renderDialog('fuel');
    fireEvent.click(card(L.kindIncome));
    expect(hidden('category')?.value ?? '').toBe('');
  });

  it('a category that is not a manual expense is not taken: the form opens empty', () => {
    renderDialog('purchase');
    expect(hidden('category')?.value ?? '').toBe('');
    cleanup();
    renderDialog('interest');
    expect(hidden('category')?.value ?? '').toBe('');
  });
});

describe('Paid by (§9, owner 2026-10-26, built 2026-10-27)', () => {
  it('opens on the business; income has no payer at all, and coming back to an expense is the business again', async () => {
    renderDialog('fuel');
    expect(hidden('paidBy')?.value).toBe('BUSINESS');
    await pick('ledger-paid-by', /Shady/);
    expect(hidden('paidBy')?.value).toBe('u-shady');
    fireEvent.click(card(L.kindIncome));
    expect(document.querySelector('#ledger-paid-by')).toBeNull();
    fireEvent.click(card(L.kindExpense));
    expect(hidden('paidBy')?.value).toBe('BUSINESS');
  });

  it('income is never sent with a payer, even after one was chosen on the expense', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'tx' } } });
    const { onClose } = renderDialog('fuel');
    await pick('ledger-paid-by', /Shady/);
    fireEvent.click(card(L.kindIncome));
    await pick('ledger-category', re(en.codes.ledgerCategory.interest));
    typeAmount('40');
    fireEvent.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).not.toHaveProperty('paidByUserId');
  });

  it('a payer the server refuses: said translated, the form and his name kept', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: { error: { code: 'LEDGER_PAYER_INACTIVE', message: 'English fallback', params: { partner: 'Shady' } } },
        },
      });
    const { onClose } = renderDialog('fuel');
    await pick('ledger-paid-by', /Shady/);
    typeAmount('300');
    fireEvent.click(save());
    expect((await screen.findByTestId('ledger-refusal')).textContent).toBe(
      en.errors.LEDGER_PAYER_INACTIVE.replace('{partner}', 'Shady'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(hidden('paidBy')?.value).toBe('u-shady');
    expect(post.mock.calls[0][1]).toMatchObject({ paidByUserId: 'u-shady', amount: 300 });
  });
});
