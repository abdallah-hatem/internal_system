'use client';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

/**
 * Everything about one shop, in one place.
 *
 * The business thinks per customer — what does this shop owe, what have they
 * paid, what did they promise — but the system was organised per document
 * type, so answering that meant four screens (customers for the balance,
 * sales for the orders, payments for the receipts, payment plans for the
 * schedule) with no links between them and no screen that knew the customer.
 *
 * Taking money was the worst of it: record a payment on one page, find it in
 * a list, then allocate it to an order chosen from every order in the system.
 * Here it is one action, through `RecordPaymentDialog` — the same form the
 * Payments page and an order open (rule 11).
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api } from '../../../../lib/api';
import { useDateFormat } from '../../../../lib/dates';
import { useCodeLabel } from '../../../../lib/labels';
import { Money } from '../../../../components/ui/money';
import { EmptyState } from '../../../../components/ui/empty-state';
import {
  RecordPaymentDialog,
  oldestFirst,
} from '../../../../components/payments/RecordPaymentDialog';
import {
  Wallet, ShoppingCart, FileSignature, AlertTriangle, Plus,
} from '@/components/ui/icons';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';

import { DataTable, type Column } from '@/components/ui/data-table';
import { BackLink } from '../../../../components/ui/back-link';
import { CustomerStatement } from '../../../../components/customers/customer-statement';
import { ContractsList } from '@/components/payments/contracts-list';
import { OrderTotal } from '@/components/sales/value-now';
interface SaleOrder {
  id: string;
  orderNo: string;
  status: string;
  total: number | string;
  /** Worth now, after returns and price cuts (§4, 2026-10-22), from the API. */
  valueNowEgp?: string;
  outstanding: number | string;
  currency: string;
  createdAt: string;
  /** The day it was sold (§4). */
  orderedAt?: string;
}

interface PaymentRecord {
  id: string;
  amount: number | string;
  currency: string;
  method: string;
  status: string;
  receivedOn: string;
  reference?: string | null;
  allocations?: { amount: number | string }[];
}

const num = (v: unknown) => Number(v ?? 0);

