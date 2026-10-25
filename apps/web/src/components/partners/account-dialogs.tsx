'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCurrencyRates } from '@/lib/currency-rates';
import { businessToday } from '@/lib/dates';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/dialog';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { CurrencyRateFields } from '@/components/ui/currency-rate-fields';
import { FieldLabel, FormActions } from '@/components/ui/fields';
import { ValidatedForm } from '@/components/ui/validated-form';

/**
 * The dialogs a partner's running account needs (BUSINESS_LOGIC §8, owner
 * 2026-10-25): record a payment he made to a supplier (an advance), take
 * money out, reverse an entry, set a cycle's funding target. Opened from the
 * Partners page and the cycle's funding panel alike — one form each. Every
 * rule (never below zero, no future date, the rate) is the server's; the
 * screen says its refusal.
 */

export interface AccountMovement {
  id: string;
  kind: 'ADVANCE' | 'CONTRIBUTION' | 'WITHDRAWAL' | 'PAYOUT_LEFT_IN';
  amountEgp: string;
  signedEgp: string;
  amount: string;
  currency: string;
  fxRateToEgp: string;
  occurredOn: string;
  cycleId: string | null;
  cycleCode: string | null;
  settlementId: string | null;
  note: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface PartnerAccount {
  partnerUserId: string;
  name: string;
  email: string;
  active: boolean;
  balanceEgp: string;
  advancedEgp: string;
  leftInEgp: string;
  contributedEgp: string;
  withdrawnEgp: string;
  movements: AccountMovement[];
}

/** Everything an account change can move, refreshed together. */
export function useRefreshAccounts() {
  const qc = useQueryClient();
  return () => {
    for (const key of [['partner-accounts'], ['account-funding'], ['cycle'], ['cycles'], ['landedCost'], ['users', 'participation']]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  };
}

const inputClass =
  'w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';

/** He paid a supplier for a cycle from his own pocket. */
export function RecordAdvanceDialog({
  partners,
  partnerUserId,
  cycles,
  cycleId,
  onClose,
}: {
  partners: { partnerUserId: string; name: string }[];
  /** Preselected partner; the picker stays to change it. */
  partnerUserId?: string;
  /** The cycles he may have paid for, each with its currency. */
  cycles: { id: string; code: string; currency: string }[];
  /** A fixed cycle (from the cycle's own page): no cycle picker. */
  cycleId?: string;
  onClose: () => void;
}) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshAccounts();
  const rates = useCurrencyRates();
  const [who, setWho] = useState(partnerUserId ?? '');
  const [cycle, setCycle] = useState(cycleId ?? '');
  const [amount, setAmount] = useState('');
  const chosen = cycles.find((c) => c.id === cycle);
  const currencies = [...new Set(['EGP', ...(chosen ? [chosen.currency] : []), ...Object.keys(rates)])];
  const name = partners.find((p) => p.partnerUserId === who)?.name ?? '';

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/partner-accounts/${who}/advances`, body),
    onSuccess: () => {
      refresh();
      addToast(t('advanceSaved', { name }), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, t('advanceFailed')), 'error'),
  });

  return (
    <Dialog
      title={t('advanceTitle')}
      description={t('advanceHint')}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'record-advance-dialog' }}
      footer={<FormActions form="record-advance-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('recordPayment')} busy={save.isPending} />}
    >
      <ValidatedForm
        id="record-advance-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const rate = fd.get('fxRateToEgp');
          save.mutate({
            cycleId: cycle,
            amount: Number(amount),
            currency: fd.get('currency') || 'EGP',
            ...(rate ? { fxRateToEgp: Number(rate) } : {}),
            paidOn: (fd.get('paidOn') as string) || undefined,
            note: ((fd.get('note') as string) || '').trim() || undefined,
          });
        }}
      >
        <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldLabel label={t('partner')} required>
            <Select
              name="partner"
              required
              value={who}
              onChange={setWho}
              placeholder={tph('choosePerson')}
              options={partners.map((p) => ({ value: p.partnerUserId, label: p.name }))}
            />
          </FieldLabel>
          {!cycleId && (
            <FieldLabel label={t('cycle')} required>
              <Select
                name="cycle"
                required
                value={cycle}
                onChange={setCycle}
                placeholder={tph('chooseCycle')}
                searchPlaceholder={tph('searchCycles')}
                options={cycles.map((c) => ({ value: c.id, label: c.code, hint: c.currency }))}
              />
            </FieldLabel>
          )}
        </div>
        <div>
          <label htmlFor="advance-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amountPaid')}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput id="advance-amount" name="amount" required value={amount} onChange={setAmount} placeholder={tph('money')} className={inputClass} />
        </div>
        {/* Keyed by the cycle, so picking another cycle starts its currency over. */}
        <CurrencyRateFields
          key={chosen?.id ?? 'none'}
          rateName="fxRateToEgp"
          currencies={currencies}
          defaultCurrency={chosen?.currency ?? 'EGP'}
          currencyLabel={t('currency')}
          rateLabel={t('rate')}
          required
        />
        <FieldLabel label={t('datePaid')} required>
          <DatePicker name="paidOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
        <FieldLabel label={t('note')}>
          <input name="note" maxLength={500} className={inputClass} />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** Money he takes out of his account, never more than it holds. */
export function WithdrawDialog({ account, onClose }: { account: PartnerAccount; onClose: () => void }) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshAccounts();
  const [amount, setAmount] = useState('');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/partner-accounts/${account.partnerUserId}/withdrawals`, body),
    onSuccess: () => {
      refresh();
      addToast(t('withdrawSaved', { name: account.name }), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, t('withdrawFailed')), 'error'),
  });
  return (
    <Dialog
      title={t('withdrawTitle', { name: account.name })}
      description={t.rich('withdrawHint', { amount: () => <Money value={account.balanceEgp} /> })}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'withdraw-dialog' }}
      footer={<FormActions form="withdraw-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('takeOut')} busy={save.isPending} />}
    >
      <ValidatedForm
        id="withdraw-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          save.mutate({
            amountEgp: Number(amount),
            takenOn: (fd.get('takenOn') as string) || undefined,
            note: ((fd.get('note') as string) || '').trim() || undefined,
          });
        }}
      >
        <div>
          <label htmlFor="withdraw-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amountEgp')}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput id="withdraw-amount" name="amountEgp" required value={amount} onChange={setAmount} placeholder={tph('money')} className={inputClass} />
        </div>
        <FieldLabel label={t('date')} required>
          <DatePicker name="takenOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
        <FieldLabel label={t('note')}>
          <input name="note" maxLength={500} className={inputClass} />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** Reverse one entry, once, with a reason (§9). */
