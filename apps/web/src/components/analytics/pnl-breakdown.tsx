'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { Dialog } from '@/components/ui/dialog';
import { SkeletonRegion, SkeletonText, Skeleton, repeat } from '@/components/ui/skeleton';

/**
 * What made one bar of the profit and loss chart (owner 2026-10-28: "clicking
 * on a day or a month should open a popup or show me the details of loss";
 * BUSINESS_LOGIC §9 "What made a bar").
 *
 * Every figure is the API's (`GET /analytics/profit-and-loss/breakdown`),
 * which reads the very parts the bar adds up and groups them by the record
 * each came from — so the totals here are the bar's, and nothing is added up
 * in the browser (CLAUDE.md §11). Each list is paged by the API; "Show more"
 * asks for its next page and its totals stay those of every row.
 */

type Ref = { id: string; code: string } | null;

export interface BreakdownOrder {
  id: string;
  orderNo: string;
  soldOn: string;
  status: string;
  customer: string;
  customerId: string;
  branch: string | null;
}

export interface BreakdownEntry {
  id: string;
  type: string;
  reason: string | null;
  cycle: Ref;
  paidBy: { id: string; name: string } | null;
}

export interface OrderRow {
  day: string;
  orderId: string;
  order: BreakdownOrder | null;
  saleEgp: number;
  returnsEgp: number;
  priceCutsEgp: number;
  revenueEgp: number;
  cogsEgp: number;
  grossProfitEgp: number;
  events: { kind: 'return' | 'priceCut'; id: string; day: string; revenueEgp: number; cogsEgp: number }[];
}

export interface ExpenseRow {
  kind: 'ledger' | 'loss' | 'samples';
  id: string;
  day: string;
  category: string | null;
  amountEgp: number;
  entry: BreakdownEntry | null;
  order: BreakdownOrder | null;
  loss: { qty: number; reason: string | null; product: string; leg: number; cycle: Ref } | null;
}

export interface ExchangeRow {
  id: string;
  day: string;
  amountEgp: number;
  repayment: {
    paidEgp: number;
    rateToEgp: number;
    currency: string;
    lender: string;
    cycle: Ref;
    purchaseOrder: { id: string; reference: string } | null;
  } | null;
}

export interface OtherRow {
  line: 'recovered' | 'otherIncome';
  id: string;
  day: string;
  category: string | null;
  amountEgp: number;
  entry: BreakdownEntry | null;
}

interface Page<R, T> {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  rows: R[];
  totals: T;
}

export interface PnlBreakdownData {
  from: string;
  to: string;
  empty: boolean;
  totals: {
    salesEgp: number;
    cogsEgp: number;
    grossProfitEgp: number;
    expensesEgp: number;
    recoveredEgp: number;
    otherIncomeEgp: number;
    exchangeDifferenceEgp: number;
    netProfitEgp: number;
  };
  sections: {
    orders?: Page<OrderRow, { saleEgp: number; returnsEgp: number; priceCutsEgp: number; revenueEgp: number; cogsEgp: number; grossProfitEgp: number }>;
    expenses?: Page<ExpenseRow, { amountEgp: number }>;
    exchange?: Page<ExchangeRow, { amountEgp: number }>;
    other?: Page<OtherRow, { recoveredEgp: number; otherIncomeEgp: number }>;
  };
}

type Section = keyof PnlBreakdownData['sections'];

const PATH = '/analytics/profit-and-loss/breakdown';
const tone = (v: number) => (v < 0 ? 'text-destructive' : v > 0 ? 'text-success' : 'text-muted-foreground');
const linkClass = 'font-medium text-primary underline-offset-2 hover:underline';

/** The popup for the days `from`–`to`, titled `label` (the bar's own name). */
export function PnlBreakdown({ from, to, label, onClose }: { from: string; to: string; label: string; onClose: () => void }) {
  const t = useTranslations('analytics.pnl');
  const apiError = useApiError();
  const { data, isLoading, error } = useQuery<PnlBreakdownData>({
    queryKey: ['analytics', 'pnl-breakdown', from, to],
    queryFn: () => api.get(PATH, { params: { from, to } }).then((r) => r.data.data ?? r.data),
  });

  return (
    <Dialog
      size="lg"
      title={label}
      description={t('breakdown.note')}
      onClose={onClose}
      cardProps={{ 'data-testid': 'pnl-breakdown', 'data-from': from, 'data-to': to }}
    >
      {error ? (
        <p role="alert" data-testid="pnl-breakdown-error" className="text-sm text-destructive">
          {apiError(error, t('breakdown.loadFailed'))}
        </p>
      ) : isLoading || !data ? (
        <BreakdownSkeleton />
      ) : data.empty ? (
        <p data-testid="pnl-breakdown-empty" className="rounded-lg bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
          {t('breakdown.empty')}
        </p>
      ) : (
        <Body data={data} from={from} to={to} />
      )}
    </Dialog>
  );
}

