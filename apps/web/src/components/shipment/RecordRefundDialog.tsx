'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { formatAmount } from '@/lib/numbers';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { Select } from '@/components/ui/select';
import { CurrencyRateFields } from '@/components/ui/currency-rate-fields';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { useRefreshShipment } from './ShipmentDialog';
import { lossRecovery, type ShipmentLoss } from './shipment-model';

export interface RefundPayer {
  type: 'SHIPPING_PROVIDER' | 'SUPPLIER';
  id: string;
  name: string;
}

const CURRENCIES = ['EGP', 'USD', 'AED', 'CNY'];

/**
 * Record money given back for a loss (BUSINESS_LOGIC §6, amendment 13).
 *
 * The dialog shows the loss, what was refunded so far and what is still
 * unrecovered, all as the server reports them. Whoever pays is one of two:
 * the leg's shipping provider or the order's supplier — the server refuses
 * anyone else. The currency's rate is filled from the app's FX rates, as every
 * other money form does, and stays editable.
 *
 * More than the loss (`REFUND_EXCEEDS_LOSS`) is the server's refusal, in the
 * reader's language, with every value kept as typed.
 */
export function RecordRefundDialog({
  loss,
  productName,
  payers,
  onClose,
}: {
  loss: ShipmentLoss;
  productName: string;
  payers: RefundPayer[];
  onClose: () => void;
}) {
  const t = useTranslations('shipment');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const { cost, refunded, unrecovered } = lossRecovery(loss);

  const [payer, setPayer] = useState(() => (payers.length === 1 ? key(payers[0]) : ''));
  const [amount, setAmount] = useState('');
  const [recordedOn, setRecordedOn] = useState(() => businessToday());
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    const fd = new FormData(e.currentTarget);
    const chosen = payers.find((p) => key(p) === payer);
    if (!chosen) {
      setRefusal(t('payerRequired'));
      return;
    }
    const value = Number(amount);
    if (!(value > 0)) {
      setRefusal(t('amountNotPositive'));
      return;
    }
    const currency = String(fd.get('currency') || 'EGP');
    const fxRateToEgp = currency === 'EGP' ? 1 : Number(fd.get('fxRateToEgp'));
    if (!(fxRateToEgp > 0)) {
      setRefusal(t('rateRequired'));
      return;
    }

    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/shipping/losses/${loss.id}/refunds`, {
        amount: value,
        currency,
        fxRateToEgp,
        recordedOn,
        payer: { type: chosen.type, id: chosen.id },
        reason: reason.trim() || undefined,
      });
    } catch (err) {
      setRefusal(apiError(err, t('refundFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    refresh();
    toast.success(t('refundRecorded'));
    onClose();
  };

  return (
    <Dialog
      data-shipment-dialog="record-refund"
      title={t('refundTitle')}
      subtitle={productName}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('recordRefund')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <dl data-testid="refund-summary" className="grid grid-cols-3 gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{t('lossCost')}</dt>
          <dd className="font-medium text-foreground"><Money value={cost} /></dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('refundedSoFar')}</dt>
          <dd className="font-medium text-foreground"><Money value={refunded} /></dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('unrecovered')}</dt>
          <dd className="font-medium text-foreground"><Money value={unrecovered} /></dd>
        </div>
      </dl>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('payer')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <Select
          name="payer"
          required
          value={payer}
          onChange={(v) => {
            setPayer(v);
            setRefusal(null);
          }}
          placeholder={t('payerPlaceholder')}
          options={payers.map((p) => ({
            value: key(p),
            label: p.name,
            hint: p.type === 'SHIPPING_PROVIDER' ? t('payerProvider') : t('payerSupplier'),
          }))}
        />
      </div>

      <div>
        <label htmlFor="refund-amount" className="mb-1 block text-sm font-medium text-foreground">
          {t('refundAmount')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <MoneyInput
          id="refund-amount"
          required
          value={amount}
          onChange={(raw) => {
            setAmount(raw);
            setRefusal(null);
          }}
          placeholder={unrecovered > 0 ? formatAmount(unrecovered) : tph('money')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>

      <CurrencyRateFields
        rateName="fxRateToEgp"
        currencies={CURRENCIES}
        defaultCurrency="EGP"
        currencyLabel={t('currency')}
        rateLabel={t('fxRate')}
        required
      />

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('refundedOn')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <DatePicker
          name="recordedOn"
          required
          disableFuture
          value={recordedOn}
          onChange={(v) => setRecordedOn(v || businessToday())}
        />
      </div>

      <div>
        <label htmlFor="refund-reason" className="mb-1 block text-sm font-medium text-foreground">
          {t('reason')} <span className="text-xs font-normal text-muted-foreground">({tc('optional')})</span>
        </label>
        <textarea
          id="refund-reason"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('refundReasonPlaceholder')}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>

      <DialogAlert message={refusal} />
    </Dialog>
  );
}

const key = (p: RefundPayer) => `${p.type}:${p.id}`;
