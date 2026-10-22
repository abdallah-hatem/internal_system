'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { useToast } from '@/components/ui/toast';
import { Select } from '@/components/ui/select';
import { InputField } from '@/components/ui/fields';
import { FieldWithQuickCreate } from '@/components/ui/quick-create';
import { ValidatedForm } from '@/components/ui/validated-form';
import { Dialog } from '@/components/ui/dialog';
import { ShippingCostFields, readShippingCostFields, type ShippingCostDefaults } from '@/components/shipping/ShippingCostFields';
import { Link } from '@/i18n/navigation';
import { SHIPMENT_QUERY_KEYS } from './ShipmentDialog';
import { useAnnounceStatusMove } from './status-move';
import { LegDepartureFields, useLegDeparture } from './LegDepartureFields';
import { useShipment } from './ShipmentPanel';
import type { Shipment } from './shipment-model';

/**
 * A shipping leg's create and edit forms — defined once (CLAUDE.md §13) and
 * rendered by the Shipments page and by the cycle page's Shipment panel ("Add
 * next leg", "Edit leg"). Route, provider (with the provider `+`), tracking,
 * the leg's first departure (L8) and its cost. Each form owns its request,
 * its refusals and what it refreshes, so the two places cannot drift.
 */

/** A leg as `GET /shipping/legs` and `GET /cycles/:id` return it. */
export interface LegRow {
  id: string;
  cycleId: string;
  cycle?: { code: string };
  sequence: number;
  origin: string;
  destination: string;
  provider?: string | null;
  /** Null on every leg made before the pickers carried the id. */
  providerId?: string | null;
  trackingRef?: string | null;
  status: string;
  departedOn?: string | null;
  arrivedOn?: string | null;
  amount?: number | string | null;
  costBasis?: 'PER_PIECE' | 'PER_WEIGHT' | 'FLAT';
  ratePerUnit?: number | string | null;
  chargeablePieces?: number | string | null;
  chargeableWeightKg?: number | string | null;
  currency?: string;
  fxRateToEgp?: number | string | null;
  amountEgp?: number | string | null;
}

interface Provider {
  id: string;
  name: string;
  contactPerson?: string | null;
}

function useProviders() {
  const { data = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
  });
  const list: Provider[] = Array.isArray(data) ? data : [];

  /**
   * A chosen provider, as both the link and the label. The leg keeps the name
   * too: it is what the tables render, and it survives the provider record
   * being renamed or removed. `name:<x>` is a leg's own unlinked provider
   * offered back to it, so it carries no id.
   */
  const fields = (id: FormDataEntryValue | null) => {
    const value = String(id ?? '');
    if (value.startsWith('name:')) return { providerId: undefined, provider: value.slice(5) };
    const found = list.find((p) => p.id === value);
    return { providerId: found?.id, provider: found?.name };
  };

  /** The providers to choose from, plus whatever an older leg already says. */
  const options = (current?: string | null) => {
    const out = list.map((p) => ({ value: p.id, label: p.name, hint: p.contactPerson ?? undefined }));
    if (current && !list.some((p) => p.name === current)) {
      out.unshift({ value: `name:${current}`, label: current, hint: undefined });
    }
    return out;
  };
  return { list, fields, options };
}

/**
 * Whether a leg's cost can be changed now, as the server says it on the
 * cycle's shipment (§2, 2026-10-17): its own check, so the form offers the
 * fields exactly when a save would be accepted, names the refusal's reason by
 * its code when not, and warns when a change re-prices units already received.
 * While the shipment is loading nothing is locked; a save then is the server's
 * to refuse.
 */
export function legCostState(
  shipment: Pick<Shipment, 'costEditable' | 'costLockedReason' | 'costLockedParams' | 'costChangeRecosts'> | undefined,
): { locked: boolean; reason: string | null; params: Record<string, string>; recosts: boolean } {
  const locked = shipment?.costEditable === false;
  return {
    locked,
    reason: locked ? (shipment.costLockedReason ?? null) : null,
    params: (locked && shipment.costLockedParams) || {},
    recosts: !locked && shipment?.costChangeRecosts === true,
  };
}

