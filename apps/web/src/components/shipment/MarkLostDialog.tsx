'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { Money } from '@/components/ui/money';
import { useToast } from '@/components/ui/toast';
import {
  DialogAlert,
  DialogCancel,
  DialogPrimary,
  ShipmentDialog,
  qtyInputClass,
  useRefreshShipment,
} from './ShipmentDialog';
import { useLandedUnitCosts } from './ReceiveDeliveryDialog';
import { losableByLine, num, parseQty, type ShipmentLeg } from './shipment-model';

type Step = 'edit' | 'confirm' | 'done';

/** How long the confirm button stays disabled after it replaces Continue. */
const CONFIRM_ARM_MS = 400;

/**
 * Mark goods lost on a leg (BUSINESS_LOGIC §1, §2, 2026-10-10).
 *
 * Three steps. The quantities and an optional reason; then a confirm step
 * that shows what the loss will cost; then, once booked, the amount the server
 * actually booked.
 *
 * Which figure is which (rule 11). There is no preview endpoint, and the
 * client must not have its own definition of a loss's cost. So:
 * - the confirm step shows each quantity times the costing endpoint's landed
 *   cost per ordered unit, and says plainly that it is an estimate — the line
 *   that accounts for an order line's last units takes the rounding residual on
 *   the server, so it can differ by a few piastres;
 * - the done step shows the `costEgp` of the losses the server returned, the
 *   amount on the books, which is the figure the panel shows from then on.
 */
export function MarkLostDialog({
  cycleId,
  leg,
  productNames,
  onClose,
}: {
  cycleId: string;
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const t = useTranslations('shipment');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const costs = useLandedUnitCosts(cycleId);

  const [step, setStep] = useState<Step>('edit');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [booked, setBooked] = useState<number | null>(null);
  const submitting = useRef(false);
  // A double-click on Continue must not land its second click on the confirm
  // button that takes its place: the loss is only booked by a deliberate click.
  // So the confirm button arrives disabled and arms itself a moment later. It
  // used to stay enabled and silently drop a click that came too soon, which
  // looked like a button that did nothing.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (step !== 'confirm') return;
    const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const losable = losableByLine(leg);
  const rows = leg.lines.filter(
    (l) => losable[l.purchaseOrderItemId] > 0 || Object.prototype.hasOwnProperty.call(typed, l.purchaseOrderItemId),
  );

  /** The lines with a quantity, or a message saying what is wrong. */
  const chosen = (): { lines: { purchaseOrderItemId: string; qty: number }[] } | { problem: string } => {
    const lines: { purchaseOrderItemId: string; qty: number }[] = [];
    for (const row of rows) {
      const qty = parseQty(typed[row.purchaseOrderItemId] ?? '');
      if (qty === null) return { problem: t('qtyNotNumber', { product: productNames[row.purchaseOrderItemId] ?? '' }) };
      if (qty !== 0) lines.push({ purchaseOrderItemId: row.purchaseOrderItemId, qty });
    }
    return lines.length ? { lines } : { problem: t('nothingEntered') };
  };

  const picked = chosen();
  const estimateRows = 'lines' in picked
    ? picked.lines.map((l) => {
        const unit = costs.get(l.purchaseOrderItemId);
        return {
          ...l,
          estimate: unit === undefined ? null : Math.round(l.qty * unit * 100) / 100,
        };
      })
    : [];
  const estimateKnown = estimateRows.every((r) => r.estimate !== null);
  const estimateTotal = estimateRows.reduce((s, r) => s + (r.estimate ?? 0), 0);

  const toConfirm = () => {
    if ('problem' in picked) {
      setRefusal(picked.problem);
      return;
    }
    setRefusal(null);
    setArmed(false);
    setStep('confirm');
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (step === 'edit') {
      toConfirm();
      return;
    }
    if (step !== 'confirm' || !armed || submitting.current || 'problem' in picked) return;

    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      const res = await api.post(`/shipping/legs/${leg.legId}/losses`, {
        lines: picked.lines,
        reason: reason.trim() || undefined,
      });
      const losses: { costEgp: number | string }[] = res.data?.data ?? [];
      setBooked(Math.round(losses.reduce((s, l) => s + num(l.costEgp), 0) * 100) / 100);
    } catch (err) {
      setRefusal(apiError(err, t('lossFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    submitting.current = false;
    setPending(false);
    refresh();
    toast.success(t('lossRecorded'));
    setStep('done');
  };

  const footer =
    step === 'edit' ? (
      <>
        <DialogCancel onClick={onClose} label={tc('cancel')} />
        <DialogPrimary label={t('continue')} />
      </>
    ) : step === 'confirm' ? (
      <>
        <DialogCancel onClick={() => setStep('edit')} disabled={pending} label={t('back')} />
        <DialogPrimary pending={pending} disabled={!armed} destructive label={t('confirmLoss')} />
      </>
    ) : (
      <DialogPrimary type="button" onClick={onClose} label={t('done')} />
    );

  return (
    <ShipmentDialog
      testId="mark-lost"
      title={t('markLostTitle', { leg: leg.sequence })}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={footer}
    >
      {step === 'edit' && (
        <>
          <p className="text-sm text-muted-foreground">{t('markLostHint')}</p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('nothingToLose')}</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const id = row.purchaseOrderItemId;
                const inputId = `lost-qty-${id}`;
                return (
                  <li key={id} className="grid grid-cols-[1fr_7rem] items-center gap-3">
                    <label htmlFor={inputId} className="min-w-0 text-sm">
                      <span className="block truncate font-medium text-foreground">{productNames[id] ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">{t('upTo', { count: losable[id] ?? 0 })}</span>
                    </label>
                    <input
                      id={inputId}
                      data-testid="lost-qty"
                      data-line={id}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={typed[id] ?? ''}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTyped((prev) => ({ ...prev, [id]: value }));
                        setRefusal(null);
                      }}
                      placeholder="0"
                      className={qtyInputClass}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          <div>
            <label htmlFor="loss-reason" className="mb-1 block text-sm font-medium text-foreground">
              {t('reason')} <span className="text-xs font-normal text-muted-foreground">({tc('optional')})</span>
            </label>
            <textarea
              id="loss-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
            />
          </div>
        </>
      )}

      {step === 'confirm' && (
        <div className="space-y-3">
          <p className="text-sm text-foreground">{t('confirmLossIntro')}</p>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {estimateRows.map((r) => (
              <li key={r.purchaseOrderItemId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  {productNames[r.purchaseOrderItemId] ?? '—'} × {r.qty}
                </span>
                <span className="shrink-0">{r.estimate === null ? '—' : <Money value={r.estimate} />}</span>
              </li>
            ))}
          </ul>
          <div data-testid="loss-estimate" className="rounded-lg bg-muted px-3 py-2 text-sm">
            <p className="font-medium text-foreground">
              {t('lossEstimate')}{' '}
              {estimateKnown ? <Money value={estimateTotal} /> : '—'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('lossEstimateHint')}</p>
          </div>
        </div>
      )}

      {step === 'done' && booked !== null && (
        <div data-testid="loss-booked" className="rounded-lg bg-muted px-3 py-3 text-sm">
          <p className="font-medium text-foreground">
            {t('lossBooked')} <Money value={booked} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('lossBookedHint')}</p>
        </div>
      )}

      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
