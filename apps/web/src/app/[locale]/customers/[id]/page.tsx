'use client';

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
 * Here it is one action — see below.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api } from '../../../../lib/api';
import { formatDate } from '../../../../lib/dates';
import { Money } from '../../../../components/ui/money';
import { Select } from '../../../../components/ui/select';
import { DatePicker } from '../../../../components/ui/date-picker';
import { useToast } from '../../../../components/ui/toast';
import { MoneyInput } from '../../../../components/ui/money-input';
import {
  ArrowLeft, Loader2, Wallet, ShoppingCart, CalendarClock, AlertTriangle, Plus,
} from 'lucide-react';

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
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [showPay, setShowPay] = useState(false);

  const { data: customer, isLoading } = useQuery<any>({
    queryKey: ['customer', id],
    queryFn: () => api.get(`/customers/${id}`).then((r) => r.data.data ?? r.data),
  });

  const { data: orders = [] } = useQuery<SaleOrder[]>({
    queryKey: ['sales', id],
    queryFn: () =>
      api.get(`/sales/orders?customerId=${id}&limit=100`).then((r) => r.data.data ?? r.data),
  });

  const { data: payments = [] } = useQuery<PaymentRecord[]>({
    queryKey: ['payments', id],
    queryFn: () =>
      api.get(`/payments?customerId=${id}&limit=100`).then((r) => r.data.data ?? r.data),
  });

  const { data: plans = [] } = useQuery<any[]>({
    queryKey: ['paymentPlans', id],
    queryFn: () =>
      api.get(`/payment-plans?customerId=${id}&limit=20`).then((r) => r.data.data ?? r.data),
  });

  const orderList = Array.isArray(orders) ? orders : [];
  const paymentList = Array.isArray(payments) ? payments : [];
  const plan = (Array.isArray(plans) ? plans : []).find((p) => p.status === 'ACTIVE');

  // Oldest first: money clears the oldest debt, which is both what shops
  // expect and the rule the instalment logic already follows.
  //
  // Confirmed orders only. A draft is not a sale yet — it reserves nothing and
  // counts for nothing — so paying against one would attach money to something
  // that may never happen. The server counts what is owed the same way, and
  // allocating here to an order it did not count would strand the difference.
  const openOrders = useMemo(
    () =>
      orderList
        .filter(
          (o) => num(o.outstanding) > 0 && ['CONFIRMED', 'PARTIALLY_PAID'].includes(o.status),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    [orderList],
  );

  const owed = openOrders.reduce((s, o) => s + num(o.outstanding), 0);
  const paid = paymentList
    .filter((p) => p.status === 'RECORDED')
    .reduce((s, p) => s + num(p.amount), 0);

  /**
   * Record a payment and put it against the oldest open orders.
   *
   * This was three steps on two screens: create the payment, find it again,
   * then allocate it to an order picked from a list of every order in the
   * system. Nobody takes money from a shop and thinks of it that way — they
   * think "he paid 5,000 off what he owes".
   *
   * More than is owed is refused outright by the server rather than left over
   * as credit. That was my call originally and it was wrong: money attached to
   * no order clears nothing, still reads as collected, and is almost always a
   * typo — which is exactly the moment to catch it.
   */
  const pay = useMutation({
    mutationFn: async (form: { amount: number; method: string; receivedOn: string; reference?: string }) => {
      const created = await api.post('/payments', {
        customerId: id,
        amount: form.amount,
        currency: customer?.currency ?? 'EGP',
        method: form.method,
        receivedOn: form.receivedOn,
        reference: form.reference || undefined,
      });
      const payment = created.data.data ?? created.data;

      let left = form.amount;
      for (const order of openOrders) {
        if (left <= 0) break;
        const take = Math.min(left, num(order.outstanding));
        if (take <= 0) continue;
        await api.post(`/payments/${payment.id}/allocations`, {
          saleOrderId: order.id,
          amount: take,
        });
        left -= take;
      }
      return left;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowPay(false);
      addToast('Payment recorded and applied', 'success');
    },
    onError: (e: any) =>
      addToast(
        e?.response?.data?.error?.message || e?.response?.data?.message || 'Could not record the payment',
        'error',
      ),
  });

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
      <button
        onClick={() => router.push(`/${locale}/customers`)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" /> {tc('back')}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{customer.displayName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {customer.type}
            {customer.phone ? ` · ${customer.phone}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowPay(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
          >
            <Wallet className="h-4 w-4" /> {tp('create')}
          </button>
          <button
            onClick={() => router.push(`/${locale}/sales?customer=${id}`)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
        {orderList.length === 0 ? (
          <Empty>{tc('noData')}</Empty>
        ) : (
          <Rows>
            {orderList.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-gray-500">{o.orderNo}</span>
                <span className="text-xs text-gray-400">{formatDate(o.createdAt)}</span>
                <span className="text-sm">{o.status}</span>
                <span className="text-sm"><Money value={num(o.total)} /></span>
                <span className={`text-sm font-medium ${num(o.outstanding) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  <Money value={num(o.outstanding)} />
                </span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={tp('title')} icon={<Wallet className="h-4 w-4 text-gray-400" />}>
        {paymentList.length === 0 ? (
          <Empty>{tc('noData')}</Empty>
        ) : (
          <Rows>
            {paymentList.map((p) => {
              const allocated = (p.allocations ?? []).reduce((s, a) => s + num(a.amount), 0);
              const credit = num(p.amount) - allocated;
              return (
                <Row key={p.id}>
                  <span className="text-xs text-gray-400">{formatDate(p.receivedOn)}</span>
                  <span className="text-sm">{p.method}</span>
                  <span className="text-sm font-medium"><Money value={num(p.amount)} /></span>
                  <span className="text-xs text-gray-500">{p.status}</span>
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
          <Empty>{tpl('noData')}</Empty>
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

      {showPay && (
        <PaymentModal
          owed={owed}
          onClose={() => setShowPay(false)}
          onSubmit={(v) => pay.mutate(v)}
          pending={pay.isPending}
        />
      )}
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

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-6 text-center text-sm text-gray-400">{children}</p>
);

const Rows = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-gray-100">{children}</div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">{children}</div>
);

function PaymentModal({
  owed,
  onClose,
  onSubmit,
  pending,
}: {
  owed: number;
  onClose: () => void;
  onSubmit: (v: { amount: number; method: string; receivedOn: string; reference?: string }) => void;
  pending: boolean;
}) {
  const tp = useTranslations('payments');
  const tc = useTranslations('common');
  const today = new Date();
  const iso = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">{tp('create')}</h2>
        <p className="mb-4 text-sm text-gray-500">
          Applied to the oldest unpaid orders first. Owed now: <Money value={owed} />
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            onSubmit({
              amount: Number(fd.get('amount')),
              method: String(fd.get('method') || 'CASH'),
              receivedOn: String(fd.get('receivedOn') || iso),
              reference: String(fd.get('reference') || ''),
            });
          }}
          className="space-y-4"
        >
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{tp('amount')}</label>
            <MoneyInput
              name="amount" required autoFocus
              placeholder={owed > 0 ? owed.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '0.00'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{tp('method')}</label>
            <Select
              name="method"
              defaultValue="CASH"
              options={['CASH', 'BANK_TRANSFER', 'CHEQUE'].map((m) => ({ value: m, label: m }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">{tp('receivedOn')}</label>
            <DatePicker name="receivedOn" defaultValue={iso} />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
              {tc('cancel')}
            </button>
            <button
              type="submit" disabled={pending}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {tc('save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