export function ReverseMovementDialog({
  partnerUserId,
  movementId,
  onClose,
}: {
  partnerUserId: string;
  movementId: string;
  onClose: () => void;
}) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshAccounts();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => api.post(`/partner-accounts/${partnerUserId}/movements/${movementId}/reverse`, { reason: reason.trim() }),
    onSuccess: () => {
      refresh();
      addToast(t('reversedDone'), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, tc('operationFailed')), 'error'),
  });
  return (
    <Dialog
      title={t('reverseTitle')}
      description={t('reverseHint')}
      onClose={onClose}
      busy={run.isPending}
      cardProps={{ 'data-testid': 'reverse-movement-dialog' }}
      footer={<FormActions form="reverse-movement-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('reverse')} busy={run.isPending} disabled={!reason.trim()} />}
    >
      <ValidatedForm
        id="reverse-movement-form"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <FieldLabel label={t('reason')} required>
          <input name="reason" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** A cycle's optional funding target, in its own currency at the rate typed. */
export function FundingTargetDialog({
  cycleId,
  cycleCurrency,
  target,
  onClose,
}: {
  cycleId: string;
  cycleCurrency: string;
  target: { amount: string; currency: string; fxRateToEgp: string } | null;
  onClose: () => void;
}) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshAccounts();
  const rates = useCurrencyRates();
  const [amount, setAmount] = useState(target?.amount ?? '');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`/cycles/${cycleId}/funding-target`, body),
    onSuccess: () => {
      refresh();
      addToast(t('targetSaved'), 'success');
      onClose();
    },
    onError: (e) => addToast(apiError(e, t('targetFailed')), 'error'),
  });
  return (
    <Dialog
      title={t('targetTitle')}
      description={t('targetHint')}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'funding-target-dialog' }}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          {target ? (
            <button
              type="button"
              onClick={() => save.mutate({ amount: null })}
              disabled={save.isPending}
              className="text-sm font-medium text-destructive hover:underline disabled:opacity-50"
            >
              {t('removeTarget')}
            </button>
          ) : (
            <span />
          )}
          <FormActions form="funding-target-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={tc('save')} busy={save.isPending} />
        </div>
      }
    >
      <ValidatedForm
        id="funding-target-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const rate = fd.get('fxRateToEgp');
          save.mutate({
            amount: Number(amount),
            currency: fd.get('currency') || cycleCurrency,
            ...(rate ? { fxRateToEgp: Number(rate) } : {}),
          });
        }}
      >
        <div>
          <label htmlFor="target-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('targetAmount')}
            <span className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput id="target-amount" name="amount" required value={amount} onChange={setAmount} placeholder={tph('money')} className={inputClass} />
        </div>
        <CurrencyRateFields
          rateName="fxRateToEgp"
          currencies={[...new Set(['EGP', cycleCurrency, ...Object.keys(rates)])]}
          defaultCurrency={target?.currency ?? cycleCurrency}
          defaultRate={target?.fxRateToEgp}
          currencyLabel={t('currency')}
          rateLabel={t('rate')}
          required
        />
      </ValidatedForm>
    </Dialog>
  );
}
