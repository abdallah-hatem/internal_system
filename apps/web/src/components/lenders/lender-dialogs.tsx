'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCurrencyRates } from '@/lib/currency-rates';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { DatePicker } from '@/components/ui/date-picker';
import { FieldLabel, FormActions } from '@/components/ui/fields';
import { ValidatedForm } from '@/components/ui/validated-form';
import { Dialog } from '@/components/ui/dialog';
import { selectOnFocus } from '@/lib/select-on-focus';
import { businessToday } from '@/lib/dates';

/**
 * The dialogs a friend's loan needs (BUSINESS_LOGIC §18): record a repayment,
 * reverse one, remove his payment, agree or cancel a plan. Defined once and
 * opened from the lender's page; every one saves through the API, which owns
 * the arithmetic — the screen only shows what it was told.
 */

export interface FinancingView {
  id: string;
  lender: { id: string; name: string };
  purchaseOrder: { id: string; reference: string };
  cycle: { id: string; code: string; status: string };
  currency: string;
  amount: string;
  fxRateToEgp: string;
  amountEgp: string;
  paidOn: string;
  removedAt: string | null;
  repaid: string;
  owed: string;
  paidEgp: string;
  exchangeDiffEgp: string;
  repayments: {
    id: string;
    paidOn: string;
    amountEgp: string;
    rateToEgp: string;
    cleared: string;
    exchangeDiffEgp: string;
    reversedAt: string | null;
    reversalReason: string | null;
  }[];
  plan: null | {
    id: string;
    agreedOn: string;
    total: string;
    paid: string;
    remaining: string;
    overdue: string;
    isOverdue: boolean;
    instalments: {
      id: string;
      sequence: number;
      dueOn: string;
      amount: string;
      paid: string;
      outstanding: string;
      state: 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';
    }[];
  };
}

/** Every list a lender change touches, refreshed together. */
export function useRefreshLenderData() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['lenders'], ['lender'], ['financing'], ['analytics'], ['landedCost'], ['ledger']]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
}

/**
 * Pounds paid to him today at today's rate. The rate starts as the current one
 * from the exchange-rate page and is his to change; once typed, a later rates
 * refresh never overwrites it. What pays it all off at the rate entered comes
 * from the server (`/quote`), the same arithmetic that will judge the save.
 */
export function RecordRepaymentDialog({
  financing,
  onClose,
}: {
  financing: FinancingView;
  onClose: () => void;
}) {
  const t = useTranslations('lenders');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshLenderData();
  const rates = useCurrencyRates();

  // null until he types: until then the field shows the current rate, and
  // once he has typed, a rates refresh never overwrites it.
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const current = rates[financing.currency];
  const rate = typedRate ?? (current ? String(current) : '');
  const [amount, setAmount] = useState('');

  const rateNumber = Number(rate);
  const { data: quote } = useQuery<{ owed: string; settlingEgp: string }>({
    queryKey: ['lender', 'quote', financing.id, rate],
    queryFn: () =>
      api
        .get(`/lender-financings/${financing.id}/quote`, { params: { rateToEgp: rate } })
        .then((r) => r.data.data ?? r.data),
    enabled: Number.isFinite(rateNumber) && rateNumber > 0,
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post(`/lender-financings/${financing.id}/repayments`, body),
    onSuccess: () => {
      refresh();
      addToast(t('repaymentRecorded'), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, t('repaymentFailed')), 'error'),
  });

  return (
    <Dialog
      title={t('recordRepayment')}
      onClose={onClose}
      data-testid="record-repayment-dialog"
      footer={
        <FormActions form="record-repayment-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('recordRepayment')} busy={save.isPending} />
      }
    >
      <ValidatedForm
        id="record-repayment-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          save.mutate({
            amountEgp: Number(amount),
            rateToEgp: Number(rate),
            paidOn: (fd.get('paidOn') as string) || undefined,
          });
        }}
      >
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          <span className="block text-xs text-muted-foreground">
            <bdi>{t('repaymentFor', { lender: financing.lender.name, reference: financing.purchaseOrder.reference })}</bdi>
          </span>
          {t.rich('owedNow', {
            amount: () => <Money value={financing.owed} currency={financing.currency} className="font-semibold" />,
          })}
        </p>

        <FieldLabel label={t('date')} required>
          <DatePicker name="paidOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>

        <div>
          <label htmlFor="repayment-rate" className="mb-1 block text-sm font-medium text-foreground">
            {t('rateFor', { currency: financing.currency })}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <input
            id="repayment-rate"
            name="rateToEgp"
            inputMode="decimal"
            required
            placeholder={tph('fxRate')}
            value={rate}
            onChange={(e) => setTypedRate(e.target.value.replace(/[^\d.]/g, ''))}
            {...selectOnFocus}
            dir="ltr"
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('rateHint')}</p>
        </div>

        <div>
          <label htmlFor="repayment-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('poundsEgp')}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <div className="flex gap-2">
            <MoneyInput
              id="repayment-amount"
              name="amountEgp"
              required
              value={amount}
              onChange={setAmount}
              placeholder={tph('money')}
              className="w-full min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button
              type="button"
              disabled={!quote}
              onClick={() => quote && setAmount(quote.settlingEgp)}
              data-testid="pay-all"
              className="shrink-0 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {t('payAll')}
            </button>
          </div>
          {quote && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="settling-hint">
              {t.rich('settles', { amount: () => <Money value={quote.settlingEgp} currency="EGP" /> })}
            </p>
          )}
        </div>

      </ValidatedForm>
    </Dialog>
  );
}

