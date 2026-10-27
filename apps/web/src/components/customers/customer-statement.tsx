'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileText, Printer } from '@/components/ui/icons';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { downloadCsv, datedFilename } from '@/lib/export-csv';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { DateRangeFilter, type DayRange } from '@/components/ui/date-range-filter';
import { isolateCodes } from '@/components/layout/isolate-codes';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, DataTableSkeletonRow, PAPER_FIT, SCREEN_ONLY, cellPadding, type Column } from '@/components/ui/data-table';

/** One row of `GET /customers/:id/statement` (api common/customer-statement.ts). */
export interface StatementRow {
  kind: 'SALE' | 'PAYMENT' | 'RETURN' | 'REVERSAL' | 'ADJUSTMENT';
  date: string;
  reference: string | null;
  orders: string[];
  /** The branches of the orders it touched (§7, 2026-10-25). Absent before then. */
  branches?: string[];
  amount: string;
  effect: string;
  balance: string;
  method: string | null;
  /** What it did to the profit; null for cash moving. Absent from an API before 2026-10-23. */
  profit?: string | null;
  unapplied?: string;
}

export interface Statement {
  customer: { id: string; displayName: string; phone: string | null };
  from: string | null;
  to: string | null;
  openingBalance: string;
  rows: StatementRow[];
  debits: string;
  credits: string;
  closingBalance: string;
  /** The shop's profit in the range. Absent from an API before 2026-10-23. */
  profit?: string;
}

/** A calendar day at noon UTC, so no browser timezone can move it a day. */
const noon = (day: string) => `${day}T12:00:00Z`;

