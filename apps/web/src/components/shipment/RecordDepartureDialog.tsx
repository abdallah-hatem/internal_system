'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { DatePicker } from '@/components/ui/date-picker';
import { useToast } from '@/components/ui/toast';
import { LegRoute } from './LegRoute';
import { DialogAlert, DialogCancel, DialogPrimary, ShipmentDialog, useRefreshShipment } from './ShipmentDialog';

/**
 * A leg's departure date — the one field that says when the goods left
 * (BUSINESS_LOGIC §1). The Shipments page's edit form and the Record departure
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

/** Set a leg's departure — the same `PUT /shipping/legs/:id` the Shipments page's edit form sends. */
export const recordDeparture = (legId: string, departedOn: string) =>
  api.put(`/shipping/legs/${legId}`, { departedOn });

/**
 * Record that a leg has left (BUSINESS_LOGIC §1): the date only. The day
 * starts at Cairo's today and later days cannot be picked; the server refuses
 * them too, and refuses a departure after a delivery already recorded on the
 * leg — shown here, translated, with the dialog left open.
 *
 * `onSaved` runs once the server accepted it, before the dialog closes, so a
 * caller can tell a save from a cancel (the status dialog retries on a save).
 */
export function RecordDepartureDialog({
  leg,
  onClose,
  onSaved,
}: {
  leg: { legId: string; sequence: number; origin?: string; destination?: string };
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useTranslations('shipment');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();

  const [departedOn, setDepartedOn] = useState(() => businessToday());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set before the request: `pending` only disables the button after a render.
  const submitting = useRef(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await recordDeparture(leg.legId, departedOn);
    } catch (err) {
      setRefusal(apiError(err, t('departureFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    refresh();
    toast.success(t('departureRecorded'));
    onSaved?.();
    onClose();
  };

  return (
    <ShipmentDialog
      testId="record-departure"
      size="sm"
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
      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
