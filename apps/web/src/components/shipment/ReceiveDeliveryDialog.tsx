'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
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
import {
  fieldValue,
  parseQty,
  receivableByLine,
  type ShipmentDelivery,
  type ShipmentLeg,
} from './shipment-model';

interface LandedCostItem {
  purchaseOrderItemId: string;
  landedUnitCostEgp: string;
}

/** The cycle's landed cost per ordered unit, read from the costing endpoint. One cache entry per cycle. */
export function useLandedUnitCosts(cycleId: string) {
  const { data } = useQuery<{ items?: LandedCostItem[] }>({
    queryKey: ['landedCost', cycleId],
    queryFn: () => api.get(`/costing/cycles/${cycleId}/landed-cost`).then((r) => r.data),
    retry: false,
  });
  return new Map((data?.items ?? []).map((i) => [i.purchaseOrderItemId, Number(i.landedUnitCostEgp)]));
}

/**
 * Receive one last-leg delivery into stock (BUSINESS_LOGIC §3, 2026-10-10).
 *
 * One component, opened from the cycle's Shipment panel and from the inventory
 * page's "Receive stock" list. Each line starts at what is still to be received
 * from it. The landed cost per unit is shown as the costing endpoint states it
 * (per unit ORDERED, §2); the server decides the cost it books, and an
 * override is sent only when one is typed.
 *
 * Two quick clicks send one receipt: the guard is a ref set before the
 * request, because the disabled button only lands after a render.
 */
export function ReceiveDeliveryDialog({
  cycleId,
  leg,
  delivery,
  productNames,
  onClose,
}: {
  cycleId: string;
  leg: ShipmentLeg;
  delivery: ShipmentDelivery;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const t = useTranslations('shipment');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const { formatDate } = useDateFormat();
  const costs = useLandedUnitCosts(cycleId);

  const [typed, setTyped] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const prefill = receivableByLine(delivery, leg);
  const rows = delivery.lines.filter(
    (l) => prefill[l.id] > 0 || Object.prototype.hasOwnProperty.call(typed, l.id),
  );

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;

    const items: { deliveryLineId: string; receivedQty: number; landedUnitCostEgp?: number }[] = [];
    for (const row of rows) {
      const name = productNames[row.purchaseOrderItemId] ?? '';
      const qty = parseQty(fieldValue(typed, prefill, row.id));
      if (qty === null) {
        setRefusal(t('qtyNotNumber', { product: name }));
        return;
      }
      if (qty === 0) continue;
      const overrideText = (overrides[row.id] ?? '').trim();
      let override: number | undefined;
      if (overrideText) {
        const parsed = parseQty(overrideText);
        if (parsed === null) {
          setRefusal(t('costNotNumber', { product: name }));
          return;
        }
        override = parsed;
      }
      items.push({
        deliveryLineId: row.id,
        receivedQty: qty,
        ...(override !== undefined ? { landedUnitCostEgp: override } : {}),
      });
    }
    if (items.length === 0) {
      setRefusal(t('nothingEntered'));
      return;
    }

    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post('/receipts/verify', { cycleId, deliveryId: delivery.id, items });
    } catch (err) {
      setRefusal(apiError(err, t('receiveFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    refresh();
    toast.success(t('received'));
    onClose();
  };

  return (
    <ShipmentDialog
      testId="receive-delivery"
      size="lg"
      title={t('receiveTitle', { date: formatDate(delivery.arrivedOn) })}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('receiveIntoStock')} />
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('receiveHint')}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('nothingWaitingOnDelivery')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => {
            const id = row.id;
            const unit = costs.get(row.purchaseOrderItemId);
            return (
              <li key={id} className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-[1fr_7rem_8rem_9rem] sm:items-center">
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <LatinText truncate className="text-sm font-medium text-foreground">
                    {productNames[row.purchaseOrderItemId] ?? '—'}
                  </LatinText>
                  <p className="text-xs text-muted-foreground">
                    {t('deliveredReceived', { delivered: row.qty, received: row.received })}
                  </p>
                </div>
                <label className="text-xs text-muted-foreground">
                  {t('receiveQty')}
                  <input
                    data-testid="receive-qty"
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
                    placeholder="0"
                    className={`mt-1 ${qtyInputClass}`}
                  />
                </label>
                <div className="text-xs text-muted-foreground">
                  {t('landedUnitCost')}
                  <p data-testid="receive-unit-cost" className="mt-1 py-2 text-sm text-foreground">
                    {unit !== undefined ? <Money value={unit} /> : '—'}
                  </p>
                </div>
                <label className="text-xs text-muted-foreground">
                  {t('costOverride')}
                  <input
                    data-testid="receive-cost-override"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={overrides[id] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      setOverrides((prev) => ({ ...prev, [id]: value }));
                    }}
                    placeholder={t('costOverridePlaceholder')}
                    className={`mt-1 ${qtyInputClass}`}
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
