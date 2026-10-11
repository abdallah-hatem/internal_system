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
  purchaseOrder?: { id: string; reference: string; currency: string };
  /** The cycle's orders, for the picker on the cycle page. */
  orders?: { id: string; reference: string; currency: string }[];
  /** A cycle being settled, settled or cancelled takes no new payment. */
  closed?: boolean;
}) {
  const t = useTranslations('lenders');
  const mayAdd = useCan('lender.finance');
  const [adding, setAdding] = useState(false);

  const key = cycleId ? ['financing', 'cycle', cycleId] : ['financing', 'order', purchaseOrder?.id];
  const { data } = useQuery<{ financings: FinancingView[] }>({
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
        <AddFinancingForm orders={pickable} onDone={() => setAdding(false)} />
      )}
    </section>
  );
}

function AddFinancingForm({
  orders,
  onDone,
}: {
  orders: { id: string; reference: string; currency: string }[];
  onDone: () => void;
}) {
  const t = useTranslations('lenders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshLenderData();
  // Its own key under ['lenders']: the Lenders page caches the bare list there,
  // and the `+` invalidates the prefix, so both refresh after a quick-create.
  const { items: lenders } = useAllRecords(['lenders', 'picker'], '/lenders');
  const [orderId, setOrderId] = useState(orders.length === 1 ? orders[0].id : '');
  const [lenderId, setLenderId] = useState('');
  const [amount, setAmount] = useState('');
  const order = orders.find((o) => o.id === orderId);

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
            onChange={setOrderId}
            placeholder={t('pickOrder')}
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
            searchPlaceholder={tc('search')}
            options={(lenders as { id: string; name: string }[]).map((l) => ({ value: l.id, label: l.name }))}
          />
        </FieldWithQuickCreate>
      </FieldLabel>
      <div className="field-row grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="financing-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amountIn', { currency: order?.currency ?? '—' })}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput
            id="financing-amount"
            name="amount"
            required
            value={amount}
            onChange={setAmount}
            placeholder="0.00"
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <FieldLabel label={t('paidOn')} required>
          <DatePicker name="paidOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
      </div>
      <FormActions onCancel={onDone} cancelLabel={tc('cancel')} submitLabel={t('save')} busy={save.isPending} />
    </ValidatedForm>
  );
}