/** Movements a statement's skeleton shows before the real ones arrive. */
const SKELETON_ROWS = 4;

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`, the opening and closing lines with them; the phone's cards
// below are traced by hand. Change the real ones, change these.

function StatementCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <SkeletonText className="w-40" />
        <SkeletonText className="w-20" />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <SkeletonText size="xs" className="w-20" />
        <SkeletonText size="xs" className="w-28" />
      </div>
    </div>
  );
}

/** The opening and closing bars of the phone's list. */
function StatementTotalSkeleton() {
  return (
    <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
      <SkeletonText className="w-24 bg-background" />
      <SkeletonText className="w-24 bg-background" />
    </div>
  );
}

/**
 * A shop's statement of account (BUSINESS_LOGIC §7b, I2 2026-10-11): pick the
 * days, read the opening balance, every sale, payment, return and reversal
 * with the balance after it, and the closing balance — which for a range
 * running to today is the balance tile above it. Printed on A4 through the
 * app's print stylesheet, or taken out as a CSV.
 *
 * The figures are the server's. Nothing here adds them up: a running balance
 * worked out twice is two answers to one question (CLAUDE.md §11).
 */
export function CustomerStatement({
  customerId,
  customerName,
  branch = null,
  branchName,
  showBranches = false,
}: {
  customerId: string;
  customerName: string;
  /**
   * One branch's statement (§7, 2026-10-25): a branch id, `none` for the
   * orders on no branch, or null for the owner's — every branch together.
   */
  branch?: string | null;
  /** What the narrowed statement is headed with on paper. */
  branchName?: string;
  /** A Branch column: the customer has branches. */
  showBranches?: boolean;
}) {
  const tb = useTranslations('branches');
  const t = useTranslations('customers.statement');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatAmount } = useNumberFormat();
  const [range, setRange] = useState<DayRange>({ from: '', to: '' });

  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery<Statement>({
    queryKey: ['customer', customerId, 'statement', range, branch],
    queryFn: () =>
      api
        .get(`/customers/${customerId}/statement`, {
          params: { from: range.from || undefined, to: range.to || undefined, branch: branch || undefined },
        })
        .then((r) => r.data.data ?? r.data),
    // The rows already on screen stay, dimmed, while another range loads,
    // rather than the table collapsing to a spinner and back.
    placeholderData: keepPreviousData,
    // Current every time the page opens, as the invoice is: money taken
    // elsewhere invalidates nothing in this browser.
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const reloading = isFetching && isPlaceholderData;

  // Each date is its own isolated run: "10 أكتوبر 2026 – 11 أكتوبر 2026"
  // otherwise has its digits and month reordered across the dash.
  const isolate = (text: string) => `\u2068${text}\u2069`;
  const rangeLabel = (() => {
    const from = range.from ? isolate(formatDate(noon(range.from))) : '';
    const to = range.to ? isolate(formatDate(noon(range.to))) : '';
    if (from && to) return t('range', { from, to });
    if (from) return t('rangeFrom', { from });
    if (to) return t('rangeTo', { to });
    return t('allDates');
  })();

  /** What a row says, in the reader's words. */
  const describe = (row: StatementRow): string => {
    const parts: string[] = [];
    if (row.kind === 'SALE') parts.push(t('kind.SALE', { order: row.reference ?? '' }));
    if (row.kind === 'RETURN') {
      parts.push(t('kind.RETURN', { reference: row.reference ?? '' }));
      parts.push(row.method === 'CASH' ? t('refundCash') : t('refundCredit'));
    }
    // A price lowered after the sale (§4, 2026-10-22): on the order it lowered.
    if (row.kind === 'ADJUSTMENT') parts.push(t('kind.ADJUSTMENT'));
    if (row.kind === 'PAYMENT' || row.kind === 'REVERSAL') {
      parts.push(t(`kind.${row.kind}`));
      if (row.method) parts.push(codeLabel('paymentMethod', row.method));
      if (row.reference) parts.push(row.reference);
    }
    if (row.kind !== 'SALE' && row.orders.length) parts.push(t('onOrders', { orders: row.orders.join(', ') }));
    if (row.unapplied) parts.push(t('unapplied', { amount: formatAmount(row.unapplied) }));
    return parts.join(' · ');
  };

  const debit = (row: StatementRow) => (Number(row.effect) > 0 ? row.effect : null);
  const credit = (row: StatementRow) => (Number(row.effect) < 0 ? String(-Number(row.effect)) : null);

  const exportCsv = () => {
    if (!data) return;
    type Line = { date: string; branch: string; description: string; debit: number | null; credit: number | null; balance: number };
    const lines: Line[] = [
      { date: data.from ?? '', branch: '', description: t('opening'), debit: null, credit: null, balance: Number(data.openingBalance) },
      ...data.rows.map((r) => ({
        date: r.date,
        branch: (r.branches ?? []).join(', '),
        description: describe(r),
        debit: debit(r) === null ? null : Number(debit(r)),
        credit: credit(r) === null ? null : Number(credit(r)),
        balance: Number(r.balance),
      })),
      { date: data.to ?? '', branch: '', description: t('closing'), debit: Number(data.debits), credit: Number(data.credits), balance: Number(data.closingBalance) },
    ];
    downloadCsv(datedFilename(`${t('csv')}-${customerName}${branchName ? `-${branchName}` : ''}`), lines, [
      { header: t('date'), value: (l) => l.date },
      ...(showBranches ? [{ header: tb('column'), value: (l: Line) => l.branch }] : []),
      { header: t('description'), value: (l) => l.description },
      { header: t('debit'), value: (l) => l.debit },
      { header: t('credit'), value: (l) => l.credit },
      { header: t('balance'), value: (l) => l.balance },
    ]);
  };

  const amountCell = (value: string | null) =>
    value === null ? <span className="text-muted-foreground">—</span> : <Money value={value} currency="EGP" />;

  // Profit (owner 2026-10-23): green made, red lost, "—" for cash moving. The
  // server's figure, never summed here; on screen only — a printed statement
  // may go to the shop, so paper, the PDF and the CSV never carry it (GUESS).
  const profitTone = (value: string) => (Number(value) < 0 ? 'text-destructive' : Number(value) > 0 ? 'text-success' : '');
  const profitCell = (value: string | null | undefined) =>
    value == null ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <Money value={value} currency="EGP" className={profitTone(value)} />
    );
  const hasProfit = data?.profit !== undefined;

  // One table for the statement and its skeleton (components/ui/data-table.tsx):
  // date, description, debit, credit, balance. The amounts fit
  // "123,456.00 EGP" and never cut; the description takes what is left and,
  // on a statement that may be printed, wraps in full rather than being cut.
  // On A4 (186mm) the four fixed columns leave the description about 200px.
  const columns: Column<StatementRow>[] = [
    {
      key: 'date', header: t('date'), width: '7rem', kind: 'value', className: 'text-xs text-muted-foreground',
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' }, cell: (row) => formatDate(noon(row.date)),
    },
    // The branch on every row (§7, 2026-10-25): one for a sale, several for a
    // payment spread across branches, a dash for an order on the owner.
    ...(showBranches
      ? [
          {
            key: 'branch', header: tb('column'), width: '7rem', kind: 'label',
            className: 'text-xs text-foreground',
            cellProps: () => ({ 'data-testid': 'statement-branch' }),
            cell: (row: StatementRow) => (row.branches?.length ? <LatinText>{row.branches.join(', ')}</LatinText> : '—'),
          } satisfies Column<StatementRow>,
        ]
      : []),
    {
      // A record code stays whole and moves to the next line, unless it is
      // longer than the column (a bank reference on A4): then it breaks inside
      // rather than running over the debit beside it.
      key: 'description', header: t('description'), width: 'auto',
      className: 'break-words text-foreground [&_bdi]:inline-block [&_bdi]:max-w-full [&_bdi]:whitespace-normal [&_bdi]:[overflow-wrap:anywhere]',
      cell: (row) => isolateCodes(describe(row)),
    },
    {
      key: 'debit', header: t('debit'), width: '8rem', kind: 'value', align: 'end',
      skeleton: { kind: 'text', share: 'w-2/3' }, cell: (row) => amountCell(debit(row)),
    },
    {
      key: 'credit', header: t('credit'), width: '8rem', kind: 'value', align: 'end', className: 'text-foreground',
      skeleton: { kind: 'text', share: 'w-2/3' }, cell: (row) => amountCell(credit(row)),
    },
    {
      key: 'balance', header: t('balance'), width: '8.5rem', kind: 'value', align: 'end', className: 'font-medium',
      skeleton: { kind: 'text', share: 'w-3/4' }, cell: (row) => <Money value={row.balance} />,
    },
    ...(hasProfit || isLoading
      ? [
          {
            key: 'profit', header: t('profit'), width: '8.5rem', kind: 'value', align: 'end', screenOnly: true,
            cellProps: () => ({ 'data-testid': 'statement-profit' }),
            skeleton: { kind: 'text', share: 'w-2/3' }, cell: (row: StatementRow) => profitCell(row.profit),
          } satisfies Column<StatementRow>,
        ]
      : []),
  ];
  const pad = cellPadding('compact');
  const money = `${pad} whitespace-nowrap text-end tabular-nums`;

  return (
    <section
      data-testid="customer-statement"
      data-print-doc
      aria-labelledby="statement-heading"
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      {/* On paper: what this is, whose, and for when. */}
      <div className="mb-4 hidden print:block">
        <p className="text-sm text-muted-foreground">{tc('brand')}</p>
        <h2 className="text-xl font-bold text-foreground">{t('heading')}</h2>
        <p className="mt-1 text-base font-semibold text-foreground">
          <LatinText>{customerName}</LatinText>
          {branchName && (
            <>
              {' · '}
              <LatinText>{branchName}</LatinText>
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">{rangeLabel}</p>
        <p className="text-xs text-muted-foreground">{t('printedOn', { date: formatDate(new Date().toISOString()) })}</p>
      </div>

      <div className="mb-3 flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div className="min-w-0">
          <h2 id="statement-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t('title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('hint')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="statement-print"
            onClick={() => window.print()}
            disabled={!data}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:min-h-0"
          >
            <Printer className="h-4 w-4" />
            {tc('print')}
          </button>
          <button
            type="button"
            data-testid="statement-export"
            onClick={exportCsv}
            disabled={!data}
            className="bg-background inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:min-h-0"
          >
            <Download className="h-4 w-4" />
            {tc('export')}
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <DateRangeFilter idPrefix="statement" value={range} onChange={setRange} busy={reloading} />
      </div>

      {error && (
        <p role="alert" data-testid="statement-error" className="mb-3 text-sm text-destructive">
          {apiError(error, t('loadFailed'))}
        </p>
      )}

      {isLoading ? (
        <div>
          <LoadingStatus />
          {/* The table's own header over skeleton rows; cards on a phone. */}
          <DataTable
            className="hidden sm:block"
            frame="none"
            density="compact"
            isLoading
            skeletonRows={SKELETON_ROWS}
            rows={[]}
            rowKey={() => ''}
            columns={columns}
            beforeRows={<DataTableSkeletonRow testId="skeleton-total" className="bg-muted/60" columns={columns} density="compact" />}
            afterRows={<DataTableSkeletonRow testId="skeleton-total" className="border-t-2 border-border" columns={columns} density="compact" />}
          />
          <SkeletonGroup className="space-y-2 sm:hidden">
            <StatementTotalSkeleton />
            {repeat(SKELETON_ROWS, (i) => <StatementCardSkeleton key={i} />)}
            <StatementTotalSkeleton />
          </SkeletonGroup>
        </div>
      ) : data ? (
        <div
          aria-busy={reloading}
          className={`transition-opacity ${reloading ? 'opacity-60' : ''}`}
        >
          {/* From sm up, and always on paper: one table, money end-aligned. */}
          <DataTable
            className="hidden sm:block print:block"
            frame="none"
            density="compact"
            autoMin="10rem"
            // On paper, A4's width rather than its screen minimum (TC-COL-05).
            tableClassName={PAPER_FIT}
            tableTestId="statement-table"
            rows={data.rows}
            rowKey={(row, i) => `${row.kind}-${row.reference}-${i}`}
            rowProps={(row) => ({ 'data-testid': 'statement-row', 'data-kind': row.kind })}
            empty={<p className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</p>}
            beforeRows={
              <tr data-testid="statement-opening" className="bg-muted/60 font-medium">
                <td className={`${pad} whitespace-nowrap text-xs text-muted-foreground`}>{data.from ? formatDate(noon(data.from)) : '—'}</td>
                {showBranches && <td className={pad} />}
                <td className={pad}>{t('opening')}</td>
                <td className={pad} />
                <td className={pad} />
                <td className={money}><Money value={data.openingBalance} /></td>
                {hasProfit && <td className={`${pad} ${SCREEN_ONLY}`} />}
              </tr>
            }
            afterRows={
              <tr data-testid="statement-closing" className="border-t-2 border-border font-semibold">
                <td className={`${pad} whitespace-nowrap text-xs text-muted-foreground`}>{data.to ? formatDate(noon(data.to)) : '—'}</td>
                {showBranches && <td className={pad} />}
                <td className={pad}>{t('closing')}</td>
                <td className={money}><Money value={data.debits} /></td>
                <td className={`${money} text-foreground`}><Money value={data.credits} /></td>
                <td data-testid="statement-closing-balance" className={money}>
                  <Money value={data.closingBalance} />
                </td>
                {hasProfit && (
                  <td data-testid="statement-closing-profit" className={`${money} ${SCREEN_ONLY}`} title={t('profitTotal')}>
                    {profitCell(data.profit)}
                  </td>
                )}
              </tr>
            }
            columns={columns}
          />

          {/* A phone: one card per row, the balance on its own line. */}
          <div className="space-y-2 sm:hidden print:hidden" data-testid="statement-cards">
            <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm font-medium">
              <span>{t('opening')}</span>
              <Money value={data.openingBalance} />
            </div>
            {data.rows.map((row, i) => (
              <div key={`${row.kind}-${row.reference}-${i}`} className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-foreground">{isolateCodes(describe(row))}</span>
                  <span className={`shrink-0 whitespace-nowrap tabular-nums ${Number(row.effect) < 0 ? 'text-foreground' : ''}`}>
                    {Number(row.effect) === 0 ? '—' : <Money value={row.effect} />}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {formatDate(noon(row.date))}
                    {showBranches && row.branches?.length ? (
                      <>
                        {' · '}
                        <LatinText>{row.branches.join(', ')}</LatinText>
                      </>
                    ) : null}
                  </span>
                  <span>
                    {t('balance')}: <Money value={row.balance} className="font-medium text-foreground" />
                  </span>
                </div>
                {hasProfit && row.profit != null && (
                  <div data-testid="statement-card-profit" className="mt-0.5 flex justify-end text-xs text-muted-foreground">
                    <span>
                      {t('profit')}: {profitCell(row.profit)}
                    </span>
                  </div>
                )}
              </div>
            ))}
            {data.rows.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">{t('empty')}</p>}
            <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm font-semibold">
              <span>{t('closing')}</span>
              <Money value={data.closingBalance} />
            </div>
            {hasProfit && (
              <div data-testid="statement-card-closing-profit" className="flex items-center justify-between px-3 text-sm">
                <span className="text-muted-foreground">{t('profitTotal')}</span>
                {profitCell(data.profit)}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
