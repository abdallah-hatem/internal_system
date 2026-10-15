'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useNumberFormat } from '@/lib/numbers';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';

/** GET /customers/to-collect — `common/receivables.ts` `toCollect` on the API. */
export interface ToCollectRow {
  customerId: string;
  customer: string;
  outstanding: string;
  overdue: string;
  openOrders: number;
  /** The day in Cairo the oldest order still owing was placed, YYYY-MM-DD. */
  oldestUnpaidOn: string;
}
export interface ToCollectData {
  totalOwed: string;
  totalOverdue: string;
  customers: number;
  rows: ToCollectRow[];
}

export const TO_COLLECT_ROWS = 5;

/** Whole days from a Cairo calendar day to today's, never below zero. */
export function daysSince(day: string, today: Date = new Date()): number {
  const cairoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(today);
  const ms = Date.parse(`${cairoToday}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

const isOverdue = (r: ToCollectRow) => Number(r.overdue) > 0;

/** A phone row, traced: name over orders · age; the amount at the end. */
function ToCollectItemSkeleton() {
  return (
    <div data-testid="skeleton-row" className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <SkeletonText className="w-2/3" />
        <SkeletonText size="xs" className="w-1/3" />
      </div>
      <SkeletonText lineClassName="justify-end" className="w-24" />
    </div>
  );
}

/**
 * The customers to chase first (owner, 2026-10-15): overdue before not, then
 * the largest balance — the order and the totals come from the API, which
 * reads the same receivables and overdue figures as the assistant, so nothing
 * here is worked out a second time. A row opens the customer; View all opens
 * Customers sorted by balance.
 */
export function ToCollect() {
  const t = useTranslations('dashboard');
  const router = useRouter();
  // Latin digits in both languages, as every figure in the app (lib/numbers).
  const { formatNumber } = useNumberFormat();
  const days = (day: string) => {
    const count = daysSince(day);
    return t('toCollectDays', { count, n: formatNumber(count) });
  };
  const { data, isLoading, isError } = useQuery<ToCollectData>({
    queryKey: ['customers', 'to-collect', TO_COLLECT_ROWS],
    queryFn: () =>
      api.get('/customers/to-collect', { params: { limit: TO_COLLECT_ROWS } }).then((r) => r.data.data ?? r.data),
  });
  const rows = data?.rows ?? [];
  const open = (r: ToCollectRow) => router.push(`/customers/${r.customerId}`);

  const amount = (r: ToCollectRow) => (
    <>
      <Money value={r.outstanding} className="block text-sm font-medium text-card-foreground" />
      {isOverdue(r) && (
        <span className="block text-xs font-medium text-destructive" data-testid="to-collect-overdue">
          <Money value={r.overdue} /> {t('toCollectOverdueWord')}
        </span>
      )}
    </>
  );

  const columns: Column<ToCollectRow>[] = [
    {
      key: 'customer',
      header: t('toCollectCustomer'),
      width: 'auto',
      kind: 'plain',
      skeleton: { kind: 'custom', render: () => (<><SkeletonText className="w-2/3" /><SkeletonText size="xs" className="w-1/3" /></>) },
      title: (r) => r.customer,
      cell: (r) => (
        <>
          <LatinText truncate className="block text-sm font-medium text-card-foreground">{r.customer}</LatinText>
          <span className="block text-xs text-muted-foreground">{t('toCollectOrders', { count: r.openOrders, n: formatNumber(r.openOrders) })}</span>
        </>
      ),
    },
    {
      key: 'owes',
      header: t('toCollectOwes'),
      width: '10.5rem',
      kind: 'value',
      align: 'end',
      skeleton: { kind: 'text', share: 'w-3/4' },
      cell: amount,
    },
    {
      key: 'oldest',
      header: t('toCollectOldest'),
      width: '7.5rem',
      kind: 'value',
      align: 'end',
      skeleton: { kind: 'text', share: 'w-1/2' },
      className: 'text-muted-foreground',
      cell: (r) => days(r.oldestUnpaidOn),
    },
  ];

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-6" data-testid="to-collect">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-card-foreground">
          <Banknote aria-hidden="true" className="size-5 text-muted-foreground" />
          {t('toCollect')}
        </h3>
        {rows.length > 0 && (
          <Link
            href="/customers?sort=balance"
            className="shrink-0 text-sm font-medium text-primary-600 hover:underline"
            data-testid="to-collect-all"
          >
            {t('toCollectAll')}
          </Link>
        )}
      </div>

      {isError ? (
        <p role="alert" className="text-sm text-destructive">{t('toCollectError')}</p>
      ) : !isLoading && rows.length === 0 ? (
        <EmptyState icon={Banknote} title={t('toCollectEmpty')} description={t('toCollectEmptyHint')} className="py-6" />
      ) : (
        <>
          {isLoading ? (
            <SkeletonText lineClassName="mb-3" className="w-2/3" />
          ) : (
            <p className="mb-3 text-sm text-muted-foreground" data-testid="to-collect-total">
              {t('toCollectTotal')}{' '}
              <Money value={data!.totalOwed} className="font-semibold text-card-foreground" />
              {Number(data!.totalOverdue) > 0 && (
                <>
                  {' · '}
                  <span className="font-medium text-destructive">
                    <Money value={data!.totalOverdue} /> {t('toCollectOverdueWord')}
                  </span>
                </>
              )}
            </p>
          )}

          <DataTable
            className="hidden min-[1400px]:block"
            frame="none"
            density="compact"
            // A half-width card: the table from 1400px up, the list below —
            // at 1024 and 1280 the card is too narrow and the table's last
            // column was cut. The
            // name column may narrow to 9rem; the default 14rem clipped the
            // last column at 1440.
            autoMin="9rem"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.customerId}
            isLoading={isLoading}
            skeletonRows={TO_COLLECT_ROWS}
            onRowClick={open}
            rowProps={(r) => ({ 'data-testid': 'to-collect-row', 'data-overdue': isOverdue(r) ? 'true' : undefined })}
            caption={t('toCollect')}
          />

          {isLoading ? (
            <SkeletonRegion className="divide-y divide-border min-[1400px]:hidden">
              {repeat(TO_COLLECT_ROWS, (i) => <ToCollectItemSkeleton key={i} />)}
            </SkeletonRegion>
          ) : (
            <ul className="divide-y divide-border min-[1400px]:hidden">
              {rows.map((r) => (
                <li key={r.customerId}>
                  <Link
                    href={`/customers/${r.customerId}`}
                    className="flex items-start justify-between gap-3 py-2.5"
                    data-testid="to-collect-item"
                  >
                    <div className="min-w-0">
                      <LatinText truncate className="block text-sm font-medium text-card-foreground">{r.customer}</LatinText>
                      <span className="block text-xs text-muted-foreground">
                        {t('toCollectOrders', { count: r.openOrders, n: formatNumber(r.openOrders) })} · {days(r.oldestUnpaidOn)}
                      </span>
                    </div>
                    <div className="shrink-0 text-end">{amount(r)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
