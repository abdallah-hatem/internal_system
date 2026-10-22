'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, History as HistoryIcon } from 'lucide-react';

import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCodeLabel } from '@/lib/labels';
import { localName } from '@/lib/localized-name';
import { cn } from '@/lib/utils';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { LatinText } from '@/components/ui/latin-text';
import { Money } from '@/components/ui/money';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';

/**
 * An order's full history (BUSINESS_LOGIC §4 "An order's full history", owner
 * 2026-10-22), drawn from `GET /sales/orders/:id/history`.
 *
 * Every figure here is the API's: what each event did and what the order owed
 * after it are replayed on the server, the same way the shop's statement is.
 * Nothing is added up in the browser — a second sum here would be a second
 * definition of what a shop owes (CLAUDE.md §11).
 */

export type HistoryKind =
  | 'CREATED'
  | 'CONFIRMED'
  | 'SAMPLES_LEFT'
  | 'SAMPLES_BOUGHT'
  | 'SAMPLES_RETURNED'
  | 'SAMPLES_WRITTEN_OFF'
  | 'PAYMENT'
  | 'REVERSAL'
  | 'RETURN'
  | 'PRICE_ADJUSTED'
  | 'CANCELLED';

export interface HistoryLine {
  product: string;
  productAr?: string | null;
  qty: string;
  unitPrice?: string;
  previousUnitPrice?: string;
  lineTotal?: string;
}

export interface HistoryEvent {
  kind: HistoryKind;
  date: string;
  at: string;
  by: string | null;
  reference: string | null;
  amount: string | null;
  effect: string;
  owes: string;
  method?: string | null;
  reason?: string | null;
  lines?: HistoryLine[];
}

export interface HistoryProduct {
  saleItemId: string;
  product: string;
  productAr?: string | null;
  startedWith: string;
  returned: string;
  holds: string;
  soldAt: string;
  priceNow: string;
}

export interface OrderHistoryData {
  orderId: string;
  orderNo: string;
  status: string;
  events: HistoryEvent[];
  products: HistoryProduct[];
  owes: string;
  replayedOwes: string;
}

/**
 * The history's cache entry sits under the order's own (`['sale', id]`), so
 * everything that already refreshes an order — a payment, a return, a cut —
 * refreshes its history too, with no list of keys to keep in step.
 */
export const orderHistoryKey = (orderId: string) => ['sale', orderId, 'history'] as const;

export function useOrderHistory(orderId: string, enabled = true) {
  return useQuery({
    queryKey: orderHistoryKey(orderId),
    queryFn: () =>
      api.get(`/sales/orders/${orderId}/history`).then((r) => (r.data.data ?? r.data) as OrderHistoryData),
    enabled,
  });
}

const toCents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/** Payments and their reversals carry a method; returns a refund method. */
const METHOD_KIND: Partial<Record<HistoryKind, 'paymentMethod' | 'refund'>> = {
  PAYMENT: 'paymentMethod',
  REVERSAL: 'paymentMethod',
  RETURN: 'refund',
};

/** The dot's colour says what kind of thing happened, never how much. */
const DOT: Record<HistoryKind, string> = {
  CREATED: 'bg-muted-foreground',
  SAMPLES_LEFT: 'bg-accent-500',
  CONFIRMED: 'bg-primary',
  SAMPLES_BOUGHT: 'bg-primary',
  PAYMENT: 'bg-success',
  REVERSAL: 'bg-destructive',
  RETURN: 'bg-accent-500',
  PRICE_ADJUSTED: 'bg-accent-500',
  SAMPLES_RETURNED: 'bg-muted-foreground',
  SAMPLES_WRITTEN_OFF: 'bg-destructive',
  CANCELLED: 'bg-destructive',
};

