'use client';

import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { FileX, Loader2, Printer } from 'lucide-react';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { BackLink } from '@/components/ui/back-link';
import { EmptyState } from '@/components/ui/empty-state';

/** `GET /sales/orders/:id/invoice` (api SalesService.invoice). */
interface Invoice {
  id: string;
  orderNo: string;
  status: string;
  currency: string;
  date: string;
  customer: { id: string; displayName: string; phone: string | null; isWalkIn: boolean };
  lines: {
    id: string;
    product: string;
    sku: string;
    quantity: string;
    unitPrice: string;
    discount: string;
    lineTotal: string;
  }[];
  subtotal: string;
  discount: string;
  total: string;
  paid: string;
  credited: string;
  returned: boolean;
  owes: string;
  account: { balanceBefore: string; balanceAfter: string; balanceNow: string } | null;
}

/** A calendar day at noon UTC, so no browser timezone can move it a day. */
const noon = (day: string) => `${day}T12:00:00Z`;

/**
 * A confirmed sale as an invoice / delivery note (BUSINESS_LOGIC §4, I2
 * 2026-10-11), in the reader's language and direction. "Print" is the
 * browser's own print through the app's print stylesheet (globals.css): the
 * menu, the top bar and these buttons stay off the paper, and the page is A4.
 *
 * A draft or a cancelled order has no invoice: the server refuses it, and the
 * refusal is what this page shows.
 */