function Body({ data, from, to }: { data: PnlBreakdownData; from: string; to: string }) {
  const t = useTranslations('analytics.pnl');
  const { totals } = data;
  const lines: { key: string; label: string; value: number; sign: string; strong?: boolean; hideZero?: boolean }[] = [
    { key: 'sales', label: t('sales'), value: totals.salesEgp, sign: '' },
    { key: 'cogs', label: t('cogs'), value: totals.cogsEgp, sign: '−' },
    { key: 'gross', label: t('grossProfit'), value: totals.grossProfitEgp, sign: '=', strong: true },
    { key: 'expenses', label: t('expenses'), value: totals.expensesEgp, sign: '−' },
    { key: 'recovered', label: t('recovered'), value: totals.recoveredEgp, sign: '+', hideZero: true },
    { key: 'otherIncome', label: t('otherIncome'), value: totals.otherIncomeEgp, sign: '+', hideZero: true },
    { key: 'exchange', label: t('exchangeDifference'), value: totals.exchangeDifferenceEgp, sign: '−', hideZero: true },
    { key: 'net', label: t('netProfit'), value: totals.netProfitEgp, sign: '=', strong: true },
  ];
  return (
    <div className="space-y-6">
      <dl data-testid="pnl-breakdown-totals" className="max-w-md text-sm">
        {lines
          .filter((l) => !(l.hideZero && l.value === 0))
          .map((l) => (
            <div
              key={l.key}
              data-line={l.key}
              className={cn('flex items-baseline justify-between gap-3 py-1', l.strong ? 'border-t border-border font-semibold' : '')}
            >
              <dt className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span aria-hidden="true" className="w-3 shrink-0 text-center text-muted-foreground">
                  {l.sign}
                </span>
                <span className="min-w-0">{l.label}</span>
              </dt>
              <dd className={cn('whitespace-nowrap tabular-nums', l.strong ? tone(l.value) : 'text-foreground')}>
                <Money value={l.value} />
              </dd>
            </div>
          ))}
      </dl>

      <Paged section="orders" first={data.sections.orders} from={from} to={to} title={t('breakdown.ordersTitle')}>
        {(rows: OrderRow[]) => rows.map((r) => <OrderLine key={r.orderId} row={r} />)}
      </Paged>
      <Paged section="expenses" first={data.sections.expenses} from={from} to={to} title={t('breakdown.expensesTitle')}>
        {(rows: ExpenseRow[]) => rows.map((r) => <ExpenseLine key={`${r.kind}-${r.id}`} row={r} />)}
      </Paged>
      <Paged section="exchange" first={data.sections.exchange} from={from} to={to} title={t('breakdown.exchangeTitle')}>
        {(rows: ExchangeRow[]) => rows.map((r) => <ExchangeLine key={r.id} row={r} />)}
      </Paged>
      <Paged section="other" first={data.sections.other} from={from} to={to} title={t('breakdown.otherTitle')}>
        {(rows: OtherRow[]) => rows.map((r) => <OtherLine key={r.id} row={r} />)}
      </Paged>
    </div>
  );
}

/**
 * One list: its first page from the popup's answer, the next ones asked for
 * by "Show more" (`section`, `page`), appended. Hidden when the period has
 * none of its kind. Its total is the API's, of every row, whatever is shown.
 */
