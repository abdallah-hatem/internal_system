'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiError } from '@/lib/api-error';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { useRefreshShipment } from './ShipmentDialog';

/**
 * "Are you sure?" for a shipment write that removes something — deleting a
 * delivery, taking a loss back. A refusal (`DELIVERY_IN_USE`,
 * `LOSS_REFUNDED`…) is shown translated inside the dialog, which stays open.
 */
export function ConfirmActionDialog({
  title,
  message,
  confirmLabel,
  successMessage,
  failMessage,
  action,
  onClose,
  testId,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  successMessage: string;
  failMessage: string;
  action: () => Promise<unknown>;
  onClose: () => void;
  testId: string;
}) {
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await action();
    } catch (err) {
      setRefusal(apiError(err, failMessage));
      running.current = false;
      setPending(false);
      return;
    }
    refresh();
    toast.success(successMessage);
    onClose();
  };

  return (
    <Dialog
      data-shipment-dialog={testId}
      size="sm"
      title={title}
      onClose={onClose}
      busy={pending}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary type="button" destructive pending={pending} onClick={() => void run()} label={confirmLabel} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <p className="text-sm text-foreground">{message}</p>
      <DialogAlert message={refusal} />
    </Dialog>
  );
}