export default function InvoicePage() {
  const t = useTranslations('sales.invoice');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { formatDate } = useDateFormat();
  const { formatAmount, formatNumber } = useNumberFormat();
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const router = useRouter();

  const { data, isLoading, error } = useQuery<Invoice>({
    queryKey: ['sale', id, 'invoice'],
    queryFn: () => api.get(`/sales/orders/${id}/invoice`).then((r) => r.data.data ?? r.data),
    retry: false,
    // A paper copy must say what is true when it is printed. A payment taken
    // by someone else (another tab, the assistant) invalidates nothing in this
    // browser, so a cached invoice reopened within the app's minute of
    // staleness showed the old "paid" (TC-IV-05).
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const back = () => router.push(`/${locale}/sales`);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="me-2 h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink onClick={back} label={t('back')} />
        <div className="rounded-xl border border-border bg-card" data-testid="invoice-refused">
          <EmptyState
            icon={FileX}
            title={t('notAvailable')}
            description={apiError(error, t('notAvailable'))}
            action={{ label: t('back'), onClick: back }}
          />
        </div>
      </div>
    );
  }

  const walkIn = data.customer.isWalkIn;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        {/* BackLink pulls itself up 12px for its tap target; give it back
            here so it centres on the Print button beside it. */}
        <div className="mt-3">
          <BackLink onClick={back} label={t('back')} />
        </div>
        <button
          type="button"
          data-testid="invoice-print"
          onClick={() => window.print()}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
        >
          <Printer className="h-4 w-4" />
          {tc('print')}
        </button>
      </div>

      <article
        data-testid="invoice"
        data-print-doc
        className="mx-auto max-w-4xl rounded-xl border border-border bg-card p-5 shadow-sm sm:p-8"
      >
        {/* Who and what */}
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between" data-print-keep>
          <div>
            <p className="text-lg font-bold text-foreground">{tc('brand')}</p>
            <h1 className="mt-1 text-xl font-semibold text-foreground">{t('title')}</h1>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:text-end">
            <dt className="text-muted-foreground">{t('number')}</dt>
            <dd className="font-mono font-semibold text-foreground" data-testid="invoice-number">
              <bdi dir="ltr">{data.orderNo}</bdi>
            </dd>
            <dt className="text-muted-foreground">{t('date')}</dt>
            <dd className="text-foreground">{formatDate(noon(data.date))}</dd>
          </dl>
        </header>

        <section className="border-b border-border py-4 text-sm" data-print-keep>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('billTo')}</p>
          <p className="mt-1 text-base font-semibold text-foreground" data-testid="invoice-customer">
            {walkIn ? t('walkIn') : <LatinText>{data.customer.displayName}</LatinText>}
          </p>
          {!walkIn && data.customer.phone && (
            <p className="text-muted-foreground">
              {t('phone')}: <LatinText dir="ltr">{data.customer.phone}</LatinText>
            </p>
          )}
        </section>

        {/* The lines */}
        <div className="py-4">
          <table className="w-full text-sm" data-testid="invoice-lines">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground [&>th]:px-2 [&>th]:py-2 [&>th:first-child]:ps-0 [&>th:last-child]:pe-0">
                <th className="w-6 text-start font-medium">{t('line')}</th>
                <th className="text-start font-medium">{t('product')}</th>
                <th className="text-end font-medium">{t('quantity')}</th>
                <th className="hidden text-end font-medium sm:table-cell print:table-cell">{t('unitPrice')}</th>
                <th className="hidden text-end font-medium sm:table-cell print:table-cell">{t('discount')}</th>
                <th className="text-end font-medium">{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border [&>tr>td]:px-2 [&>tr>td]:py-2 [&>tr>td:first-child]:ps-0 [&>tr>td:last-child]:pe-0">
              {data.lines.map((line, i) => (
                <tr key={line.id} data-testid="invoice-line">
                  <td className="align-top tabular-nums text-muted-foreground">{formatNumber(i + 1)}</td>
                  <td className="align-top">
                    <p className="font-medium text-foreground"><LatinText>{line.product}</LatinText></p>
                    <p className="text-xs text-muted-foreground"><LatinText dir="ltr">{line.sku}</LatinText></p>
                    {/* On a phone, price and discount sit under the name. */}
                    <p className="text-xs text-muted-foreground tabular-nums sm:hidden print:hidden">
                      <bdi dir="ltr">{formatAmount(line.unitPrice)}</bdi>
                      {Number(line.discount) > 0 && (
                        <>
                          {' · '}
                          {t('discount')} <bdi dir="ltr">- {formatAmount(line.discount)}</bdi>
                        </>
                      )}
                    </p>
                  </td>
                  <td className="whitespace-nowrap text-end align-top tabular-nums">{formatNumber(line.quantity)}</td>
                  <td className="hidden whitespace-nowrap text-end align-top tabular-nums sm:table-cell print:table-cell">
                    <bdi dir="ltr">{formatAmount(line.unitPrice)}</bdi>
                  </td>
                  <td className="hidden whitespace-nowrap text-end align-top tabular-nums sm:table-cell print:table-cell">
                    {Number(line.discount) > 0 ? <bdi dir="ltr">- {formatAmount(line.discount)}</bdi> : '—'}
                  </td>
                  <td className="whitespace-nowrap text-end align-top font-medium tabular-nums">
                    <Money value={line.lineTotal} currency={data.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals, and the shop's account beside them */}
        <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 print:grid-cols-2" data-print-keep>
          <div className="order-2 sm:order-1 print:order-1">
            {walkIn ? (
              <p className="text-sm text-muted-foreground" data-testid="invoice-paid-in-full">{t('paidInFull')}</p>
            ) : data.account ? (
              <div className="rounded-lg border border-border p-3 text-sm" data-testid="invoice-account">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('account')}</p>
                <dl>
                <Figure label={t('balanceBefore')} value={<Money value={data.account.balanceBefore} />} />
                <Figure label={t('thisInvoice')} value={<Money value={data.total} currency={data.currency} />} />
                <Figure
                  testId="invoice-balance-after"
                  label={t('balanceAfter')}
                  value={<Money value={data.account.balanceAfter} />}
                  strong
                />
                </dl>
              </div>
            ) : null}
          </div>
          <dl className="order-1 space-y-1 text-sm sm:order-2 print:order-2">
            <Figure label={t('subtotal')} value={<Money value={data.subtotal} currency={data.currency} />} />
            {Number(data.discount) > 0 && (
              <Figure
                label={t('discountTotal')}
                value={<bdi dir="ltr">- <Money value={data.discount} currency={data.currency} /></bdi>}
              />
            )}
            <Figure testId="invoice-total" label={t('total')} value={<Money value={data.total} currency={data.currency} />} strong />
            <Figure testId="invoice-paid" label={t('paid')} value={<Money value={data.paid} currency={data.currency} />} />
            {Number(data.credited) > 0 && (
              <Figure
                testId="invoice-credited"
                label={t('credited')}
                value={<bdi dir="ltr">- <Money value={data.credited} currency={data.currency} /></bdi>}
              />
            )}
            {data.returned && <p className="text-xs text-muted-foreground" data-testid="invoice-returned">{t('returnedInFull')}</p>}
            <Figure
              testId="invoice-owes"
              label={t('owes')}
              value={<Money value={data.owes} currency={data.currency} />}
              strong
            />
          </dl>
        </div>

        {/* A delivery note is signed for. */}
        <footer className="mt-10 grid grid-cols-2 gap-8 text-sm text-muted-foreground" data-print-keep>
          <div className="border-t border-border pt-2">{t('receivedBy')}</div>
          <div className="border-t border-border pt-2">{t('deliveredBy')}</div>
        </footer>
        <p className="mt-6 hidden text-xs text-muted-foreground print:block">
          {t('printedOn', { date: formatDate(new Date().toISOString()) })}
        </p>
      </article>
    </div>
  );
}

function Figure({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-0.5 ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}>
      <dt>{label}</dt>
      <dd data-testid={testId} className="whitespace-nowrap tabular-nums">{value}</dd>
    </div>
  );
}
