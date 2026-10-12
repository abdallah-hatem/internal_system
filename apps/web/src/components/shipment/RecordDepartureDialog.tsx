'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { DatePicker } from '@/components/ui/date-picker';
import { useAnnounceStatusMove } from './status-move';
import { LegRoute } from './LegRoute';
import { DialogAlert, DialogCancel, DialogPrimary, ShipmentDialog, qtyInputClass, useRefreshShipment } from './ShipmentDialog';
import { atOriginByLine, departureLinesFrom, fieldValue, type ShipmentLeg } from './shipment-model';

/**
 * A leg's departure date — the one field that says when the goods left
 * (BUSINESS_LOGIC §1). The Shipments page's forms and the Record departure
 * dialog both render this, so the label, the "no future days" rule and the
 * field name are written once.
 */
export function DepartedOnField({
  label,
  name = 'departedOn',
  value,
  defaultValue,
  onChange,
  required = false,
  hint,
}: {
  label: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-foreground">
        {label}
        {required && <span aria-hidden="true" className="ms-1 text-destructive">*</span>}
      </label>
      <DatePicker
        name={name}
        required={required}
        disableFuture
        value={value}
        defaultValue={defaultValue === undefined ? undefined : defaultValue.slice(0, 10)}
        onChange={onChange}
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * How many of each product left (L8) — one row per product with something
 * waiting at the leg's origin, each starting at everything waiting. A number
 * the reader typed is kept as typed whatever the shipment refetches
 * underneath (`fieldValue`). Rendered by the Record departure dialog and by
 * the Shipments page's leg forms: one definition of the field (§13).
 */
export function DepartureQtyFields({
  waiting,
  productNames,
  typed,
  onType,
}: {
  /** Per order line, what waits at the origin — the server's `atOrigin`. */
  waiting: Record<string, number>;
  productNames: Record<string, string>;
  typed: Record<string, string>;
  onType: (id: string, value: string) => void;
}) {
  const t = useTranslations('shipment');
  const rows = departureRowIds(waiting, typed);
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">{t('departureQtyPerProduct')}</p>
      {rows.length === 0 ? (
        <p data-testid="nothing-waiting-to-leave" className="text-sm text-muted-foreground">
          {t('nothingWaitingToLeave')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((id) => {
            const inputId = `departure-qty-${id}`;
            return (
              <li key={id} className="grid grid-cols-[1fr_7rem] items-center gap-3">
                <label htmlFor={inputId} className="min-w-0 text-sm">
                  <LatinText truncate className="font-medium text-foreground">{productNames[id] ?? '—'}</LatinText>
                  <span className="text-xs text-muted-foreground">{t('waitingCount', { count: waiting[id] ?? 0 })}</span>
                </label>
                <input
                  id={inputId}
                  data-testid="departure-qty"
                  data-line={id}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={fieldValue(typed, waiting, id)}
                  onChange={(e) => onType(id, e.target.value)}
                  placeholder="0"
                  className={qtyInputClass}
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('departureHintParts')}</p>
    </div>
  );
}

/** The rows a departure form shows: what waits, plus anything already typed into. */
export function departureRowIds(waiting: Record<string, number>, typed: Record<string, string>): string[] {
  return Object.keys(waiting).filter(
    (id) => (waiting[id] ?? 0) > 0 || Object.prototype.hasOwnProperty.call(typed, id),
  );
}

/** Record a departure — `POST /shipping/legs/:id/departures` (L8). */
export const recordDeparture = (
  legId: string,
  body: { departedOn: string; lines: { purchaseOrderItemId: string; qty: number }[] },
) => api.post(`/shipping/legs/${legId}/departures`, body);

/**
 * Record goods leaving a leg (BUSINESS_LOGIC §1, L8): the day, and how many of
 * each product left. Each product starts at everything still waiting at the
 * leg's origin; lowering one leaves the rest waiting for a later departure.
 * The day starts at Cairo's today and later days cannot be picked; the server
 * refuses them too, and refuses more than waits or a day before the goods
 * could be there — shown here, translated, with the dialog left open and every
 * value as typed.
 *
 * `onSaved` runs once the server accepted it, before the dialog closes, so a
 * caller can tell a save from a cancel (the status dialog retries on a save).
 */
export function RecordDepartureDialog({
  leg,
  productNames,
  onClose,
  onSaved,
}: {
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  onClose: () => void;
  onSaved?: (res: unknown) => void;
}) {
  const t = useTranslations('shipment');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const announce = useAnnounceStatusMove();
  const refresh = useRefreshShipment();

  const [departedOn, setDepartedOn] = useState(() => businessToday());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set before the request: `pending` only disables the button after a render.
  const submitting = useRef(false);

  const waiting = atOriginByLine(leg);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    const { lines, invalid } = departureLinesFrom(typed, waiting, departureRowIds(waiting, typed));
    if (invalid) {
      setRefusal(t('qtyNotNumber', { product: productNames[invalid] ?? '' }));
      return;
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
      res = await recordDeparture(leg.legId, { departedOn, lines });
    } catch (err) {
      setRefusal(apiError(err, t('departureFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    refresh();
    // The first departure may have moved the cycle on (L3): say where it now stands.
    announce(t('departureRecorded'), res);
    onSaved?.(res);
    onClose();
  };

  return (
    <ShipmentDialog
      testId="record-departure"
      title={t('recordDepartureTitle', { leg: leg.sequence })}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('recordDeparture')} />
        </>
      }
    >
      {leg.origin && leg.destination && (
        <LegRoute className="text-sm text-muted-foreground" origin={leg.origin} destination={leg.destination} />
      )}
      <DepartedOnField
        label={t('departureDate')}
        required
        value={departedOn}
        onChange={(v) => {
          setDepartedOn(v || businessToday());
          setRefusal(null);
        }}
        hint={t('departureHint')}
      />
      <DepartureQtyFields
        waiting={waiting}
        productNames={productNames}
        typed={typed}
        onType={(id, value) => {
          setTyped((prev) => ({ ...prev, [id]: value }));
          setRefusal(null);
        }}
      />
      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
