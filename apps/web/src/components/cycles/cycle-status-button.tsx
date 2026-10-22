'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, Plus, Send } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { nextStatuses } from '@/lib/cycle-transitions';
import { useToast } from '@/components/ui/toast';
import { useShipment } from '@/components/shipment/ShipmentPanel';
import { RecordDeliveryDialog } from '@/components/shipment/RecordDeliveryDialog';
import { RecordDepartureDialog } from '@/components/shipment/RecordDepartureDialog';
import type { ShipmentLeg } from '@/components/shipment/shipment-model';
import { statusMoveOf } from '@/components/shipment/status-move';
import { Dialog } from '@/components/ui/dialog';

/**
 * Moving a cycle to another status, from the cycle's own page.
 *
 * It used to live in a slide-over on the cycles list, opened by clicking a
 * row. Once a row opened the details page (owner, 2026-10-11) nothing opened
 * the slide-over any more, and status changes had no way in at all. The owner
 * ruled that it moves here: the details page is where a cycle is read, so it
 * is where it is moved on.
 *
 * Offered only to a role with `cycle.transition` (the server's RolesGuard says
 * the same), and only while the status has somewhere to go — the same table
 * the server enforces (`lib/cycle-transitions.ts`), so it never offers a move
 * that ends in a refusal. The server still has the last word: a move the
 * shipping dates do not support yet is refused there, and the refusal's own
 * words are shown in the dialog.
 *
 * A refusal because a leg has not left (`LEG_NOT_DEPARTED`) or has had nothing
 * delivered (`LEG_NOT_ARRIVED`) offers the fix in place (I3, owner
 * 2026-10-11): the departure form or Record delivery for the very leg the
 * server named in `params.legId`. The status dialog steps aside while that is
 * open and comes back when it closes, ready to try the move again.
 */
export function canChangeStatus(status: string | undefined, allowed: boolean): boolean {
  return allowed && nextStatuses(status).length > 0;
}

/** The refusals a leg's own action can fix. Read from the code, never the words (CLAUDE.md §9). */
const LEG_REFUSALS = ['LEG_NOT_DEPARTED', 'LEG_NOT_ARRIVED'];

export type LegFix = 'departure' | 'delivery';

/**
 * Which action would answer a refusal on this leg, or null when there is none
 * this person can take. A leg not yet left needs its departure first, whatever
 * the code: a delivery on it would be refused in turn (`LEG_NOT_DEPARTED`).
 */
export function legFixFor(
  code: string | undefined,
  leg: Pick<ShipmentLeg, 'departedOn' | 'status' | 'onTheWay'> | undefined,
  may: { depart: boolean; deliver: boolean },
): LegFix | null {
  if (!code || !LEG_REFUSALS.includes(code) || !leg) return null;
  const departed = !!leg.departedOn || leg.status !== 'PENDING';
  if (code === 'LEG_NOT_DEPARTED' || !departed) return may.depart ? 'departure' : null;
  return may.deliver && leg.onTheWay > 0 ? 'delivery' : null;
}

interface StatusRefusal {
  message: string;
  code?: string;
  legId?: string;
}

function refusalOf(error: unknown, message: string): StatusRefusal {
  const body = (error as { response?: { data?: { error?: { code?: string; params?: Record<string, unknown> } } } })
    ?.response?.data?.error;
  const legId = body?.params?.legId;
  return { message, code: body?.code, legId: typeof legId === 'string' ? legId : undefined };
}

