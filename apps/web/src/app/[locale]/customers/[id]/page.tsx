'use client';
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
  Loader2, Wallet, ShoppingCart, CalendarClock, AlertTriangle, Plus,
} from 'lucide-react';

import { BackLink } from '../../../../components/ui/back-link';
interface SaleOrder {
  id: string;
  orderNo: string;
  status: string;
  total: number | string;
  outstanding: number | string;
  currency: string;
  createdAt: string;
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
  const tpl = useTranslations('paymentPlans');
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

  const { items: orders, capped: ordersCapped } = useAllRecords<SaleOrder>(
    ['sales', id],
    '/sales/orders',
    { customerId: id },
  );
  const { items: payments, capped: paymentsCapped } = useAllRecords<PaymentRecord>(
    ['payments', id],
    '/payments',
    { customerId: id },
  );
  const { items: plans } = useAllRecords(['paymentPlans', id], '/payment-plans', {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
      </div>
    );
  }

  if (!customer) {
    return <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-gray-400">{tc('noData')}</div>;
  }

  return (
    <div className="space-y-6">
      <BackLink onClick={() => router.push(`/${locale}/customers`)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{customer.displayName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {codeLabel('customerType', customer.type)}
            {customer.phone ? ` · ${customer.phone}` : ''}
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
            onClick={() => router.push(`/${locale}/sales?customer=${id}`)}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:min-h-0"
          >
            <Plus className="h-4 w-4" /> {ts('create')}
          </button>
        </div>
      </div>

      {plan?.isOverdue && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm text-red-800">
            {tpl('overdue')} — <Money value={num(plan.overdueEgp)} className="font-semibold" />
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label={t('balance')} value={<Money value={owed} />} tone={owed > 0 ? 'red' : 'green'} />
        <Tile label={tp('title')} value={<Money value={paid} />} />
        <Tile label={ts('title')} value={String(orderList.length)} />
      </div>

      <Card title={ts('title')} icon={<ShoppingCart className="h-4 w-4 text-gray-400" />}>
        <ListCapNotice capped={ordersCapped} count={orderList.length} />
        {orderList.length === 0 ? (
          <EmptyState
            title={t('noOrders')}
            description={t('noOrdersHint')}
            action={{ label: ts('create'), onClick: () => router.push(`/${locale}/sales?customer=${id}`) }}
          />
        ) : (
          <Rows>
            {orderList.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-gray-500">{o.orderNo}</span>
                <span className="text-xs text-gray-400">{formatDate(o.createdAt)}</span>
                <span className="text-sm">{codeLabel('orderStatus', o.status)}</span>
                <span className="text-sm"><Money value={num(o.total)} /></span>
                {/* A draft owes nothing (§4): a dash and why, not a red number. */}
                {o.status === 'DRAFT' ? (
                  <span className="text-sm text-gray-400" data-testid="outstanding">
                    — <span className="text-xs">({ts('notConfirmed')})</span>
                  </span>
                ) : (
                  <span
                    data-testid="outstanding"
                    className={`text-sm font-medium ${num(o.outstanding) > 0 ? 'text-red-600' : 'text-green-600'}`}
                  >
                    <Money value={num(o.outstanding)} />
                  </span>
                )}
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={tp('title')} icon={<Wallet className="h-4 w-4 text-gray-400" />}>
        <ListCapNotice capped={paymentsCapped} count={paymentList.length} />
        {paymentList.length === 0 ? (
          <EmptyState
            title={t('noPayments')}
            description={t('noPaymentsHint')}
            action={{ label: tp('create'), onClick: () => setShowPay(true) }}
          />
        ) : (
          <Rows>
            {paymentList.map((p) => {
              const allocated = (p.allocations ?? []).reduce((s, a) => s + num(a.amount), 0);
              const credit = num(p.amount) - allocated;
              return (
                <Row key={p.id}>
                  <span className="text-xs text-gray-400">{formatDate(p.receivedOn)}</span>
                  <span className="text-sm">{codeLabel('paymentMethod', p.method)}</span>
                  <span className="text-sm font-medium"><Money value={num(p.amount)} /></span>
                  <span className="text-xs text-gray-500">{codeLabel('paymentStatus', p.status)}</span>
                  <span className="text-xs text-gray-400">
                    {credit > 0 ? <>{tc('unapplied')} <Money value={credit} /></> : ''}
                  </span>
                </Row>
              );
            })}
          </Rows>
        )}
      </Card>

      <Card title={tpl('title')} icon={<CalendarClock className="h-4 w-4 text-gray-400" />}>
        {!plan ? (
          <p className="py-6 text-center text-sm text-gray-400">{tpl('noData')}</p>
        ) : (
          <Rows>
            {plan.instalments.map((i: any) => (
              <Row key={i.id}>
                <span className="text-xs text-gray-400">{formatDate(i.dueOn)}</span>
                <span className="text-sm"><Money value={num(i.amount)} /></span>
                <span className="text-xs text-gray-500">{i.state}</span>
                <span className="text-xs text-gray-400">{i.note ?? ''}</span>
                <span />
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <RecordPaymentDialog
        open={showPay}
        onClose={() => setShowPay(false)}
        customer={{ id, displayName: customer.displayName, currency: customer.currency }}
      />
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'red' | 'green' }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-green-600' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">{icon}{title}</h2>
      {children}
    </div>
  );
}

const Rows = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-gray-100">{children}</div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">{children}</div>
);