/** A reason, then one call: reverse a repayment, remove his payment, cancel a plan. */
export function ReasonDialog({
  title,
  hint,
  submitLabel,
  endpoint,
  successMessage,
  onClose,
  testId,
}: {
  title: string;
  hint: string;
  submitLabel: string;
  endpoint: string;
  successMessage: string;
  onClose: () => void;
  testId?: string;
}) {
  const t = useTranslations('lenders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshLenderData();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => api.post(endpoint, { reason: reason.trim() }),
    onSuccess: () => {
      refresh();
      addToast(successMessage, 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, tc('operationFailed')), 'error'),
  });
  return (
    <Dialog
      title={title}
      onClose={onClose}
      data-testid={testId}
      footer={
        <FormActions form="lender-confirm-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={submitLabel} busy={run.isPending} />
      }
    >
      <ValidatedForm
        id="lender-confirm-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground">{hint}</p>
        <div>
          <label htmlFor="lender-reason" className="mb-1 block text-sm font-medium text-foreground">
            {t('reason')}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <textarea
            id="lender-reason"
            name="reason"
            required
            minLength={3}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </ValidatedForm>
    </Dialog>
  );
}

/** Instalments in his currency, the customer-plan habit (§7, §18). */
export function PlanDialog({ financing, onClose }: { financing: FinancingView; onClose: () => void }) {
  const t = useTranslations('lenders');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshLenderData();
  const [rows, setRows] = useState<{ key: number; dueOn: string; amount: string }[]>([
    { key: 1, dueOn: '', amount: '' },
  ]);
  const total = useMemo(() => rows.reduce((s, r) => s + Number(r.amount || 0), 0), [rows]);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/lender-financings/${financing.id}/plan`, {
        instalments: rows.map((r) => ({ dueOn: r.dueOn, amount: Number(r.amount) })),
      }),
    onSuccess: () => {
      refresh();
      addToast(t('planSaved'), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, tc('operationFailed')), 'error'),
  });
  return (
    <Dialog
      title={t('planTitle')}
      onClose={onClose}
      data-testid="plan-dialog"
      footer={
        <FormActions form="lender-plan-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('setPlan')} busy={save.isPending} />
      }
    >
      <ValidatedForm
        id="lender-plan-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <p className="text-sm text-muted-foreground">
          {t('planHint', { currency: financing.currency, owed: financing.owed })}
        </p>
        {rows.map((r, i) => (
          <div key={r.key} className="field-row flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <FieldLabel label={`${t('instalment', { n: i + 1 })} · ${t('dueOn')}`} required>
                <DatePicker
                  name={`dueOn-${i}`}
                  required
                  value={r.dueOn}
                  onChange={(v) => setRows((xs) => xs.map((x) => (x.key === r.key ? { ...x, dueOn: v } : x)))}
                />
              </FieldLabel>
            </div>
            <div className="w-32 shrink-0">
              <FieldLabel label={t('amount')} required>
                <MoneyInput
                  name={`amount-${i}`}
                  required
                  value={r.amount}
                  onChange={(v) => setRows((xs) => xs.map((x) => (x.key === r.key ? { ...x, amount: v } : x)))}
                  placeholder={tph('money')}
                  className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </FieldLabel>
            </div>
            {rows.length > 1 && (
              <button
                type="button"
                aria-label={tc('delete')}
                onClick={() => setRows((xs) => xs.filter((x) => x.key !== r.key))}
                className="mb-1 shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => setRows((xs) => [...xs, { key: Date.now(), dueOn: '', amount: '' }])}
            className="inline-flex items-center gap-1 font-medium text-primary-600 hover:text-primary-700"
          >
            <Plus className="h-4 w-4" /> {t('addInstalment')}
          </button>
          <span className="text-muted-foreground">
            {t('planTotal')}: <Money value={total} currency={financing.currency} className="font-medium text-foreground" />
          </span>
        </div>
      </ValidatedForm>
    </Dialog>
  );
}