export function CycleStatusButton({ cycleId, status }: { cycleId: string; status: string | undefined }) {
  const t = useTranslations('cycles');
  const ts = useTranslations('shipment');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const allowed = useCan('cycle.transition');
  const may = { depart: useCan('shipment.recordDeparture'), deliver: useCan('shipment.recordDelivery') };
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<StatusRefusal | null>(null);
  // The fix dialog open over the page, for one leg. While it is, the status
  // dialog is closed; its refusal is kept so a cancel brings it back as it was.
  const [fixing, setFixing] = useState<{ kind: LegFix; legId: string } | null>(null);
  const [fixSaved, setFixSaved] = useState(false);
  // Set when a fix's save moved the cycle and closed everything: the fix
  // dialog's own close, which follows its save, must not bring the status
  // dialog back.
  const fixFinished = useRef(false);

  // The shipment the details page already holds (one cache entry), read only
  // once a refusal names a leg.
  const { data: shipment } = useShipment(refusal?.legId || fixing ? cycleId : undefined);
  const legOf = (legId: string | undefined) => shipment?.legs?.find((l) => l.legId === legId);
  const locale = useLocale();
  const productNames = useMemo(
    () => Object.fromEntries((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, localName({ name: l.productName, nameAr: l.productNameAr }, locale) || '—'])),
    [shipment, locale],
  );

  /** Every way into the dialog and out of it goes through these two (CLAUDE.md §13). */
  const openStatus = () => {
    setRefusal(null);
    setFixSaved(false);
    setFixing(null);
    setOpen(true);
  };
  const closeStatus = () => {
    setOpen(false);
    setRefusal(null);
    setFixSaved(false);
    setFixing(null);
  };

  const move = useMutation({
    mutationFn: (to: string) => api.post(`/cycles/${cycleId}/transition`, { status: to }),
    onMutate: () => {
      setRefusal(null);
      setFixSaved(false);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cycles'] });
      void queryClient.invalidateQueries({ queryKey: ['cycle'] });
      void queryClient.invalidateQueries({ queryKey: ['shipment'] });
      closeStatus();
      addToast(t('statusUpdated'), 'success');
    },
    onError: (error: unknown) => setRefusal(refusalOf(error, apiError(error, t('transitionFailed')))),
  });

  if (!canChangeStatus(status, allowed)) return null;
  const options = nextStatuses(status);
  const fixLeg = refusal?.legId ? legOf(refusal.legId) : undefined;
  const fix = legFixFor(refusal?.code, fixLeg, may);

  const startFix = () => {
    if (!fix || !refusal?.legId) return;
    fixFinished.current = false;
    setFixing({ kind: fix, legId: refusal.legId });
    setOpen(false);
  };
  /**
   * The fix dialog closed: by a save (`saved`) or any other way. The status
   * dialog comes back — unless the save itself moved the cycle on (L3, §1):
   * then the move the reader came for has happened, the toast said where the
   * cycle now stands, and there is nothing left to try.
   */
  const endFix = (saved: boolean, res?: unknown) => {
    if (fixFinished.current) {
      fixFinished.current = false;
      return;
    }
    if (saved && statusMoveOf(res)?.moved) {
      fixFinished.current = true;
      closeStatus();
      return;
    }
    setFixing(null);
    if (saved) {
      setRefusal(null);
      setFixSaved(true);
    }
    setOpen(true);
  };
  const fixingLeg = fixing ? legOf(fixing.legId) : undefined;

  return (
    <>
      <button
        type="button"
        data-testid="change-status"
        onClick={openStatus}
        className="bg-background inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted touch-manipulation"
      >
        <ArrowRightLeft className="h-4 w-4" aria-hidden="true" /> {t('transition')}
      </button>

      {open && (
        <Dialog
          size="sm"
          cardProps={{ 'data-testid': 'change-status-dialog' }}
          title={t('transition')}
          description={
            <>
              {t('currentStatus')} {codeLabel('cycleStatus', status ?? '')}
            </>
          }
          onClose={closeStatus}
          busy={move.isPending}
          bodyClassName="space-y-4"
          footer={
            <button
              type="button"
              onClick={closeStatus}
              disabled={move.isPending}
              className="min-h-11 rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
            >
              {tc('cancel')}
            </button>
          }
        >
          <div className="space-y-2">
            {options.map((to) => (
              <button
                key={to}
                type="button"
                data-status={to}
                disabled={move.isPending}
                onClick={() => move.mutate(to)}
                className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-4 py-3 text-start text-sm font-medium transition-colors disabled:opacity-50 ${
                  to === 'CANCELLED'
                    ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
                    : 'border-primary-200 text-primary-700 hover:bg-primary-50'
                }`}
              >
                {codeLabel('cycleStatus', to)}
                {move.isPending && move.variables === to && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          {refusal && (
            <div
              role="alert"
              data-testid="status-refusal"
              className="space-y-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <p>{refusal.message}</p>
              {fix && (
                <button
                  type="button"
                  data-testid="status-fix"
                  data-fix={fix}
                  onClick={startFix}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
                >
                  {fix === 'departure' ? (
                    <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                  ) : (
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  )}
                  {fix === 'departure' ? ts('recordDeparture') : ts('recordDelivery')}
                </button>
              )}
            </div>
          )}
          {fixSaved && (
            <p role="status" data-testid="status-fix-saved" className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
              {t('statusFixSaved')}
            </p>
          )}
        </Dialog>
      )}

      {/* The fix dialogs are the ones the Shipping card opens; they portal to <body>. */}
      {fixing?.kind === 'departure' && fixingLeg && (
        <RecordDepartureDialog
          leg={fixingLeg}
          productNames={productNames}
          onSaved={(res) => endFix(true, res)}
          onClose={() => endFix(false)}
        />
      )}
      {fixing?.kind === 'delivery' && fixingLeg && (
        <RecordDeliveryDialog
          leg={fixingLeg}
          productNames={productNames}
          onSaved={(res) => endFix(true, res)}
          onClose={() => endFix(false)}
        />
      )}
    </>
  );
}