function Paged<R, T>({
  section,
  first,
  from,
  to,
  title,
  children,
}: {
  section: Section;
  first: Page<R, T> | undefined;
  from: string;
  to: string;
  title: string;
  children: (rows: R[]) => React.ReactNode;
}) {
  const t = useTranslations('analytics.pnl');
  const apiError = useApiError();
  const [more, setMore] = useState<{ page: number; rows: R[] }>({ page: first?.page ?? 1, rows: [] });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  if (!first || first.total === 0) return null;
  const rows = [...first.rows, ...more.rows];
  const left = first.total - rows.length;

  const showMore = async () => {
    setLoading(true);
    setFailed(null);
    try {
      const next = more.page + 1;
      const r = await api.get(PATH, { params: { from, to, section, page: String(next), pageSize: String(first.pageSize) } });
      const body = (r.data.data ?? r.data) as PnlBreakdownData;
      const page = body.sections[section] as Page<R, T> | undefined;
      setMore({ page: next, rows: [...more.rows, ...(page?.rows ?? [])] });
    } catch (e) {
      setFailed(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section data-testid={`pnl-breakdown-${section}`} data-count={first.total}>
      <h3 className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 text-sm font-semibold text-foreground">
        <span>{title}</span>
        <SectionTotal section={section} totals={first.totals} />
      </h3>
      <ul className="divide-y divide-border/70 rounded-lg border border-border">{children(rows)}</ul>
      {failed !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {apiError(failed, t('breakdown.loadFailed'))}
        </p>
      )}
      {left > 0 && (
        <button
          type="button"
          data-testid={`pnl-breakdown-${section}-more`}
          disabled={loading}
          aria-busy={loading || undefined}
          onClick={() => void showMore()}
          className="mt-2 rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        >
          {t('breakdown.showMore', { count: Math.min(left, first.pageSize) })}
        </button>
      )}
    </section>
  );
}

function SectionTotal({ section, totals }: { section: Section; totals: unknown }) {
  const t = useTranslations('analytics.pnl');
  const v = totals as Record<string, number>;
  const amount =
    section === 'orders'
      ? v.grossProfitEgp
      : section === 'other'
        ? (v.recoveredEgp ?? 0) + (v.otherIncomeEgp ?? 0)
        : v.amountEgp;
  return (
    <span data-testid={`pnl-breakdown-${section}-total`} className="text-xs font-normal text-muted-foreground">
      {section === 'orders' ? t('breakdown.gross') : t('breakdown.total')} <Money value={Math.round(amount * 100) / 100} className="font-semibold text-foreground" />
    </span>
  );
}

/** A figure with its name above it, for the row's right-hand side. */
function Figure({ label, value, strong, testId }: { label: string; value: number; strong?: boolean; testId?: string }) {
  return (
    <div className="min-w-0 text-end">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p data-testid={testId} className={cn('whitespace-nowrap tabular-nums', strong ? cn('font-semibold', tone(value)) : 'text-foreground')}>
        <Money value={value} />
      </p>
    </div>
  );
}

function OrderLine({ row }: { row: OrderRow }) {
  const t = useTranslations('analytics.pnl');
  const { formatDate } = useDateFormat();
  const o = row.order;
  return (
    <li data-order={row.orderId} data-loss={row.grossProfitEgp < 0 || undefined} className="px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Link href={`/sales?order=${row.orderId}`} className={cn(linkClass, 'font-mono')}>
            {o?.orderNo ?? row.orderId.slice(0, 8)}
          </Link>
          {o && (
            <p className="truncate text-muted-foreground">
              <bdi>{o.customer}</bdi>
              {o.branch && (
                <>
                  {' · '}
                  <bdi>{o.branch}</bdi>
                </>
              )}
            </p>
          )}
          <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
            {row.saleEgp !== 0 && <li>{t('breakdown.soldOn', { day: formatDate(row.order?.soldOn ?? row.day) })}</li>}
            {row.events.map((e) => (
              <li key={e.id} data-event={e.kind}>
                {t(e.kind === 'return' ? 'breakdown.returnOn' : 'breakdown.priceCutOn', { day: formatDate(e.day) })}
                {' · '}
                <Money value={e.revenueEgp} className="text-destructive" />
              </li>
            ))}
          </ul>
        </div>
        <div className="grid grid-cols-3 gap-x-4">
          <Figure label={t('breakdown.revenue')} value={row.revenueEgp} testId="pnl-bd-revenue" />
          <Figure label={t('breakdown.cogs')} value={row.cogsEgp} testId="pnl-bd-cogs" />
          <Figure label={t('breakdown.gross')} value={row.grossProfitEgp} strong testId="pnl-bd-gross" />
        </div>
      </div>
    </li>
  );
}

function CycleLink({ cycle }: { cycle: Ref }) {
  if (!cycle) return null;
  return (
    <Link href={`/cycles/${cycle.id}/details`} className={cn(linkClass, 'font-mono')}>
      {cycle.code}
    </Link>
  );
}

function EntryMeta({ entry }: { entry: BreakdownEntry | null }) {
  const t = useTranslations('analytics.pnl');
  if (!entry) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
      <span data-testid="pnl-bd-paid-by">
        {entry.paidBy ? t('breakdown.paidBy', { name: entry.paidBy.name }) : t('breakdown.paidByBusiness')}
      </span>
      {entry.cycle && (
        <>
          <span aria-hidden="true">·</span>
          <CycleLink cycle={entry.cycle} />
        </>
      )}
    </p>
  );
}

