'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { businessToday } from '@/lib/dates';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { FieldLabel, FormActions } from '@/components/ui/fields';
import { FieldWithQuickCreate } from '@/components/ui/quick-create';
import { ValidatedForm } from '@/components/ui/validated-form';
import { LenderLink } from '@/components/ui/entity-link';
import { useAllRecords } from '@/lib/list-all';
import { useCurrencyRates } from '@/lib/currency-rates';
import { selectOnFocus } from '@/lib/select-on-focus';
import { useRefreshLenderData, type FinancingView } from './lender-dialogs';

/**
 * "Paid by a friend" (BUSINESS_LOGIC §18) — on a purchase order and on the
 * cycle page. Who paid how much of which order and what is still owed, and,
 * for a partner, the form that records it: the lender picker carries the `+`
 * that opens the Lenders tab's own form (§13).
 *
 * One component for both places, so the two never word or check it
 * differently. The server refuses too much, a closed cycle and a friend twice;
 * this only says what it was told.
 */
export function PaidByFriend({
  cycleId,
  purchaseOrder,
  orders,
  closed,
}: {
  /** The cycle page: every order of the cycle, with an order picker. */
  cycleId?: string;
  /** The purchase-order dialog: this one order. */
  purchaseOrder?: FinanceableOrder;
  /** The cycle's orders, for the picker on the cycle page. */
  orders?: FinanceableOrder[];
  /** A cycle being settled, settled or cancelled takes no new payment. */
  closed?: boolean;
}) {
  const t = useTranslations('lenders');
  const mayAdd = useCan('lender.finance');
  const [adding, setAdding] = useState(false);

  const key = cycleId ? ['financing', 'cycle', cycleId] : ['financing', 'order', purchaseOrder?.id];
  const { data } = useQuery<{ financings: FinancingView[] } & Partial<CycleRoom>>({
    queryKey: key,
    queryFn: () =>
      api
        .get(cycleId ? `/cycles/${cycleId}/financing` : `/purchases/${purchaseOrder!.id}/financings`)
        .then((r) => r.data.data ?? r.data),
    enabled: Boolean(cycleId || purchaseOrder?.id),
  });
  const financings = data?.financings ?? [];
  const pickable = orders ?? (purchaseOrder ? [purchaseOrder] : []);

  return (
    <section data-testid="paid-by-friend" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <HandCoins className="h-4 w-4 text-muted-foreground" /> {t('paidByFriend')}
        </h3>
        {mayAdd && !closed && !adding && pickable.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            data-testid="add-financing"
            className="inline-flex items-center gap-1 rounded-lg bg-accent-50 px-3 py-1.5 text-xs font-medium text-accent-700 hover:bg-accent-100"
          >
            <Plus className="h-3.5 w-3.5" /> {t('addFinancing')}
          </button>
        )}
      </div>

      {financings.length === 0 ? (
        <p className="text-sm text-muted-foreground">{cycleId ? t('noneYetCycle') : t('noneYet')}</p>
      ) : (
        <ul className="space-y-2">
          {financings.map((f) => (
            <li
              key={f.id}
              data-testid="financing-line"
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-accent-50/60 px-3 py-2 text-sm"
            >
              <span className="min-w-0 text-foreground">
                {t.rich(Number(f.owed) > 0 ? 'paidByLine' : 'paidByLineRepaid', {
                  lender: () => <LenderLink id={f.lender.id} name={f.lender.name} className="font-medium" />,
                  amount: () => <Money value={f.amount} currency={f.currency} className="font-medium" />,
                  owed: () => <Money value={f.owed} currency={f.currency} className="font-semibold text-accent-800" />,
                })}
              </span>
              {cycleId && (
                <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                  {f.purchaseOrder.reference}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddFinancingForm
          orders={pickable}
          room={data?.availableEgp !== undefined ? (data as CycleRoom) : undefined}
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/**
 * What is left of the cycle's cost for friends to pay, in pounds, as the API
 * reports it on both the order's and the cycle's financing (§18,
 * 2026-10-16): goods, legs and the expenses charged to the cycle, less what
 * friends paid. The same for every order of the cycle.
 */
interface CycleRoom {
  cycleCostEgp: string;
  cycleFinancedEgp: string;
  availableEgp: string;
}

/** An order a friend can pay: its currency and its own rate to pounds. */
export interface FinanceableOrder {
  id: string;
  reference: string;
  currency: string;
  /** The order's rate, which prefills the rate when he paid in its currency. */
  fxRateToEgp?: number | string;
}

/** amount × rate to the piastre, half up — the figure the server stores. */
function poundsOf(amount: string, rate: string): number | null {
  const a = Number(amount);
  const r = Number(rate);
  if (!(a > 0) || !(r > 0)) return null;
  return Math.round(a * r * 100 + 1e-7) / 100;
}

/**
 * Record what a friend paid (§18). He may pay in his own currency — an order
 * priced in CNY paid in AED — at the rate on the day he paid (2026-10-16).
 *
 * Currency starts as the order's; the rate starts as the order's own rate for
 * the order's currency, today's from the exchange-rate page for any other, and
 * 1 for pounds. Once he types a rate it is his: only choosing another currency
 * or order starts it again. The pounds it is worth are shown as he types —
 * the server stores the same amount × rate, half up.
 */
function AddFinancingForm({
  orders,
  room,
  onDone,
}: {
  orders: FinanceableOrder[];
  /** What is left of the cycle's cost; the server refuses more. */
  room?: CycleRoom;
  onDone: () => void;
}) {
  const t = useTranslations('lenders');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshLenderData();
  const rates = useCurrencyRates();
  // Its own key under ['lenders']: the Lenders page caches the bare list there,
  // and the `+` invalidates the prefix, so both refresh after a quick-create.
  const { items: lenders } = useAllRecords(['lenders', 'picker'], '/lenders');
  const [orderId, setOrderId] = useState(orders.length === 1 ? orders[0].id : '');
  const [lenderId, setLenderId] = useState('');
  const [amount, setAmount] = useState('');
  /** '' follows the order's currency. */
  const [chosenCurrency, setChosenCurrency] = useState('');
  /** null until he types one. */
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const order = orders.find((o) => o.id === orderId);

  const currency = chosenCurrency || order?.currency || '';
  const isEgp = currency === 'EGP';
  const prefilledRate = isEgp
    ? '1'
    : currency && currency === order?.currency && Number(order?.fxRateToEgp) > 0
      ? String(Number(order!.fxRateToEgp))
      : rates[currency]
        ? String(rates[currency])
        : '';
  const rate = isEgp ? '1' : (typedRate ?? prefilledRate);
  const pounds = poundsOf(amount, rate);

  // EGP, the order's currency, and every currency with a rate on file.
  const currencies = [...new Set(['EGP', ...(order ? [order.currency] : []), ...Object.keys(rates)])].sort(
    (a, b) => (a === order?.currency ? -1 : b === order?.currency ? 1 : a.localeCompare(b)),
  );

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/purchases/${orderId}/financings`, body),
    onSuccess: () => {
      refresh();
      addToast(t('financingSaved'), 'success');
      onDone();
    },
    onError: (e) => addToast(apiError(e, t('financingFailed')), 'error'),
  });

  return (
    <ValidatedForm
      data-testid="financing-form"
      className="space-y-3 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        save.mutate({
          lenderId,
          amount: Number(amount),
          currency,
          ...(isEgp ? {} : { fxRateToEgp: Number(rate) }),
          paidOn: (fd.get('paidOn') as string) || undefined,
        });
      }}
    >
      {orders.length > 1 && (
        <FieldLabel label={t('purchaseOrder')} required>
          <Select
            name="purchaseOrderId"
            required
            value={orderId}
            onChange={(id) => {
              setOrderId(id);
              // Another order, another currency and rate to start from.
              setTypedRate(null);
            }}
            placeholder={t('pickOrder')}
            searchPlaceholder={tph('searchOrders')}
            options={orders.map((o) => ({ value: o.id, label: o.reference, hint: o.currency }))}
          />
        </FieldLabel>
      )}
      <FieldLabel label={t('lender')} required>
        <FieldWithQuickCreate entity="lender" onCreated={(l) => setLenderId(l.id)}>
          <Select
            name="lenderId"
            required
            value={lenderId}
            onChange={setLenderId}
            placeholder={t('pickLender')}
            searchPlaceholder={tph('searchLenders')}
            options={(lenders as { id: string; name: string }[]).map((l) => ({ value: l.id, label: l.name }))}
          />
        </FieldWithQuickCreate>
      </FieldLabel>
      <div className="field-row grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FieldLabel label={t('paidInCurrency')} required>
          <Select
            name="currency"
            required
            value={currency}
            onChange={(code) => {
              setChosenCurrency(code);
              setTypedRate(null);
            }}
            placeholder={tph('chooseCurrency')}
            options={currencies.map((code) => ({
              value: code,
              label: code,
              ...(code === order?.currency ? { hint: t('ordersCurrency') } : {}),
            }))}
          />
        </FieldLabel>
        <div>
          <label htmlFor="financing-rate" className="mb-1 block text-sm font-medium text-foreground">
            {t('rateOnThatDay', { currency: currency || '—' })}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <input
            id="financing-rate"
            name="fxRateToEgp"
            data-testid="financing-rate"
            inputMode="decimal"
            autoComplete="off"
            required
            disabled={isEgp}
            placeholder={tph('fxRate')}
            value={rate}
            onChange={(e) => setTypedRate(e.target.value.replace(/[^\d.]/g, ''))}
            {...selectOnFocus}
            dir="ltr"
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-muted disabled:text-muted-foreground"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('financingRateHint')}</p>
        </div>
      </div>
      <div className="field-row grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="financing-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amountIn', { currency: currency || '—' })}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput
            id="financing-amount"
            name="amount"
            required
            value={amount}
            onChange={setAmount}
            placeholder={tph('money')}
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {pounds !== null && !isEgp && (
            <p data-testid="financing-egp" className="mt-1 text-xs text-muted-foreground">
              {t.rich('worthInPounds', {
                egp: () => <Money value={pounds} currency="EGP" className="font-medium text-foreground" />,
              })}
            </p>
          )}
          {room && pounds !== null && pounds > Number(room.availableEgp) && (
            <p data-testid="financing-over" className="mt-1 text-xs text-destructive">
              {t('financingOverAvailable')}
            </p>
          )}
        </div>
        <FieldLabel label={t('paidOn')} required>
          <DatePicker name="paidOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
      </div>
      {/* The cap is the cycle's cost, not the order's (§18, 2026-10-16): a
          friend paying by card paid the shipping and the fee in one sum. */}
      <div className="space-y-1 text-xs text-muted-foreground">
        {room && (
          <p data-testid="financing-available">
            {t.rich('availableToFinance', {
              available: () => <Money value={room.availableEgp} currency="EGP" className="font-medium text-foreground" />,
              cost: () => <Money value={room.cycleCostEgp} currency="EGP" className="font-medium text-foreground" />,
              financed: () => <Money value={room.cycleFinancedEgp} currency="EGP" className="font-medium text-foreground" />,
            })}
          </p>
        )}
        <p>{t('financingCoversHint')}</p>
      </div>
      <FormActions onCancel={onDone} cancelLabel={tc('cancel')} submitLabel={t('save')} busy={save.isPending} />
    </ValidatedForm>
  );
}