export function OrderHistory({ orderId, currency = 'EGP' }: { orderId: string; currency?: string }) {
  const t = useTranslations('sales.history');
  const locale = useLocale();
  const { formatNumber } = useNumberFormat();
  const history = useOrderHistory(orderId);

  if (history.isPending) return <OrderHistorySkeleton />;

  if (history.isError || !history.data) {
    return (
      <EmptyState
        size="compact"
        icon={AlertTriangle}
        title={t('error')}
        action={{ label: t('retry'), onClick: () => void history.refetch() }}
        className="text-destructive"
      />
    );
  }

  const data = history.data;
  const productColumns: Column<HistoryProduct>[] = [
    {
      key: 'product',
      header: t('product'),
      width: 'auto',
      kind: 'name',
      title: (p) => localName({ name: p.product, nameAr: p.productAr }, locale),
      cell: (p) => <LatinText>{localName({ name: p.product, nameAr: p.productAr }, locale)}</LatinText>,
      skeleton: { kind: 'text', share: '70%' },
    },
    ...(
      [
        ['startedWith', 'startedWith'],
        ['returned', 'returned'],
        ['holds', 'holds'],
      ] as const
    ).map(
      ([key, label]): Column<HistoryProduct> => ({
        key,
        header: t(label),
        width: '6.5rem',
        kind: 'value',
        align: 'end',
        className: 'tabular-nums',
        cell: (p) => formatNumber(p[key]),
        cellProps: (p) => ({ 'data-testid': `history-${key}-${p.saleItemId}` }),
      }),
    ),
    {
      key: 'soldAt',
      header: t('soldAt'),
      width: '8rem',
      kind: 'value',
      align: 'end',
      hiddenBelow: 'sm',
      className: 'tabular-nums',
      cell: (p) => <Money value={p.soldAt} currency={currency} />,
    },
    {
      key: 'priceNow',
      header: t('priceNow'),
      width: '8rem',
      kind: 'value',
      align: 'end',
      className: (p) => cn('tabular-nums', toCents(p.priceNow) < toCents(p.soldAt) && 'font-medium text-foreground'),
      cell: (p) => <Money value={p.priceNow} currency={currency} />,
      cellProps: (p) => ({ 'data-testid': `history-price-now-${p.saleItemId}` }),
    },
  ];

  const last = data.events[data.events.length - 1];
  // Both figures are the API's; the browser only says whether they agree.
  const endsAt = last ? last.owes : data.replayedOwes;
  const agrees = toCents(endsAt) === toCents(data.owes);

  return (
    <div className="space-y-6" data-testid="order-history">
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('products')}</h3>
        <DataTable
          className="hidden sm:block"
          frame="none"
          density="compact"
          autoMin="8rem"
          columns={productColumns}
          rows={data.products}
          rowKey={(p) => p.saleItemId}
          testId="history-products"
        />
        {/* A phone has no room for five columns side by side: the same figures,
            one product to a card, rather than a table to scroll sideways. */}
        <ul className="space-y-2 sm:hidden" data-testid="history-products-cards">
          {data.products.map((p) => (
            <li key={p.saleItemId} className="rounded-lg border border-border px-3 py-2">
              <p className="truncate text-sm font-medium text-foreground">
                <LatinText>{localName({ name: p.product, nameAr: p.productAr }, locale)}</LatinText>
              </p>
              <dl className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1.5 text-xs">
                {(
                  [
                    ['startedWith', formatNumber(p.startedWith)],
                    ['returned', formatNumber(p.returned)],
                    ['holds', formatNumber(p.holds)],
                  ] as const
                ).map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <dt className="truncate text-muted-foreground">{t(key)}</dt>
                    <dd className="tabular-nums text-foreground">{value}</dd>
                  </div>
                ))}
                <div className="col-span-3 flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
                  <dt className="text-muted-foreground">{t('priceNow')}</dt>
                  <dd className="whitespace-nowrap tabular-nums font-medium text-foreground">
                    <Money value={p.priceNow} currency={currency} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">{t('timeline')}</h3>
        {data.events.length === 0 ? (
          <EmptyState size="compact" icon={HistoryIcon} title={t('empty')} description={t('emptyHint')} />
        ) : (
          <ol className="relative" data-testid="history-events">
            {data.events.map((event, i) => (
              <TimelineEvent
                key={`${event.kind}-${event.at}-${i}`}
                event={event}
                orderNo={data.orderNo}
                index={i}
                last={i === data.events.length - 1}
                currency={currency}
              />
            ))}
          </ol>
        )}
      </section>

      <dl
        className="grid grid-cols-1 gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
        data-testid="history-totals"
      >
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{t('replayEnds')}</dt>
          <dd className="font-medium tabular-nums text-foreground" data-testid="history-replayed-owes">
            <Money value={endsAt} currency={currency} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{t('owesNow')}</dt>
          <dd className="font-semibold tabular-nums text-foreground" data-testid="history-owes">
            <Money value={data.owes} currency={currency} />
          </dd>
        </div>
      </dl>
      {!agrees && (
        <p
          role="alert"
          data-testid="history-mismatch"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t('mismatch', {
              replayed: formatNumber(endsAt, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
              owes: formatNumber(data.owes, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            })}
          </span>
        </p>
      )}
    </div>
  );
}

function TimelineEvent({
  event,
  orderNo,
  index,
  last,
  currency,
}: {
  event: HistoryEvent;
  orderNo: string;
  index: number;
  last: boolean;
  currency: string;
}) {
  const t = useTranslations('sales.history');
  const ts = useTranslations('sales');
  const locale = useLocale();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const codeLabel = useCodeLabel();
  // In an Arabic sentence each figure and each Latin note is its own run, so
  // "1,250.00 ← 1,150.00" keeps its order and "100 off" is not turned into
  // "off 100" by the bidi algorithm. English is left exactly as it is.
  const iso = (v: string) => (locale === 'ar' ? `\u2068${v}\u2069` : v);

  const methodKind = METHOD_KIND[event.kind];
  const method = !event.method
    ? null
    : methodKind === 'refund'
      ? event.method === 'CREDIT_NOTE'
        ? ts('creditNote')
        : ts('cashRefund')
      : codeLabel('paymentMethod', event.method);
  const effect = toCents(event.effect);

  return (
    <li
      className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0"
      data-testid={`history-event-${index}`}
      data-kind={event.kind}
      data-owes={event.owes}
    >
      {/* The rail: a dot per event, joined to the next one. */}
      <span aria-hidden="true" className="relative flex justify-center">
        <span className={cn('mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-background', DOT[event.kind])} />
        {!last && <span className="absolute top-4 bottom-[-1.25rem] w-px bg-border" />}
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm font-medium text-foreground">
            {t(`kinds.${event.kind}`)}
            {/* A return's or a payment's own number; the order's is in the title already. */}
            {event.reference && event.reference !== orderNo && (
              <span className="ms-2 text-xs font-normal text-muted-foreground">
                <LatinText>{event.reference}</LatinText>
              </span>
            )}
          </p>
          <p className="shrink-0 text-xs text-muted-foreground" data-testid="history-event-date">
            {formatDate(event.date)}
            {event.by && <> · {t('by', { name: event.by })}</>}
          </p>
        </div>

        {(event.lines?.length ?? 0) > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
            {event.lines!.map((line, i) => (
              <li key={`${line.product}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="min-w-0 truncate">
                  <LatinText>{localName({ name: line.product, nameAr: line.productAr }, locale)}</LatinText>
                </span>
                <span className="shrink-0 tabular-nums" data-testid="history-line">
                  {line.previousUnitPrice ? (
                    <>
                      {t('priceChange', {
                        from: iso(formatNumber(line.previousUnitPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
                        to: iso(formatNumber(line.unitPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
                      })}
                      {' · '}
                      {t('units', { qty: iso(formatNumber(line.qty)) })}
                    </>
                  ) : line.unitPrice ? (
                    t('lineAt', {
                      qty: iso(formatNumber(line.qty)),
                      price: iso(formatNumber(line.unitPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
                    })
                  ) : (
                    t('units', { qty: iso(formatNumber(line.qty)) })
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(method || event.reason) && (
          <p className="mt-1 text-xs text-muted-foreground">
            {method}
            {method && event.reason && ' · '}
            {event.reason && t('reason', { reason: iso(event.reason) })}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
          <span className="tabular-nums text-muted-foreground">
            {event.amount !== null && (
              <>
                {event.kind === 'RETURN' ? `${t('refund')}: ` : ''}
                <Money value={event.amount} currency={currency} />
              </>
            )}
            {effect !== 0 && (
              <span
                data-testid="history-event-effect"
                className={cn('ms-2 text-xs', effect < 0 ? 'text-success' : 'text-foreground')}
              >
                (<SignedMoney cents={effect} currency={currency} />)
              </span>
            )}
          </span>
          <span className="ms-auto shrink-0 tabular-nums">
            <span className="text-xs text-muted-foreground">{t('owesAfter')} </span>
            <Money value={event.owes} currency={currency} className="font-medium text-foreground" />
          </span>
        </div>
      </div>
    </li>
  );
}

/** "+1,250.00 EGP" or "−300.00 EGP": what an event did to what is owed. */
function SignedMoney({ cents, currency }: { cents: number; currency: string }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {cents > 0 ? '+' : ''}
      <Money value={cents / 100} currency={currency} />
    </span>
  );
}

/** Traces the timeline: a table of three rows, then dots down a rail with two lines each. */
export function OrderHistorySkeleton() {
  return (
    <SkeletonRegion className="space-y-6" testId="order-history-skeleton">
      <div>
        <SkeletonText size="sm" className="mb-3 w-24" />
        <div className="space-y-2">
          {repeat(3, (i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <SkeletonText size="sm" className="mb-3 w-20" />
        {repeat(4, (i) => (
          <div key={i} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-5">
            <span className="flex justify-center">
              <Skeleton className="mt-1.5 h-2.5 w-2.5 rounded-full" />
            </span>
            <div className="space-y-1.5">
              <div className="flex justify-between gap-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="flex justify-between gap-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-28" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
