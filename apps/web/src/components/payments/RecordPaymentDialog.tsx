'use client';
import { useAllRecords } from '@/lib/list-all';

import { useMemo, useRef, useState } from 'react';
import { useEscapeToClose } from '@/lib/use-escape-to-close';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { businessToday } from '@/lib/dates';
import { formatAmount } from '@/lib/numbers';
import { Select } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { useToast } from '@/components/ui/toast';

/** The order a payment is recorded from, as the sales list and detail carry it. */
export interface PaymentOrder {
  id: string;
  orderNo: string;
  customerId: string;
  customer?: { displayName: string } | null;
  status: string;
  outstanding: number | string;
  currency: string;
}

export interface PaymentCustomer {
  id: string;
  displayName: string;
  currency?: string | null;
}

interface OrderRow {
  id: string;
  status: string;
  outstanding: number | string;
  createdAt: string;
}

/**
 * The methods offered, as the API stores them. Labels come from
 * `codes.paymentMethod`, the one translation every screen reads, so a payment
 * reads "Cash" on the list, the customer page and the order alike.
 */
export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_WALLET'] as const;

/** Only a confirmed order owes anything (BUSINESS_LOGIC §4, §7a). */
const OWING = ['CONFIRMED', 'PARTIALLY_PAID'];

const num = (v: unknown) => Number(v ?? 0);

/** Whether an order can be paid on: confirmed and still owing. */
export function canTakePayment(order: { status: string; outstanding: number | string }) {
  return OWING.includes(order.status) && num(order.outstanding) > 0;
}

/**
 * Oldest unpaid orders first — what a shop paying down its balance expects,
 * and the rule the instalment logic already follows (§7).
 */
