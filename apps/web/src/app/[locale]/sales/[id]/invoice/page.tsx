'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { localName } from '@/lib/localized-name';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { FileX } from '@/components/ui/icons';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { BackLink } from '@/components/ui/back-link';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/components/ui/skeleton';
import { DataTable, PAPER_FIT, type Column } from '@/components/ui/data-table';
import { DocumentActions } from '@/components/ui/document-actions';
import { DocumentHeader } from '@/components/ui/document-header';
import { DOCUMENT_TAGLINE } from '@/components/ui/document-tagline';
import {
  DEFAULT_DOCUMENT_LANGUAGE,
  DOCUMENT_FONT,
  DocumentLanguageSwitch,
  DocumentLocale,
  documentDir,
  documentTranslator,
  type DocumentLanguage,
} from '@/components/ui/document-language';

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
    /** The Arabic name, null when none was entered (§3, 2026-10-14). */
    productAr: string | null;
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
  /** The branch it was sold to (§7, 2026-10-25); null on the owner. Absent before then. */
  branch?: { name: string; address: string | null; phone: string | null } | null;
  /** Prices lowered after the sale (§4, 2026-10-22); absent from an older API. */
  priceLowered?: string;
  returned: boolean;
  owes: string;
  /**
   * Edited after it was confirmed (§4, 2026-10-25): the lines are what the
   * shop holds now, at their price now, and the total its value now.
   */
  edited?: boolean;
  /** What was sold when it was confirmed — shown under an edited total. */
  soldTotal?: string;
  /** Money handed back in cash on returns — owed is total − paid + this. */
  refundedCash?: string;
  account: { balanceBefore: string; balanceAfter: string; balanceNow: string } | null;
}

/** How many lines the placeholder invoice shows — a typical order, not a page. */
const SKELETON_LINES = 3;

type InvoiceLine = Invoice['lines'][number];

/**
 * The lines table's columns, shared by the invoice and its placeholder
 * (components/ui/data-table.tsx): #, product, quantity, unit price, discount,
 * line total. The amounts fit "123,456.00 EGP" and never cut; the product
 * takes what is left and, on a document that is printed, wraps in full. On a phone the price and discount move under the name;
 * on paper (A4, 186mm wide) every column prints.
 */
function useInvoiceColumns(currency?: string): Column<InvoiceLine>[] {
  const t = useTranslations('sales.invoice');
  const { formatAmount, formatNumber } = useNumberFormat();
  const { locale } = useParams<{ locale: string }>();
  return [
    {
      key: 'line', header: t('line'), width: '2.5rem', kind: 'value', className: 'align-top text-muted-foreground',
      skeleton: { kind: 'text', share: 'w-3' }, cell: (_line, i) => formatNumber(i + 1),
    },
    {
      key: 'product', header: t('product'), width: 'auto', className: 'align-top',
      skeleton: {
        kind: 'custom',
        render: () => (
          <>
            <SkeletonText className="w-2/3" />
            <SkeletonText size="xs" className="w-1/3" />
            <SkeletonText size="xs" lineClassName="sm:hidden" className="w-1/4" />
          </>
        ),
      },
      cell: (line) => {
        const name = localName({ name: line.product, nameAr: line.productAr }, locale);
        return (
          <>
            {/* A paper document: the whole name, wrapped, never cut. */}
            <p className="font-medium text-foreground break-words" data-testid="invoice-line-product">
              <LatinText>{name}</LatinText>
            </p>
            <p className="text-xs text-muted-foreground"><LatinText dir="ltr" truncate>{line.sku}</LatinText></p>
            {/* On a phone, price and discount sit under the name. */}
            <p className="text-xs text-muted-foreground tabular-nums sm:hidden print:hidden sheet:hidden">
              <bdi dir="ltr">{formatAmount(line.unitPrice)}</bdi>
              {Number(line.discount) > 0 && (
                <>
                  {' · '}
                  {t('discount')} <bdi dir="ltr">- {formatAmount(line.discount)}</bdi>
                </>
              )}
            </p>
          </>
        );
      },
    },
    {
      key: 'quantity', header: t('quantity'), width: '4.5rem', kind: 'value', align: 'end', className: 'align-top',
      skeleton: { kind: 'text', share: 'w-1/3' }, cell: (line) => formatNumber(line.quantity),
    },
    {
      key: 'unitPrice', header: t('unitPrice'), width: '7.5rem', kind: 'value', align: 'end', className: 'align-top',
      hiddenBelow: 'sm', skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (line) => <bdi dir="ltr">{formatAmount(line.unitPrice)}</bdi>,
    },
    {
      key: 'discount', header: t('discount'), width: '7rem', kind: 'value', align: 'end', className: 'align-top',
      hiddenBelow: 'sm', skeleton: { kind: 'text', share: 'w-1/3' },
      cell: (line) => (Number(line.discount) > 0 ? <bdi dir="ltr">- {formatAmount(line.discount)}</bdi> : '—'),
    },
    {
      key: 'lineTotal', header: t('lineTotal'), width: '9rem', kind: 'value', align: 'end', className: 'align-top font-medium',
      skeleton: { kind: 'text', share: 'w-2/3' }, cell: (line) => <Money value={line.lineTotal} currency={currency} />,
    },
  ];
}