function ExpenseLine({ row }: { row: ExpenseRow }) {
  const t = useTranslations('analytics.pnl');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  let name: React.ReactNode;
  let meta: React.ReactNode = null;
  if (row.kind === 'ledger') {
    name = (
      <Link href={`/ledger?entry=${row.id}`} className={linkClass}>
        <bdi>{row.category ? codeLabel('ledgerCategory', row.category) : '—'}</bdi>
      </Link>
    );
    meta = (
      <>
        {row.entry?.reason && <p className="truncate text-muted-foreground">{row.entry.reason}</p>}
        <EntryMeta entry={row.entry} />
      </>
    );
  } else if (row.kind === 'loss') {
    name = row.loss ? t('breakdown.goodsLost', { product: row.loss.product, qty: row.loss.qty, leg: row.loss.leg }) : t('goodsLost');
    meta = row.loss?.cycle ? (
      <p className="text-xs">
        <CycleLink cycle={row.loss.cycle} />
      </p>
    ) : null;
  } else {
    name = t('breakdown.samplesWrittenOff');
    meta = (
      <p className="text-xs">
        <Link href={`/sales?order=${row.id}`} className={cn(linkClass, 'font-mono')}>
          {row.order?.orderNo ?? row.id.slice(0, 8)}
        </Link>
        {row.order && <span className="text-muted-foreground"> · <bdi>{row.order.customer}</bdi></span>}
      </p>
    );
  }
  return (
    <li data-expense={row.id} data-kind={row.kind} className="flex items-start justify-between gap-4 px-3 py-2.5 text-sm">
      <div className="min-w-0">
        <div className="text-foreground">{name}</div>
        {meta}
        <p className="text-xs text-muted-foreground">{formatDate(row.day)}</p>
      </div>
      <Money value={row.amountEgp} className="whitespace-nowrap tabular-nums text-foreground" />
    </li>
  );
}

function ExchangeLine({ row }: { row: ExchangeRow }) {
  const t = useTranslations('analytics.pnl');
  const { formatDate } = useDateFormat();
  const { formatAmount, formatNumber } = useNumberFormat();
  const r = row.repayment;
  return (
    <li data-repayment={row.id} className="flex items-start justify-between gap-4 px-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="text-foreground">
          {r
            ? t('breakdown.repaid', { lender: r.lender, paid: formatAmount(r.paidEgp), rate: formatNumber(r.rateToEgp, { maximumFractionDigits: 4 }) })
            : '—'}
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          {r?.cycle && <CycleLink cycle={r.cycle} />}
          {r?.purchaseOrder && <span className="font-mono">{r.purchaseOrder.reference}</span>}
          <span>{formatDate(row.day)}</span>
        </p>
      </div>
      <Money value={row.amountEgp} className={cn('whitespace-nowrap tabular-nums', row.amountEgp > 0 ? 'text-destructive' : 'text-success')} />
    </li>
  );
}

function OtherLine({ row }: { row: OtherRow }) {
  const t = useTranslations('analytics.pnl');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  return (
    <li data-other={row.id} className="flex items-start justify-between gap-4 px-3 py-2.5 text-sm">
      <div className="min-w-0">
        <Link href={`/ledger?entry=${row.id}`} className={linkClass}>
          {t(row.line === 'recovered' ? 'breakdown.recovered' : 'breakdown.otherIncome')}
        </Link>
        {row.category && (
          <span className="text-muted-foreground">
            {' · '}
            <bdi>{codeLabel('ledgerCategory', row.category)}</bdi>
          </span>
        )}
        <EntryMeta entry={row.entry} />
        <p className="text-xs text-muted-foreground">{formatDate(row.day)}</p>
      </div>
      <Money value={row.amountEgp} className="whitespace-nowrap tabular-nums text-foreground" />
    </li>
  );
}

/** The popup's shape while it loads: the totals, then a list of rows. */
function BreakdownSkeleton() {
  return (
    <SkeletonRegion testId="pnl-breakdown-skeleton" className="space-y-6">
      <div className="max-w-md space-y-2">
        {repeat(5, (i) => (
          <div key={i} className="flex justify-between gap-3">
            <SkeletonText className="w-28" />
            <SkeletonText className="w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <SkeletonText className="w-48" />
        {repeat(4, (i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </SkeletonRegion>
  );
}