/** The leg dialog's actions, in its fixed footer; `form` ties the submit to the form above. */
function FormButtons({ pending, onCancel, label, form }: { pending: boolean; onCancel: () => void; label: string; form: string }) {
  const tc = useTranslations('common');
  return (
    <>
      <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
        {tc('cancel')}
      </button>
      <button
        type="submit"
        form={form}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </button>
    </>
  );
}

/** Why the cost is fixed — the refusal's own sentence, by its code (rule 9) — and where a late charge goes. */
function CostLockedNote({ reason, params }: { reason: string | null; params: Record<string, string> }) {
  const t = useTranslations('shipments');
  const apiError = useApiError();
  const said = reason ? apiError({ response: { data: { error: { code: reason, params } } } }, t('costLocked')) : t('costLocked');
  return (
    <p data-testid="leg-cost-locked" data-reason={reason ?? undefined} className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
      {said}{' '}
      <Link href="/ledger" className="cursor-pointer font-medium text-primary hover:underline">
        {t('costLockedLedger')}
      </Link>
    </p>
  );
}

/**
 * Add a leg. On the Shipments page the cycle is picked; on a cycle's page it
 * is that cycle (`fixedCycle`) and the route's next leg is offered
 * (`defaults`).
 */
export function LegCreateForm({
  title,
  testId,
  cycles,
  fixedCycleId,
  defaults,
  costStart,
  onDone,
}: {
  /** The dialog's title; the form renders in the shared dialog (§13: it portals out of any form). */
  title: string;
  /** `data-leg-form` on the dialog, for tests. */
  testId?: string;
  /** The cycles to pick from — the Shipments page. */
  cycles?: { id: string; code: string; originType?: string; status?: string }[];
  /** The cycle this leg is for — the cycle page. */
  fixedCycleId?: string;
  defaults?: { sequence: number; origin: string; destination: string };
  /** The cost fields' starting currency and basis — the cycle page passes the route's (leg-plan.ts `legCostStart`). */
  costStart?: ShippingCostDefaults;
  onDone: () => void;
}) {
  const t = useTranslations('shipments');
  const tShipment = useTranslations('shipment');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const { addToast } = useToast();
  const announce = useAnnounceStatusMove();
  const queryClient = useQueryClient();
  const providers = useProviders();

  const [cycleId, setCycleId] = useState(fixedCycleId ?? '');
  const [providerId, setProviderId] = useState('');
  const departure = useLegDeparture(cycleId);

  const formId = useId();
  const create = useMutation({
    mutationFn: ({ cycleId: id, ...body }: Record<string, unknown> & { cycleId: string }) =>
      api.post(`/cycles/${id}/shipping-legs`, body),
    onSuccess: (res) => {
      // A leg created departed or arrived moves its cycle on (L3).
      for (const key of SHIPMENT_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone();
      announce(t('createSuccess'), res);
    },
    onError: (error) => addToast(apiError(error, tc('operationFailed')), 'error'),
  });

  return (
    <Dialog
      data-leg-form={testId}
      cardProps={{ 'data-testid': 'leg-create-form' }}
      title={title}
      onClose={onDone}
      busy={create.isPending}
      footer={<FormButtons form={formId} pending={create.isPending} onCancel={onDone} label={tc('create')} />}
    >
      <ValidatedForm
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          // The leg's first departure, per product (L8).
          const { departureLines, invalid } = departure.read();
          if (invalid) {
            addToast(tShipment('qtyNotNumber', { product: departure.productNames[invalid] ?? '' }), 'error');
            return;
          }
          create.mutate({
            cycleId: String(fd.get('cycleId') ?? ''),
            sequence: Number(fd.get('sequence')),
            origin: fd.get('origin'),
            destination: fd.get('destination'),
            ...providers.fields(fd.get('providerId')),
            trackingRef: fd.get('trackingRef'),
            ...(departure.departedOn ? { departedOn: departure.departedOn, departureLines } : {}),
            ...readShippingCostFields(fd),
          });
        }}
        className="space-y-4"
      >
        <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fixedCycleId ? (
            <input type="hidden" name="cycleId" value={fixedCycleId} />
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">{t('cycle')}</label>
              <Select
                name="cycleId"
                required
                value={cycleId}
                onChange={(v) => {
                  setCycleId(v);
                  // Another cycle waits for other goods: start its quantities afresh.
                  departure.setTyped({});
                }}
                placeholder={tph('chooseCycle')}
                searchPlaceholder={tph('searchCycles')}
                options={(cycles ?? []).map((c) => ({
                  value: c.id,
                  label: c.code,
                  hint: [c.originType && codeLabel('originType', c.originType), c.status && codeLabel('cycleStatus', c.status)]
                    .filter(Boolean)
                    .join(' · '),
                }))}
              />
            </div>
          )}
          <InputField
            label={t('sequence')}
            name="sequence"
            type="number"
            required
            placeholder={tph('legSequence')}
            defaultValue={defaults ? String(defaults.sequence) : undefined}
          />
        </div>

        <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InputField label={t('origin')} name="origin" required defaultValue={defaults?.origin} placeholder={tph('origin')} />
          <InputField label={t('destination')} name="destination" required defaultValue={defaults?.destination} placeholder={tph('destination')} />
        </div>

        <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              {t('provider')}
              <span className="ms-1 text-destructive">*</span>
            </label>
            <FieldWithQuickCreate entity="provider" onCreated={(pr) => setProviderId(pr.id)}>
              <Select
                name="providerId"
                required
                value={providerId}
                onChange={setProviderId}
                placeholder={tph('chooseProvider')}
                searchPlaceholder={tph('searchProviders')}
                options={providers.options()}
              />
            </FieldWithQuickCreate>
          </div>
          <InputField label={t('trackingRef')} name="trackingRef" placeholder={tph('trackingRef')} />
        </div>

        <LegDepartureFields state={departure} cycleId={cycleId || undefined} label={t('firstDeparture')} />

        <ShippingCostFields defaults={costStart} />

      </ValidatedForm>
    </Dialog>
  );
}

