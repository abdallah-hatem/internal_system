'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiError } from '@/lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { useToast } from '@/components/ui/toast';

/**
 * L3 — what recording a departure or a delivery did to the cycle's status
 * (BUSINESS_LOGIC §1, owner 2026-10-11).
 *
 * The API moves the cycle on by itself and says so beside the record, as
 * `cycleStatus` (`CyclesService.followShipment`). Every place that records one
 * — the Record departure and Record delivery dialogs, the Shipments page, the
 * wizard, receiving into stock — shows it in the same success toast, so the
 * sentence is written once here.
 */
export interface CycleStatusMove {
  cycleId: string;
  from: string;
  to: string;
  moved: boolean;
  steps: string[];
  /** The step whose own check refused; the record still saved. */
  stoppedAt: {
    status: string;
    code: string;
    message: string;
    params?: Record<string, string | number>;
  } | null;
  ordersConfirmed: string[];
}

/** The `cycleStatus` beside a record in an axios response, when there is one. */
export function statusMoveOf(res: unknown): CycleStatusMove | null {
  const body = (res as { data?: { cycleStatus?: CycleStatusMove | null } } | undefined)?.data;
  return body?.cycleStatus ?? null;
}

/**
 * `announce(done, res)` toasts "Delivery recorded — cycle is now Arrived Egypt"
 * when the record moved the cycle, plain `done` when it did not, and — when a
 * step's own check stopped the walk — a warning naming the status it stayed at
 * and the reason, translated like any refusal.
 */
export function useAnnounceStatusMove() {
  const t = useTranslations('shipment');
  const toast = useToast();
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  return useCallback(
    (done: string, res: unknown) => {
      const move = statusMoveOf(res);
      toast.success(
        move?.moved ? t('cycleMovedTo', { done, status: codeLabel('cycleStatus', move.to) }) : done,
      );
      if (move?.stoppedAt) {
        const { code, message, params } = move.stoppedAt;
        toast.warning(
          t('cycleStayed', {
            status: codeLabel('cycleStatus', move.to),
            reason: apiError({ response: { data: { error: { code, message, params } } } }, message),
          }),
        );
      }
    },
    [t, toast, codeLabel, apiError],
  );
}