/**
 * The invoice before it arrives, traced from the article below: the header
 * with its number and date, Bill to, the lines table, the totals beside the
 * account box.
 */
function InvoiceSkeleton() {
  const t = useTranslations('sales.invoice');
  const locale = useLocale();
  const columns = useInvoiceColumns();
  // Every word that needs no data is the real word; only the figures wait.
  return (
    <div className="mx-auto max-w-4xl rounded-xl border border-border bg-card p-5 shadow-sm sm:p-8">
      <DocumentHeader title={t('title')} tagline={DOCUMENT_TAGLINE[locale === 'ar' ? 'ar' : 'en']}>
        <div className="flex items-center gap-1">
          <dt>{t('number')}: </dt>
          <dd><SkeletonText size="xs" className="w-24" /></dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>{t('date')}: </dt>
          <dd><SkeletonText size="xs" className="w-20" /></dd>
        </div>
      </DocumentHeader>

      <div className="border-b border-border py-4 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('billTo')}</p>
        <SkeletonText size="base" lineClassName="mt-1" className="w-40" />
      </div>

      <div className="py-4">
        <DataTable frame="none" density="compact" autoMin="10rem" isLoading skeletonRows={SKELETON_LINES} rows={[]} rowKey={(l) => l.id} columns={columns} />
      </div>

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div className="order-2 sm:order-1">
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('account')}</p>
            <FigureSkeleton label={t('balanceBefore')} />
            <FigureSkeleton label={t('thisInvoice')} />
            <FigureSkeleton label={t('balanceAfter')} strong />
          </div>
        </div>
        <div className="order-1 space-y-1 text-sm sm:order-2">
          <FigureSkeleton label={t('subtotal')} />
          <FigureSkeleton label={t('total')} strong />
          <FigureSkeleton label={t('paid')} />
          <FigureSkeleton label={t('owes')} strong />
        </div>
      </div>

    </div>
  );
}

/** `Figure` with its real label: a text-sm line, `py-0.5`, the amount waiting. */
function FigureSkeleton({ label, strong }: { label: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 py-0.5 text-foreground ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <SkeletonText className="w-24" />
    </div>
  );
}

/** A calendar day at noon UTC, so no browser timezone can move it a day. */
const noon = (day: string) => `${day}T12:00:00Z`;

/**
 * A confirmed sale as an invoice / delivery note (BUSINESS_LOGIC §4, I2
 * 2026-10-11), in the reader's language and direction. Download PDF, Share
 * PDF and Print are the shared DocumentActions, as on the contract (owner,
 * 2026-10-17); where the browser prints the page itself, the print
 * stylesheet (globals.css) keeps the menu, the top bar and the buttons off
 * the paper.
 *
 * A draft or a cancelled order has no invoice: the server refuses it, and the
 * refusal is what this page shows.
 */
export default function InvoicePage() {
  const t = useTranslations('sales.invoice');
  const apiError = useApiError();
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

  const [lang, setLang] = useState<DocumentLanguage>(DEFAULT_DOCUMENT_LANGUAGE);
  const back = () => router.push(`/${locale}/sales`);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="mt-3">
            <BackLink onClick={back} label={t('back')} />
          </div>
          <Skeleton className="h-11 w-24 rounded-lg sm:h-9" />
        </div>
        <SkeletonRegion>
          <InvoiceSkeleton />
        </SkeletonRegion>
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

  // The file name, share title and page numbers are in the document's language.
  const doc = documentTranslator(lang, 'sales.invoice');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        {/* BackLink pulls itself up 12px for its tap target; give it back
            here so it centres on the buttons beside it. */}
        <div className="mt-3">
          <BackLink onClick={back} label={t('back')} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DocumentLanguageSwitch testIdPrefix="invoice" value={lang} onChange={setLang} />
          <DocumentActions
            testIdPrefix="invoice"
            filename={`${data.orderNo}.pdf`}
            title={`${doc('title')} ${data.orderNo}`}
            pageLabel={(n, total) => doc('page', { n, total })}
            dir={documentDir(lang)}
            sheet={() => <InvoiceDocument data={data} lang={lang} sheet />}
          />
        </div>
      </div>

      <InvoiceDocument data={data} lang={lang} />
    </div>
  );
}


/**
 * The invoice itself. `sheet` lays it out flat for the PDF (DocumentActions):
 * no card border, shadow or padding, and — through the `sheet:` variant — the
 * printed layout whatever the screen it is made on.
 */
function InvoiceDocument({ data, lang, sheet = false }: { data: Invoice; lang: DocumentLanguage; sheet?: boolean }) {
  return (
    <DocumentLocale lang={lang}>
      <InvoiceSheet data={data} lang={lang} sheet={sheet} />
    </DocumentLocale>
  );
}

