'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileText, Loader2, Printer } from 'lucide-react';

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

/** One row of `GET /customers/:id/statement` (api common/customer-statement.ts). */
export interface StatementRow {
  kind: 'SALE' | 'PAYMENT' | 'RETURN' | 'REVERSAL';
  date: string;
  reference: string | null;
  orders: string[];
  amount: string;
  effect: string;
  balance: string;
  method: string | null;
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
}

/** A calendar day at noon UTC, so no browser timezone can move it a day. */
const noon = (day: string) => `${day}T12:00:00Z`;

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
export function CustomerStatement({ customerId, customerName }: { customerId: string; customerName: string }) {
  const t = useTranslations('customers.statement');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatAmount } = useNumberFormat();
  const [range, setRange] = useState<DayRange>({ from: '', to: '' });

  const { data, isLoading, isFetching, isPlaceholderData, error } = useQuery<Statement>({
    queryKey: ['customer', customerId, 'statement', range],
    queryFn: () =>
      api
        .get(`/customers/${customerId}/statement`, {
          params: { from: range.from || undefined, to: range.to || undefined },
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
    type Line = { date: string; description: string; debit: number | null; credit: number | null; balance: number };
    const lines: Line[] = [
      { date: data.from ?? '', description: t('opening'), debit: null, credit: null, balance: Number(data.openingBalance) },
      ...data.rows.map((r) => ({
        date: r.date,
        description: describe(r),
        debit: debit(r) === null ? null : Number(debit(r)),
        credit: credit(r) === null ? null : Number(credit(r)),
        balance: Number(r.balance),
      })),
      { date: data.to ?? '', description: t('closing'), debit: Number(data.debits), credit: Number(data.credits), balance: Number(data.closingBalance) },
    ];
    downloadCsv(datedFilename(`${t('csv')}-${customerName}`), lines, [
      { header: t('date'), value: (l) => l.date },
      { header: t('description'), value: (l) => l.description },
      { header: t('debit'), value: (l) => l.debit },
      { header: t('credit'), value: (l) => l.credit },
      { header: t('balance'), value: (l) => l.balance },
    ]);
  };

  const amountCell = (value: string | null) =>
    value === null ? <span className="text-muted-foreground">—</span> : <Money value={value} currency="EGP" />;

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
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
        </div>
      ) : data ? (
        <div
          aria-busy={reloading}
          className={`transition-opacity ${reloading ? 'opacity-60' : ''}`}
        >
          {/* From sm up, and always on paper: one table, money end-aligned. */}
          <table className="hidden w-full text-sm sm:table print:table" data-testid="statement-table">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground [&>th]:px-2 [&>th]:py-2 [&>th:first-child]:ps-0 [&>th:last-child]:pe-0">
                <th className="w-28 text-start font-medium">{t('date')}</th>
                <th className="text-start font-medium">{t('description')}</th>
                <th className="w-32 text-end font-medium">{t('debit')}</th>
                <th className="w-32 text-end font-medium">{t('credit')}</th>
                <th className="w-36 text-end font-medium">{t('balance')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr>td]:px-2 [&>tr>td]:py-2 [&>tr>td:first-child]:ps-0 [&>tr>td:last-child]:pe-0">
              <tr data-testid="statement-opening" className="bg-muted/60 font-medium">
                <td className="whitespace-nowrap text-xs text-muted-foreground">{data.from ? formatDate(noon(data.from)) : '—'}</td>
                <td>{t('opening')}</td>
                <td />
                <td />
                <td className="whitespace-nowrap text-end tabular-nums"><Money value={data.openingBalance} /></td>
              </tr>
              {data.rows.map((row, i) => (
                <tr key={`${row.kind}-${row.reference}-${i}`} data-testid="statement-row" data-kind={row.kind}>
                  <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(noon(row.date))}</td>
                  <td className="text-foreground">{isolateCodes(describe(row))}</td>
                  <td className="whitespace-nowrap text-end tabular-nums">{amountCell(debit(row))}</td>
                  <td className="whitespace-nowrap text-end tabular-nums text-foreground">{amountCell(credit(row))}</td>
                  <td className="whitespace-nowrap text-end font-medium tabular-nums"><Money value={row.balance} /></td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-sm text-muted-foreground">{t('empty')}</td>
                </tr>
              )}
              <tr data-testid="statement-closing" className="border-t-2 border-border font-semibold">
                <td className="whitespace-nowrap text-xs text-muted-foreground">{data.to ? formatDate(noon(data.to)) : '—'}</td>
                <td>{t('closing')}</td>
                <td className="whitespace-nowrap text-end tabular-nums"><Money value={data.debits} /></td>
                <td className="whitespace-nowrap text-end tabular-nums text-foreground"><Money value={data.credits} /></td>
                <td data-testid="statement-closing-balance" className="whitespace-nowrap text-end tabular-nums">
                  <Money value={data.closingBalance} />
                </td>
              </tr>
            </tbody>
          </table>

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
                  <span>{formatDate(noon(row.date))}</span>
                  <span>
                    {t('balance')}: <Money value={row.balance} className="font-medium text-foreground" />
                  </span>
                </div>
              </div>
            ))}
            {data.rows.length === 0 && <p className="py-3 text-center text-sm text-muted-foreground">{t('empty')}</p>}
            <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm font-semibold">
              <span>{t('closing')}</span>
              <Money value={data.closingBalance} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