/**
 * Edit a leg: its departure (the first, while it has not left; its day, while
 * it left once), provider, tracking and cost. The cost is shown while the
 * server says it can change (§2, 2026-10-17) — after a receipt with a warning
 * that a change re-prices the cycle, sold units included; when it cannot, the
 * form says why and where a late charge goes instead, and sends no cost.
 */
export function LegEditForm({
  title,
  testId,
  leg,
  onDone,
  onCyclePage = false,
}: {
  /** The dialog's title; the form renders in the shared dialog (§13: it portals out of any form). */
  title: string;
  /** `data-leg-form` on the dialog, for tests. */
  testId?: string;
  leg: LegRow;
  onDone: () => void;
  /** Rendered on the cycle's own page: no links pointing back at it. */
  onCyclePage?: boolean;
}) {
  const t = useTranslations('shipments');
  const tShipment = useTranslations('shipment');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const apiError = useApiError();
  const { addToast } = useToast();
  const announce = useAnnounceStatusMove();
  const queryClient = useQueryClient();
  const providers = useProviders();
  const departure = useLegDeparture(leg.cycleId, leg.id);
  const { data: shipment } = useShipment(leg.cycleId);
  const cost = legCostState(shipment);
  const locked = cost.locked;
  const [providerId, setProviderId] = useState('');

  const formId = useId();
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`/shipping/legs/${leg.id}`, body),
    onSuccess: (res) => {
      // A departure moves the cycle's shipment, its leg statuses and, since
      // L3, the cycle's status too.
      for (const key of SHIPMENT_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone();
      announce(t('legUpdated'), res);
    },
    onError: (error) => addToast(apiError(error, tc('operationFailed')), 'error'),
  });

  return (
    <Dialog
      data-leg-form={testId}
      cardProps={{ 'data-testid': 'leg-edit-form' }}
      title={title}
      onClose={onDone}
      busy={update.isPending}
      footer={<FormButtons form={formId} pending={update.isPending} onCancel={onDone} label={tc('save')} />}
    >
      <ValidatedForm
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          // A leg that has not left records its first departure, per product,
          // as Record departure does (L8).
          const { departureLines, invalid } = departure.read();
          if (invalid) {
            addToast(tShipment('qtyNotNumber', { product: departure.productNames[invalid] ?? '' }), 'error');
            return;
          }
          // No `status` and no `arrivedOn`: a leg's status is read from what
          // was recorded, and arrivals are deliveries, recorded on the cycle's
          // Shipment panel (BUSINESS_LOGIC §1, 2026-10-10).
          update.mutate({
            departedOn: fd.get('departedOn') || null,
            departureLines,
            ...providers.fields(fd.get('providerId')),
            trackingRef: fd.get('trackingRef'),
            ...(locked ? {} : readShippingCostFields(fd)),
          });
        }}
        className="space-y-4"
      >
        {/* The leg's status, read from what was recorded — not a date. */}
        <p data-testid="leg-arrival" className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{t('status')}</span>
          {' · '}
          {codeLabel('legStatus', leg.status)}
          {leg.arrivedOn ? ` · ${formatDate(leg.arrivedOn)}` : ''}
        </p>
        {/* The same fields Record departure renders on the cycle page (I3, L8):
            one definition, the full width so a product's name has room. */}
        <LegDepartureFields
          state={departure}
          cycleId={leg.cycleId}
          label={t('departedOn')}
          defaultDepartedOn={leg.departedOn ?? null}
          linkToCycle={!onCyclePage}
        />
        {!onCyclePage && (
          <p className="text-xs text-muted-foreground">
            {t('arrivalsAreDeliveries')}{' '}
            <Link href={`/cycles/${leg.cycleId}/details`} data-testid="leg-open-cycle" className="cursor-pointer font-medium text-primary hover:underline">
              {t('openShipmentPanel')}
            </Link>
          </p>
        )}

        <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">{t('provider')}</label>
            <FieldWithQuickCreate entity="provider" onCreated={(pr) => setProviderId(pr.id)}>
              <Select
                name="providerId"
                value={
                  providerId ||
                  leg.providerId ||
                  providers.list.find((p) => p.name === leg.provider)?.id ||
                  (leg.provider ? `name:${leg.provider}` : '')
                }
                onChange={setProviderId}
                placeholder={tph('chooseProvider')}
                searchPlaceholder={tph('searchProviders')}
                options={providers.options(leg.provider)}
              />
            </FieldWithQuickCreate>
          </div>
          <InputField label={t('trackingRef')} name="trackingRef" defaultValue={leg.trackingRef ?? undefined} placeholder={tph('trackingRef')} />
        </div>

        {locked ? (
          <CostLockedNote reason={cost.reason} params={cost.params} />
        ) : (
          <ShippingCostFields
            defaults={{
              costBasis: leg.costBasis ?? 'FLAT',
              ratePerUnit: leg.ratePerUnit ?? '',
              chargeablePieces: leg.chargeablePieces ?? '',
              chargeableWeightKg: leg.chargeableWeightKg ?? '',
              amount: leg.amount ?? '',
              currency: leg.currency ?? 'EGP',
              fxRateToEgp: leg.fxRateToEgp ?? 1,
            }}
            // What actually went on this leg, so a per-piece count is checked
            // against it rather than trusted as typed.
            legPieces={shipment?.legs?.find((l) => l.legId === leg.id)?.entered || undefined}
          />
        )}
        {cost.recosts && (
          <p role="status" data-testid="leg-cost-recost-warning" className="flex items-start gap-1.5 rounded-lg border border-accent-200 bg-accent-50 px-2.5 py-1.5 text-sm text-accent-800">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">{t('costRecostWarning')}</span>
          </p>
        )}

      </ValidatedForm>
    </Dialog>
  );
}
