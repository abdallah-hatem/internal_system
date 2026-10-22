'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Forklift, Loader2 } from '@/components/ui/icons';
import { useCan } from '@/lib/can';
import { MoveLeftoversDialog } from '@/components/cycles/move-leftovers-dialog';
import { Dialog, DialogCancel } from '@/components/ui/dialog';

/**
 * Paying out a settlement whose cycle still holds stock (`CYCLE_HAS_UNSOLD_STOCK`)
 * — the refusal's two ways forward, in place (§8):
 *
 * - **Move leftovers** (L5, owner 2026-10-11): the cycle's leftovers go to
 *   another cycle at their cost, so nothing is written off. It opens the
 *   cycle's own Move leftovers dialog; this prompt steps aside while it is
 *   open and comes back when it closes. After a save it says so, and paying
 *   out can be tried again — the server now reads what the cycle holds today.
 * - **Close anyway**: the old way, writing that cost off against the cycle.
 *
 * The same shape as I3's status refusal and its fix button. The fix is offered
 * only to a role that may move stock, and only when the refusal names the cycle.
 */
export function UnsoldStockPrompt({
  message,
  cycleId,
  cycleCode,
  paying,
  onPay,
  onClose,
}: {
  message: string;
  cycleId?: string;
  cycleCode?: string;
  paying: boolean;
  /** `acceptRemainingStock`: close anyway, writing the leftovers off. */
  onPay: (acceptRemainingStock: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations('settlementsPage');
  const tt = useTranslations('transfers');
  const tc = useTranslations('common');
  const mayMove = useCan('stockTransfer.create');
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState(false);

  if (moving && cycleId) {
    return (
      <MoveLeftoversDialog
        cycleId={cycleId}
        cycleCode={cycleCode ?? ''}
        onSaved={() => setMoved(true)}
        onClose={() => setMoving(false)}
      />
    );
  }

  return (
    <Dialog
      data-shipment-dialog="unsold-stock"
      size="sm"
      title={t('markPaid')}
      subtitle={cycleCode}
      onClose={onClose}
      busy={paying}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={paying} label={tc('cancel')} />
          {moved ? (
            <button
              type="button"
              data-testid="unsold-pay-again"
              disabled={paying}
              onClick={() => onPay(false)}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:min-h-0"
            >
              {paying && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('markPaid')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="unsold-close-anyway"
              disabled={paying}
              onClick={() => onPay(true)}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:min-h-0"
            >
              {paying && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('closeAnyway')}
            </button>
          )}
        </>
      }
      bodyClassName="space-y-4"
    >
      {moved ? (
        <p role="status" data-testid="unsold-moved" className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
          {tt('movedTryAgain')}
        </p>
      ) : (
        <>
          <p role="alert" data-testid="unsold-refusal" className="text-sm text-foreground">{message}</p>
          {mayMove && cycleId && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-2 text-sm text-foreground">{tt('instead')}</p>
              <button
                type="button"
                data-testid="unsold-move"
                onClick={() => setMoving(true)}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
              >
                <Forklift className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                {tt('moveLeftovers')}
              </button>
            </div>
          )}
          {/* What "Close anyway" does, beside it. */}
          <p className="text-xs text-muted-foreground">{t('acceptRemainingStockHint')}</p>
        </>
      )}
    </Dialog>
  );
}
