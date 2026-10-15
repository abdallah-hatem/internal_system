'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { DatePicker } from '@/components/ui/date-picker';
import { useAnnounceStatusMove } from './status-move';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { qtyInputClass, useRefreshShipment } from './ShipmentDialog';
import { fieldValue, onTheWayByLine, parseQty, type ShipmentLeg } from './shipment-model';

/**
 * Record a delivery: goods that reached the end of a leg on one day
 * (BUSINESS_LOGIC §1, 2026-10-10).
 *
 * Each product starts at what the leg still has on the way, because the usual
 * delivery is "the rest of it". A quantity the reader typed is kept as typed,
 * whatever the panel refetches underneath. The date is Cairo's today and later
 * days cannot be picked, as the server refuses them.
 *
 * Nothing is capped here: more than is on the way is the server's refusal
 * (`DELIVERY_EXCEEDS_IN_TRANSIT`), shown translated, with the dialog left open
 * and every value as typed.
 */
export function RecordDeliveryDialog({
  leg,
  productNames,
  onClose,
  onSaved,
}: {
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  onClose: () => void;
  /** Runs once the server accepted the delivery, before the dialog closes — a save, not a cancel. */
  onSaved?: (res: unknown) => void;
}) {
  const t = useTranslations('shipment');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const announce = useAnnounceStatusMove();
  const refresh = useRefreshShipment();

  const [arrivedOn, setArrivedOn] = useState(() => businessToday());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set before the request: `pending` only disables the button after a render.
  const submitting = useRef(false);

  const prefill = onTheWayByLine(leg);
  const rows = leg.lines.filter((l) => l.onTheWay > 0 || Object.prototype.hasOwnProperty.call(typed, l.purchaseOrderItemId));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;

    const lines: { purchaseOrderItemId: string; qty: number }[] = [];
    for (const row of rows) {
      const qty = parseQty(fieldValue(typed, prefill, row.purchaseOrderItemId));
      if (qty === null) {
        setRefusal(t('qtyNotNumber', { product: productNames[row.purchaseOrderItemId] ?? '' }));
        return;
      }
      if (qty !== 0) lines.push({ purchaseOrderItemId: row.purchaseOrderItemId, qty });
    }
    if (lines.length === 0) {
      setRefusal(t('nothingEntered'));
      return;
    }

    submitting.current = true;
    setPending(true);
    setRefusal(null);
    let res: unknown;
    try {
      res = await api.post(`/shipping/legs/${leg.legId}/deliveries`, {
        arrivedOn,
        lines,
        note: note.trim() || undefined,
      });
    } catch (err) {
      setRefusal(apiError(err, t('deliveryFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    refresh();
    // The delivery may have moved the cycle on (L3): say where it now stands.
    announce(t('deliveryRecorded'), res);
    onSaved?.(res);
    onClose();
  };

  return (
    <Dialog
      data-shipment-dialog="record-delivery"
      title={t('recordDeliveryTitle', { leg: leg.sequence })}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('recordDelivery')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('deliveredOn')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <DatePicker
          name="arrivedOn"
          required
          disableFuture
          value={arrivedOn}
          onChange={(v) => setArrivedOn(v || businessToday())}
        />
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-foreground">{t('qtyPerProduct')}</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('nothingOnTheWay')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => {
              const id = row.purchaseOrderItemId;
              const inputId = `delivery-qty-${id}`;
              return (
                <li key={id} className="grid grid-cols-[1fr_7rem] items-center gap-3">
                  <label htmlFor={inputId} className="min-w-0 text-sm">
                    <LatinText truncate className="font-medium text-foreground">{productNames[id] ?? '—'}</LatinText>
                    <span className="text-xs text-muted-foreground">{t('onTheWayCount', { count: row.onTheWay })}</span>
                  </label>
                  <input
                    id={inputId}
                    data-testid="delivery-qty"
                    data-line={id}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={fieldValue(typed, prefill, id)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTyped((prev) => ({ ...prev, [id]: value }));
                      setRefusal(null);
                    }}
                    placeholder={tph('quantitySmall')}
                    className={qtyInputClass}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <label htmlFor="delivery-note" className="mb-1 block text-sm font-medium text-foreground">
          {t('note')} <span className="text-xs font-normal text-muted-foreground">({tc('optional')})</span>
        </label>
        <textarea
          id="delivery-note"
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('notePlaceholder')}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>

      <DialogAlert message={refusal} />
    </Dialog>
  );
}