export function oldestFirst(orders: OrderRow[]): OrderRow[] {
  return orders
    .filter(canTakePayment)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Record a payment — the one form for it (UX #3, rule 11).
 *
 * Three places open it: the customer page, the Payments page, and a confirmed
 * order with something owed.
 *
 * - **From an order** (`order`): shows what that order owes, defaults the
 *   amount to it, and posts with `orderId`, so the server records and applies
 *   it to that order in one transaction (§7, 2026-10-10).
 * - **From a customer** (`customer`), or **with neither** (a customer picker):
 *   shows what the customer owes in all and applies the money to the oldest
 *   unpaid orders first, as the customer page always did.
 *
 * The date defaults to today in Cairo and refuses later days, as the server
 * does. A refusal is shown translated inside the dialog, which stays open
 * with everything as typed.
 */
export function RecordPaymentDialog({
  open,
  onClose,
  customer,
  order,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  customer?: PaymentCustomer | null;
  order?: PaymentOrder | null;
  onRecorded?: () => void;
}) {
  if (!open || typeof document === 'undefined') return null;
  // Mounted fresh on every open, so nothing typed last time survives a close.
  return createPortal(
    <RecordPaymentForm customer={customer} order={order} onClose={onClose} onRecorded={onRecorded} />,
    document.body,
  );
}

function RecordPaymentForm({
  customer,
  order,
  onClose,
  onRecorded,
}: {
  customer?: PaymentCustomer | null;
  order?: PaymentOrder | null;
  onClose: () => void;
  onRecorded?: () => void;
}) {
  const t = useTranslations('payments');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const apiError = useApiError();
  const codeLabel = useCodeLabel();
  const queryClient = useQueryClient();
  const toast = useToast();

  const fixedCustomerId = order?.customerId ?? customer?.id ?? '';
  const [customerId, setCustomerId] = useState(fixedCustomerId);
  const [amount, setAmount] = useState(() =>
    order && canTakePayment(order) ? num(order.outstanding).toFixed(2) : '',
  );
  const [receivedOn, setReceivedOn] = useState(() => businessToday());
  const [method, setMethod] = useState<string>('CASH');
  const [reference, setReference] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Set synchronously on submit: `pending` only disables the button after a
  // re-render, and two clicks inside one frame both get through that.
  const submitting = useRef(false);

  // Escape closes the form — not while the method or date picker is open
  // (that Escape is the picker's; it used to close the whole form and lose it),
  // and not mid-save. The shared definition (lib/use-escape-to-close).
  useEscapeToClose(onClose, () => submitting.current);

  // A picker only when nobody said whose payment this is.
  const { items: customers } = useAllRecords<PaymentCustomer>(['customers'], '/customers', undefined, {
    enabled: !fixedCustomerId,
  });

  // The customer's orders, for what they owe and where the money goes. The same
  // key the customer page reads, so both share one cache entry.
  const { items: orders, isFetching: ordersLoading } = useAllRecords<OrderRow>(
    ['sales', customerId],
    '/sales/orders',
    { customerId },
    { enabled: !order && !!customerId },
  );

  const openOrders = useMemo(() => oldestFirst(Array.isArray(orders) ? orders : []), [orders]);
  const owed = order ? num(order.outstanding) : openOrders.reduce((s, o) => s + num(o.outstanding), 0);
  const currency = order?.currency ?? customer?.currency ?? 'EGP';
  const customerName =
    order?.customer?.displayName ??
    customer?.displayName ??
    (Array.isArray(customers) ? customers : []).find((c) => c.id === customerId)?.displayName ??
    '';

  /** The form's own check, in the server's words (rule 3). */
  const problem = (): string | null => {
    const value = Number(amount);
    if (!(value > 0)) return te('AMOUNT_NOT_POSITIVE');
    if (order && value > owed) {
      return te('PAYMENT_EXCEEDS_ORDER', {
        order: order.orderNo,
        owed: owed.toFixed(2),
        asked: value.toFixed(2),
      });
    }
    return null;
  };

  const finish = async (message: string, tone: 'success') => {
    for (const key of ['payments', 'payment', 'sales', 'sale', 'customer', 'customers', 'paymentPlans', 'analytics']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    toast[tone](message);
    onRecorded?.();
    onClose();
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    const invalid = problem();
    if (invalid) {
      setRefusal(invalid);
      return;
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);

    const value = Number(amount);
    try {
      // On a chosen order, or — from a shop or the Payments page — on the
      // oldest unpaid orders first. Either way the server records and applies
      // the money in one transaction (§7): the same `applyOldestFirst` the
      // assistant's record_payment asks for, so "oldest first" is defined once
      // and a payment can never be left recorded but applied to nothing.
      await api.post('/payments', {
        customerId,
        amount: value,
        currency,
        method,
        receivedOn,
        reference: reference.trim() || undefined,
        ...(order ? { orderId: order.id } : { applyOldestFirst: true }),
      });
    } catch (err) {
      setRefusal(apiError(err, t('recordFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    submitting.current = false;
    await finish(t('recordedToast'), 'success');
  };

  const customerOptions = (Array.isArray(customers) ? customers : []).map((c) => ({
    value: c.id,
    label: c.displayName,
  }));

  return (
    <div data-record-payment-dialog className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* A scrim is black in either theme; a token would invert it in dark mode. */}
      <div
        className="fixed inset-0"
        style={{ backgroundColor: 'rgb(0 0 0 / 0.5)' }}
        onClick={() => !submitting.current && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-payment-title"
        className="relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <h2 id="record-payment-title" className="text-lg font-semibold text-foreground">
            {order ? t('recordFor', { order: order.orderNo }) : t('create')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label={tc('close')}
            className="flex size-11 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground disabled:cursor-not-allowed sm:size-8"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form noValidate onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
            {fixedCustomerId ? (
              customerName && (
                <p className="text-sm text-muted-foreground">
                  {t('customer')}: <span className="font-medium text-foreground">{customerName}</span>
                </p>
              )
            ) : (
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  {t('customer')}
                  <span aria-hidden="true" className="ms-1 text-destructive">*</span>
                </label>
                <Select
                  name="customerId"
                  required
                  value={customerId}
                  onChange={(id) => {
                    setCustomerId(id);
                    setRefusal(null);
                  }}
                  placeholder={t('selectCustomer')}
                  searchPlaceholder={tph('searchCustomers')}
                  options={customerOptions}
                />
              </div>
            )}

            {customerId && (
              <div
                data-testid="payment-owed"
                className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
              >
                {order ? t('orderOwes', { order: order.orderNo }) : t('owedNow')}{' '}
                {ordersLoading && !order ? (
                  <Loader2 className="inline h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Money value={owed} currency={currency} className="font-semibold text-foreground" />
                )}
                <p className="mt-0.5 text-xs">{order ? t('appliedToOrder') : t('appliedOldestFirst')}</p>
              </div>
            )}

            <div>
              <label htmlFor="payment-amount" className="mb-1 block text-sm font-medium text-foreground">
                {t('amount')}
                <span aria-hidden="true" className="ms-1 text-destructive">*</span>
              </label>
              <MoneyInput
                id="payment-amount"
                name="amount"
                required
                value={amount}
                onChange={(raw) => {
                  setAmount(raw);
                  setRefusal(null);
                }}
                placeholder={owed > 0 ? formatAmount(owed) : tph('money')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
              />
            </div>

            <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">{t('method')}</label>
                <Select
                  name="method"
                  value={method}
                  placeholder={tph('choosePaymentMethod')}
                  onChange={setMethod}
                  options={PAYMENT_METHODS.map((m) => ({ value: m, label: codeLabel('paymentMethod', m) }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-foreground">
                  {t('receivedOn')}
                  <span aria-hidden="true" className="ms-1 text-destructive">*</span>
                </label>
                <DatePicker
                  name="receivedOn"
                  required
                  disableFuture
                  value={receivedOn}
                  onChange={(v) => setReceivedOn(v || businessToday())}
                />
              </div>
            </div>

            <div>
              <label htmlFor="payment-reference" className="mb-1 block text-sm font-medium text-foreground">
                {t('reference')}
              </label>
              <input
                id="payment-reference"
                name="reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={t('referencePlaceholder')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
              />
            </div>

            {refusal && (
              <p role="alert" data-testid="payment-refusal" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {refusal}
              </p>
            )}
          </div>

          <div className="flex shrink-0 justify-end gap-3 border-t border-border px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="min-h-11 cursor-pointer rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted disabled:cursor-not-allowed sm:min-h-0"
            >
              {tc('cancel')}
            </button>
            <button
              type="submit"
              disabled={pending || !customerId}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
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