export default function CustomerPage() {
  const t = useTranslations('customers');
  const tp = useTranslations('payments');
  const ts = useTranslations('sales');
  const tk = useTranslations('contracts');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const router = useRouter();

  const [showPay, setShowPay] = useState(false);

  const { data: customer, isLoading } = useQuery<any>({
    queryKey: ['customer', id],
    queryFn: () => api.get(`/customers/${id}`).then((r) => r.data.data ?? r.data),
  });

  // Each section waits for its own list. Until it has it, it shows its
  // skeleton — not "No orders yet", which is a claim, and not a balance of 0.
  const { items: orders, capped: ordersCapped, isLoading: ordersLoading } = useAllRecords<SaleOrder>(
    ['sales', id],
    '/sales/orders',
    { customerId: id },
  );
  const { items: payments, capped: paymentsCapped, isLoading: paymentsLoading } = useAllRecords<PaymentRecord>(
    ['payments', id],
    '/payments',
    { customerId: id },
  );
  const { items: plans, isLoading: plansLoading } = useAllRecords(['paymentPlans', id], '/payment-plans', {
    customerId: id,
  });

  const orderList = Array.isArray(orders) ? orders : [];
  const paymentList = Array.isArray(payments) ? payments : [];
  const plan = (Array.isArray(plans) ? plans : []).find((p) => p.status === 'ACTIVE');

  // Confirmed orders only, the rule the dialog applies money by. A draft is
  // not a sale yet — it reserves nothing and counts for nothing (§4).
  const openOrders = useMemo(() => oldestFirst(orderList), [orderList]);
  const owed = openOrders.reduce((s, o) => s + num(o.outstanding), 0);
  const paid = paymentList
    .filter((p) => p.status === 'RECORDED')
    .reduce((s, p) => s + num(p.amount), 0);

  /** What an order still owes: a draft owes nothing (§4) — a dash and why, not a red number. */
  const outstandingOf = (o: SaleOrder) =>
    o.status === 'DRAFT' ? (
      <span className="text-sm text-muted-foreground" data-testid="outstanding">
        — <span className="text-xs">({ts('notConfirmed')})</span>
      </span>
    ) : (
      <span
        data-testid="outstanding"
        className={`text-sm font-medium ${num(o.outstanding) > 0 ? 'text-destructive' : 'text-success'}`}
      >
        <Money value={num(o.outstanding)} currency={o.currency} />
      </span>
    );
  /** Money from a payment not yet applied to any order — a credit. */
  const unappliedOf = (p: PaymentRecord) =>
    num(p.amount) - (p.allocations ?? []).reduce((s, a) => s + num(a.amount), 0);

  // Order #, date, status, total, outstanding — the amounts end-aligned
  // together (re-audit N8), through the one table (components/ui/data-table).
  const orderColumns: Column<SaleOrder>[] = [
    {
      key: 'orderNo', header: ts('orderNo'), width: '9rem', skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (o) => <bdi dir="ltr" className="font-mono text-xs text-muted-foreground">{o.orderNo}</bdi>,
    },
    {
      key: 'date', header: ts('date'), width: '8rem', kind: 'value', className: 'text-xs text-muted-foreground',
      cell: (o) => formatDate(o.orderedAt ?? o.createdAt),
    },
    { key: 'status', header: tc('status'), width: 'auto', kind: 'label', cell: (o) => codeLabel('orderStatus', o.status) },
    {
      // Room for "sold at -123,456.00 EGP" under the value now (§4, 2026-10-22).
      key: 'total', header: ts('total'), width: '10.5rem', kind: 'value', align: 'end',
      cell: (o) => <OrderTotal total={o.total} valueNow={o.valueNowEgp} currency={o.currency} />,
    },
    { key: 'outstanding', header: ts('outstanding'), width: '9.5rem', kind: 'value', align: 'end', cell: outstandingOf },
  ];
  // Date, method, status, amount, unapplied — status before the amount, so
  // the two money columns sit together (re-audit N8).
  const paymentColumns: Column<PaymentRecord>[] = [
    {
      key: 'receivedOn', header: tp('receivedOn'), width: '8rem', kind: 'value', className: 'text-xs text-muted-foreground',
      cell: (p) => formatDate(p.receivedOn),
    },
    { key: 'method', header: tp('method'), width: 'auto', kind: 'label', cell: (p) => codeLabel('paymentMethod', p.method) },
    {
      key: 'status', header: tp('status'), width: '8rem', kind: 'label', className: 'text-xs text-muted-foreground',
      cell: (p) => codeLabel('paymentStatus', p.status),
    },
    {
      key: 'amount', header: tp('amount'), width: '9.5rem', kind: 'value', align: 'end', className: 'font-medium',
      cell: (p) => <Money value={num(p.amount)} currency={p.currency} />,
    },
    {
      key: 'unapplied', header: t('unappliedColumn'), width: '9rem', kind: 'value', align: 'end', className: 'text-xs text-muted-foreground',
      cell: (p) => (unappliedOf(p) > 0 ? <Money value={unappliedOf(p)} currency={p.currency} /> : '—'),
    },
  ];

  if (!isLoading && !customer) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white">
        <EmptyState
          title={t('notFoundTitle')}
          description={t('notFoundHint')}
          action={{ label: t('backToCustomers'), href: '/customers' }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* On paper only the statement is printed (its own heading says whose);
          the rest of the page is for the screen. */}
      <div className="print:hidden">
        <BackLink onClick={() => router.push(`/${locale}/customers`)} />
      </div>

      {(isLoading || ordersLoading || paymentsLoading || plansLoading) && <LoadingStatus />}

      {isLoading ? (
        <CustomerHeaderSkeleton />
      ) : (
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{customer.displayName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {codeLabel('customerType', customer.type)}
            {/* A phone number is a left-to-right run: un-isolated, the "+"
                of "+20…" jumps to the far end on an Arabic page. */}
            {customer.phone && (
              <>
                {' · '}
                <LatinText dir="ltr">{customer.phone}</LatinText>
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowPay(true)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 sm:min-h-0"
          >
            <Wallet className="h-4 w-4" /> {tp('create')}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/${locale}/sales?new=1&customer=${id}`)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:min-h-0"
          >
            <Plus className="h-4 w-4" /> {ts('create')}
          </button>
        </div>
      </div>
      )}

      {plan?.isOverdue && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 print:hidden">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm text-red-800">
            {tk('overdue')} — <Money value={num(plan.overdueEgp)} className="font-semibold" />
          </p>
        </div>
      )}

      {/* The balance and the order count come from the orders, the paid
          figure from the payments: a tile waits for the list it adds up. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 print:hidden">
        {ordersLoading ? (
          <TileSkeleton label={t('balance')} />
        ) : (
          <Tile testId="customer-balance" label={t('balance')} value={<Money value={owed} />} tone={owed > 0 ? 'red' : 'green'} />
        )}
        {paymentsLoading ? <TileSkeleton label={tp('title')} /> : <Tile label={tp('title')} value={<Money value={paid} />} />}
        {ordersLoading ? <TileSkeleton label={ts('title')} /> : <Tile label={ts('title')} value={String(orderList.length)} />}
      </div>

      <Card title={ts('title')} icon={<ShoppingCart className="h-4 w-4 text-gray-400" />}>
        <ListCapNotice capped={ordersCapped} count={orderList.length} />
        {!ordersLoading && orderList.length === 0 ? (
          <EmptyState
            title={t('noOrders')}
            description={t('noOrdersHint')}
            action={{ label: ts('create'), onClick: () => router.push(`/${locale}/sales?new=1&customer=${id}`) }}
          />
        ) : (
          <>
            {/* Desktop: the shared table. Phone: a card per order — order and
                status, then date and total, then what is owed (owner
                2026-10-17: five values in a two-column grid left one alone). */}
            <DataTable
              className="hidden md:block"
              frame="none"
              density="compact"
              isLoading={ordersLoading}
              skeletonRows={SECTION_SKELETON_ROWS}
              columns={orderColumns}
              rows={orderList}
              rowKey={(o) => o.id}
              rowProps={() => ({ 'data-testid': 'customer-order-row' })}
            />
            <ul className="space-y-2 md:hidden" aria-busy={ordersLoading}>
              {ordersLoading
                ? repeat(SECTION_SKELETON_ROWS, (i) => <PhoneCardSkeleton key={i} />)
                : orderList.map((o) => (
                    <PhoneCard
                      key={o.id}
                      testId="customer-order-card"
                      topStart={<bdi dir="ltr" className="font-mono text-xs text-muted-foreground">{o.orderNo}</bdi>}
                      topEnd={<span className="text-sm text-foreground">{codeLabel('orderStatus', o.status)}</span>}
                      midStart={<span className="text-xs text-muted-foreground">{formatDate(o.orderedAt ?? o.createdAt)}</span>}
                      midEnd={<span className="text-sm font-medium text-foreground"><OrderTotal total={o.total} valueNow={o.valueNowEgp} currency={o.currency} /></span>}
                      bottomLabel={ts('outstanding')}
                      bottom={outstandingOf(o)}
                    />
                  ))}
            </ul>
          </>
        )}
      </Card>

      <Card title={tp('title')} icon={<Wallet className="h-4 w-4 text-gray-400" />}>
        <ListCapNotice capped={paymentsCapped} count={paymentList.length} />
        {!paymentsLoading && paymentList.length === 0 ? (
          <EmptyState
            title={t('noPayments')}
            description={t('noPaymentsHint')}
            action={{ label: tp('create'), onClick: () => setShowPay(true) }}
          />
        ) : (
          <>
            <DataTable
              className="hidden md:block"
              frame="none"
              density="compact"
              isLoading={paymentsLoading}
              skeletonRows={SECTION_SKELETON_ROWS}
              columns={paymentColumns}
              rows={paymentList}
              rowKey={(p) => p.id}
              rowProps={() => ({ 'data-testid': 'customer-payment-row' })}
            />
            <ul className="space-y-2 md:hidden" aria-busy={paymentsLoading}>
              {paymentsLoading
                ? repeat(SECTION_SKELETON_ROWS, (i) => <PhoneCardSkeleton key={i} />)
                : paymentList.map((p) => {
                    const credit = unappliedOf(p);
                    return (
                      <PhoneCard
                        key={p.id}
                        testId="customer-payment-card"
                        topStart={<span className="text-sm text-foreground">{codeLabel('paymentMethod', p.method)}</span>}
                        topEnd={<span className="text-sm font-medium text-foreground"><Money value={num(p.amount)} currency={p.currency} /></span>}
                        midStart={<span className="text-xs text-muted-foreground">{formatDate(p.receivedOn)}</span>}
                        midEnd={<span className="text-xs text-muted-foreground">{codeLabel('paymentStatus', p.status)}</span>}
                        bottomLabel={credit > 0 ? t('unappliedColumn') : undefined}
                        bottom={credit > 0 ? <Money value={credit} currency={p.currency} /> : undefined}
                      />
                    );
                  })}
            </ul>
          </>
        )}
      </Card>

      {/* This shop's contracts, each opening its own (owner, 2026-10-17). The
          same list as Payments' Contracts tab, narrowed to the shop. */}
      <Card title={tk('title')} icon={<FileSignature className="h-4 w-4 text-gray-400" />} testId="customer-contracts">
        <ContractsList customerId={id} />
      </Card>

      {/* Fetches its own figures, so it starts alongside the customer rather
          than after it, and shows its own skeleton meanwhile. */}
      <CustomerStatement customerId={id} customerName={customer?.displayName ?? ''} />

      {customer && (
        <RecordPaymentDialog
          open={showPay}
          onClose={() => setShowPay(false)}
          customer={{ id, displayName: customer.displayName, currency: customer.currency }}
        />
      )}
    </div>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────
// Each traces the real piece beside it: the heading block and its two
// buttons, a tile, a phone card. Change one, change the other.

/** The name, the type · phone line, and the two actions (44px on a phone). */
function CustomerHeaderSkeleton() {
  return (
    <SkeletonGroup className="flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div>
        <SkeletonText size="2xl" className="w-56" />
        <SkeletonText className="w-40" lineClassName="mt-1" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-36 rounded-lg sm:h-9" />
        <Skeleton className="h-11 w-32 rounded-lg sm:h-9" />
      </div>
    </SkeletonGroup>
  );
}

/** A tile whose label is known and whose figure is not yet. */
function TileSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <SkeletonGroup>
        <SkeletonText size="xl" className="w-28" lineClassName="mt-1" />
      </SkeletonGroup>
    </div>
  );
}

/** Rows a section shows while its list loads. */
const SECTION_SKELETON_ROWS = 3;

function Tile({ label, value, tone, testId }: { label: string; value: React.ReactNode; tone?: 'red' | 'green'; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-green-600' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  );
}

function Card({ title, icon, children, testId }: { title: string; icon: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-gray-200 bg-white p-5 print:hidden">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">{icon}{title}</h2>
      {children}
    </div>
  );
}

/**
 * One order or payment on a phone: two pairs, each start and end of its line,
 * then an optional labelled amount under a hairline. A five-column row folded
 * into a two-column grid left the fifth value alone in the middle.
 */
function PhoneCard({
  testId,
  topStart,
  topEnd,
  midStart,
  midEnd,
  bottomLabel,
  bottom,
}: {
  testId: string;
  topStart: React.ReactNode;
  topEnd: React.ReactNode;
  midStart: React.ReactNode;
  midEnd: React.ReactNode;
  bottomLabel?: string;
  bottom?: React.ReactNode;
}) {
  return (
    <li data-testid={testId} className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">{topStart}</span>
        <span className="shrink-0">{topEnd}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="min-w-0">{midStart}</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">{midEnd}</span>
      </div>
      {bottomLabel && (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">{bottomLabel}</span>
          <span className="whitespace-nowrap tabular-nums">{bottom}</span>
        </div>
      )}
    </li>
  );
}

/** The card above while its list loads. */
function PhoneCardSkeleton() {
  return (
    <li data-testid="skeleton-row" className="rounded-lg border border-border p-3">
      <SkeletonGroup>
        {/* Each row of the real card is a line of the page's base text (its outer
            spans set no size), so 24px, not the 20px of text-sm: three rows of
            text-sm came out 12px short of the card that replaced them. */}
        <div className="flex justify-between"><SkeletonText size="base" className="w-28" /><SkeletonText size="base" className="w-16" /></div>
        <div className="mt-1 flex justify-between"><SkeletonText size="base" className="w-20" /><SkeletonText size="base" className="w-24" /></div>
        <div className="mt-2 flex justify-between border-t border-border pt-2"><SkeletonText size="base" className="w-16" /><SkeletonText size="base" className="w-24" /></div>
      </SkeletonGroup>
    </li>
  );
}
