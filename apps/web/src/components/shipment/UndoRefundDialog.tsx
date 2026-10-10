'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useToast } from '@/components/ui/toast';
import { DialogAlert, DialogCancel, DialogPrimary, ShipmentDialog, useRefreshShipment } from './ShipmentDialog';
import { type ShipmentLossRefund } from './shipment-model';
import { Money } from '@/components/ui/money';

/** The longest reason the server takes. */
const REASON_MAX = 500;

/**
 * Undo a refund on a loss — the money was handed back (BUSINESS_LOGIC §6, §9;
 * B5b). The dialog is the confirm step: it says what will happen, asks why
 * (§9: a reason is required), and only the confirm button sends.
 *
 * One request however fast the button is pressed. A refusal — already undone
 * (`ENTRY_ALREADY_REVERSED`), gone (`NOT_FOUND`) — is shown in the reader's
 * language and the dialog stays open with the reason as typed.
 */
export function UndoRefundDialog({ refund, onClose }: { refund: ShipmentLossRefund; onClose: () => void }) {
  const t = useTranslations('shipment');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (sending.current) return;
    const why = reason.trim();
    if (!why) {
      setRefusal(t('undoRefundReasonRequired'));
      return;
    }
    sending.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/purchases/refunds/${refund.id}/reverse`, { reason: why });
    } catch (err) {
      setRefusal(apiError(err, t('undoRefundFailed')));
      sending.current = false;
      setPending(false);
      return;
    }
    refresh();
    // The undo writes a balancing ledger row too.
    void queryClient.invalidateQueries({ queryKey: ['ledger'] });
    toast.success(t('refundUndone'));
    onClose();
  };

  return (
    <ShipmentDialog
      testId="undo-refund"
      size="sm"
      title={t('undoRefundTitle')}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary destructive pending={pending} label={t('undoRefund')} />
        </>
      }
    >
      <p className="text-sm text-foreground">
        {t.rich('undoRefundConfirm', {
          amount: () => <Money value={refund.amountEgp} />,
          payer: refund.payerName ?? '—',
          name: (chunks) => <bdi>{chunks}</bdi>,
        })}
      </p>
      <div>
        <label htmlFor="undo-refund-reason" className="mb-1 block text-sm font-medium text-foreground">
          {t('undoRefundReason')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <textarea
          id="undo-refund-reason"
          rows={3}
          required
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setRefusal(null);
          }}
          placeholder={t('undoRefundReasonPlaceholder')}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>
      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
