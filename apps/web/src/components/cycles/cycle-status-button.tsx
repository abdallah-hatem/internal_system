'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { nextStatuses } from '@/lib/cycle-transitions';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

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
 * words are shown.
 */
export function canChangeStatus(status: string | undefined, allowed: boolean): boolean {
  return allowed && nextStatuses(status).length > 0;
}

export function CycleStatusButton({ cycleId, status }: { cycleId: string; status: string | undefined }) {
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const allowed = useCan('cycle.transition');
  const [open, setOpen] = useState(false);

  const move = useMutation({
    mutationFn: (to: string) => api.post(`/cycles/${cycleId}/transition`, { status: to }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cycles'] });
      void queryClient.invalidateQueries({ queryKey: ['cycle'] });
      void queryClient.invalidateQueries({ queryKey: ['shipment'] });
      setOpen(false);
      addToast(t('statusUpdated'), 'success');
    },
    onError: (error: unknown) => addToast(apiError(error, t('transitionFailed')), 'error'),
  });

  if (!canChangeStatus(status, allowed)) return null;
  const options = nextStatuses(status);

  return (
    <>
      <button
        type="button"
        data-testid="change-status"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted touch-manipulation"
      >
        <ArrowRightLeft className="h-4 w-4" aria-hidden="true" /> {t('transition')}
      </button>

      <Dialog open={open} onOpenChange={(next) => !move.isPending && setOpen(next)}>
        <DialogContent className="sm:max-w-md" data-testid="change-status-dialog">
          <DialogHeader className="text-start sm:text-start">
            <DialogTitle>{t('transition')}</DialogTitle>
            <DialogDescription>
              {t('currentStatus')} {codeLabel('cycleStatus', status ?? '')}
            </DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={move.isPending}
              className="min-h-11 rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
            >
              {tc('cancel')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