/** Inside DocumentLocale: every word, date and number here is in `lang`. */
function InvoiceSheet({ data, lang, sheet }: { data: Invoice; lang: DocumentLanguage; sheet: boolean }) {
  const t = useTranslations('sales.invoice');
  const tb = useTranslations('branches');
  const columns = useInvoiceColumns(data.currency);
  const { formatDate } = useDateFormat();
  const walkIn = data.customer.isWalkIn;

  return (
  <article
    data-testid={sheet ? undefined : 'invoice'}
    data-print-doc
    lang={lang}
    dir={documentDir(lang)}
    style={{ fontFamily: DOCUMENT_FONT }}
    className={`text-start ${sheet ? 'bg-card' : 'mx-auto max-w-4xl rounded-xl border border-border bg-card p-5 shadow-sm sm:p-8'}`}
  >
    {/* Who and what: the contract's header (owner, 2026-10-21). */}
    <DocumentHeader title={t('title')} tagline={DOCUMENT_TAGLINE[lang]}>
      <div>
        <dt className="inline">{t('number')}: </dt>
        <dd className="inline whitespace-nowrap font-mono font-semibold text-foreground" data-testid="invoice-number">
          <bdi dir="ltr">{data.orderNo}</bdi>
        </dd>
      </div>
      <div>
        <dt className="inline">{t('date')}: </dt>
        <dd className="inline text-foreground">{formatDate(noon(data.date))}</dd>
      </div>
    </DocumentHeader>

    <section className="border-b border-border py-4 text-sm" data-print-keep>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('billTo')}</p>
      <p className="mt-1 text-base font-semibold text-foreground" data-testid="invoice-customer">
        {walkIn ? t('walkIn') : <LatinText>{data.customer.displayName}</LatinText>}
      </p>
      {!walkIn && data.customer.phone && (
        <p className="text-muted-foreground" data-testid="invoice-phone">
          {t('phone')}: <LatinText dir="ltr">{data.customer.phone}</LatinText>
        </p>
      )}
      {/* The header is the owner's; the branch is where it goes (owner, 2026-10-25). */}
      {data.branch && (
        <div className="mt-3" data-testid="invoice-deliver-to">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tb('deliverTo')}</p>
          <p className="mt-1 font-medium text-foreground">
            <LatinText>{data.branch.name}</LatinText>
          </p>
          {data.branch.address && <p className="text-muted-foreground">{data.branch.address}</p>}
          {data.branch.phone && (
            <p className="text-muted-foreground">
              {t('phone')}: <LatinText dir="ltr">{data.branch.phone}</LatinText>
            </p>
          )}
        </div>
      )}
    </section>

    {/* The lines */}
    <div className="py-4">
      <DataTable
        frame="none"
        density="compact"
        autoMin="10rem"
        // On paper the table takes A4's width, not its screen minimum: the product
        // name wraps rather than the last column running off the sheet (TC-COL-05).
        tableClassName={PAPER_FIT}
        tableTestId="invoice-lines"
        rows={data.lines}
        rowKey={(line) => line.id}
        rowProps={() => ({ 'data-testid': 'invoice-line' })}
        columns={columns}
      />
    </div>

    {/* Totals, and the shop's account beside them */}
    <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 print:grid-cols-2 sheet:grid-cols-2" data-print-keep>
      <div className="order-2 sm:order-1 print:order-1 sheet:order-1">
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
      <dl className="order-1 space-y-1 text-sm sm:order-2 print:order-2 sheet:order-2">
        <Figure label={t('subtotal')} value={<Money value={data.subtotal} currency={data.currency} />} />
        {Number(data.discount) > 0 && (
          <Figure
            label={t('discountTotal')}
            value={<bdi dir="ltr">- <Money value={data.discount} currency={data.currency} /></bdi>}
          />
        )}
        <Figure testId="invoice-total" label={t('total')} value={<Money value={data.total} currency={data.currency} />} strong />
        {data.edited && (
          <p className="text-xs text-muted-foreground" data-testid="invoice-edited">
            {t('edited')}
          </p>
        )}
        <Figure testId="invoice-paid" label={t('paid')} value={<Money value={data.paid} currency={data.currency} />} />
        {Number(data.priceLowered ?? 0) > 0 && (
          <Figure
            testId="invoice-price-lowered"
            label={t('priceLowered')}
            value={<bdi dir="ltr">- <Money value={data.priceLowered!} currency={data.currency} /></bdi>}
          />
        )}
        {Number(data.credited) > 0 && (
          <Figure
            testId="invoice-credited"
            label={t('credited')}
            value={<bdi dir="ltr">- <Money value={data.credited} currency={data.currency} /></bdi>}
          />
        )}
        {Number(data.refundedCash ?? 0) > 0 && (
          <Figure
            testId="invoice-refunded-cash"
            label={t('refundedCash')}
            value={<bdi dir="ltr">+ <Money value={data.refundedCash!} currency={data.currency} /></bdi>}
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

    <p className="mt-6 hidden text-xs text-muted-foreground print:block sheet:block">
      {t('printedOn', { date: formatDate(new Date().toISOString()) })}
    </p>
  </article>
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
