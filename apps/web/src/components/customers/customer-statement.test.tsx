import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { CustomerStatement, type Statement } from './customer-statement';

/**
 * The statement's Profit column (owner 2026-10-23): the server's figure per
 * row, green made and red lost, "—" for cash moving, the period's profit on
 * the closing row — and on screen only: a printed statement, its PDF and its
 * CSV may go to the shop, so none of them carry it.
 */

const answer = vi.hoisted(() => ({ statement: null as unknown }));
vi.mock('@/lib/api', () => ({
  api: { get: () => Promise.resolve({ data: { data: answer.statement } }) },
}));
const csv = vi.hoisted(() => ({ columns: [] as { header: string }[] }));
vi.mock('@/lib/export-csv', () => ({
  datedFilename: (n: string) => n,
  downloadCsv: (_name: string, _rows: unknown[], columns: { header: string }[]) => {
    csv.columns = columns;
  },
}));

afterEach(() => {
  cleanup();
  csv.columns = [];
});

const row = (kind: string, effect: string, balance: string, profit: string | null, reference = 'SO-1') => ({
  kind, date: '2026-10-05', reference, orders: ['SO-1'], amount: effect.replace('-', ''), effect, balance, method: kind === 'PAYMENT' ? 'CASH' : null, profit,
});

const statement = (extra: Partial<Statement> = {}): Statement =>
  ({
    customer: { id: 'c1', displayName: 'Koshary', phone: null },
    from: null,
    to: null,
    openingBalance: '0.00',
    rows: [
      row('SALE', '12500.00', '12500.00', '3300.00'),
      row('PAYMENT', '-5000.00', '7500.00', null, 'PAY-1'),
      row('RETURN', '-2500.00', '5000.00', '-600.00', 'RET-1'),
      row('ADJUSTMENT', '-800.00', '4200.00', '-800.00'),
    ],
    debits: '12500.00',
    credits: '8300.00',
    closingBalance: '4200.00',
    profit: '1900.00',
    ...extra,
  }) as Statement;

function show(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <CustomerStatement customerId="c1" customerName="Koshary" />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('the Profit column', () => {
  it('each row the server’s profit: green made, red lost, "—" for a payment; the period’s profit on the closing row', async () => {
    answer.statement = statement();
    show();
    const table = await screen.findByTestId('statement-table');
    expect(within(table).getByRole('columnheader', { name: en.customers.statement.profit })).toBeTruthy();
    const cells = within(table).getAllByTestId('statement-profit');
    expect(cells.map((c) => c.textContent)).toEqual(['3,300.00 EGP', '—', '-600.00 EGP', '-800.00 EGP']);
    expect(cells[0].querySelector('.text-success')).toBeTruthy();
    expect(cells[2].querySelector('.text-destructive')).toBeTruthy();
    expect(cells[1].querySelector('.text-success, .text-destructive')).toBeNull();
    const closing = within(table).getByTestId('statement-closing-profit');
    expect(closing.textContent).toBe('1,900.00 EGP');
    expect(closing.querySelector('.text-success')).toBeTruthy();
  });

  it('a period at a loss closes red', async () => {
    answer.statement = statement({ profit: '-200.00' });
    show();
    const closing = await screen.findByTestId('statement-closing-profit');
    expect(closing.querySelector('.text-destructive')).toBeTruthy();
  });

  it('never on paper or in a PDF: the header, every cell and its column carry print:hidden and sheet:hidden', async () => {
    answer.statement = statement();
    const { container } = show();
    const table = await screen.findByTestId('statement-table');
    const header = within(table).getByRole('columnheader', { name: en.customers.statement.profit });
    const paperOnly = (el: Element) => el.className.includes('print:hidden') && el.className.includes('sheet:hidden');
    expect(paperOnly(header)).toBe(true);
    for (const cell of within(table).getAllByTestId('statement-profit')) expect(paperOnly(cell)).toBe(true);
    expect(paperOnly(within(table).getByTestId('statement-closing-profit'))).toBe(true);
    // The opening row's empty cell too, so paper's rows stay five cells wide.
    expect(paperOnly(within(table).getByTestId('statement-opening').lastElementChild!)).toBe(true);
    const cols = [...table.querySelectorAll('col')];
    expect(cols.filter(paperOnly)).toHaveLength(1);
    // The other columns still print.
    expect(paperOnly(within(table).getByRole('columnheader', { name: en.customers.statement.balance }))).toBe(false);
    expect(container.querySelector('[data-testid="statement-cards"]')!.className).toContain('print:hidden');
  });

  it('the CSV the office exports carries no profit', async () => {
    answer.statement = statement();
    show();
    await screen.findByTestId('statement-table');
    fireEvent.click(screen.getByRole('button', { name: /csv|export/i }));
    expect(csv.columns.length).toBeGreaterThan(0);
    expect(csv.columns.map((c) => c.header)).not.toContain(en.customers.statement.profit);
  });

  it('on a phone each sale, return and cut shows its profit; a payment shows none', async () => {
    answer.statement = statement();
    show();
    const cards = await screen.findByTestId('statement-cards');
    const lines = within(cards).getAllByTestId('statement-card-profit');
    expect(lines).toHaveLength(3);
    expect(within(cards).getByTestId('statement-card-closing-profit').textContent).toContain('1,900.00 EGP');
  });

  it('an older API that sends no profit: no column at all, the statement as before', async () => {
    const old = statement();
    delete (old as Partial<Statement>).profit;
    old.rows = old.rows.map(({ profit: _p, ...r }) => r) as Statement['rows'];
    answer.statement = old;
    show();
    const table = await screen.findByTestId('statement-table');
    expect(within(table).queryByRole('columnheader', { name: en.customers.statement.profit })).toBeNull();
    expect(within(table).queryByTestId('statement-closing-profit')).toBeNull();
  });

  it('in Arabic: the header translated, Latin digits', async () => {
    answer.statement = statement();
    show('ar');
    const table = await screen.findByTestId('statement-table');
    expect(within(table).getByRole('columnheader', { name: ar.customers.statement.profit })).toBeTruthy();
    expect(within(table).getByTestId('statement-closing-profit').textContent).toMatch(/1,900\.00/);
    expect(table.textContent).not.toMatch(/[٠-٩]/);
  });
});
