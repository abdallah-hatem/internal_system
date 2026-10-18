'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, HandCoins, Loader2, PencilLine, Scale } from 'lucide-react';
import { Money } from '@/components/ui/money';

/**
 * "Funding not entered yet" on a cycle's page (BUSINESS_LOGIC §8, owner
 * 2026-10-18).
 *
 * The wizard used to end on a Funding step. It ends at the shipping now and
 * lands here, so this is where the funding is asked for — and only while it
 * matters: while settling the cycle would be refused for want of a basis to
 * split its profit on (`CYCLE_NOT_FUNDED`). That is the server's reading,
 * `profitBasis` on the landed-cost totals (`profitBasisOf` in
 * settlement-math.ts, the very function the settlement runs), never a second
 * guess made here: `NONE` shows the note, anything else hides it.
 *
 * Nothing for a closed or cancelled cycle, or one whose funding is locked —
 * the actions could not change anything there.
 */

export interface FundingTotals {
  profitBasis?: 'CUSTOM_SPLIT' | 'CONTRIBUTIONS' | 'LENDERS' | 'NONE';
  lenderFinancedEgp?: string | number;
  cycleCostEgp?: string | number;
  landedEgp?: string | number;
  transferredInEgp?: string | number;
  toFundEgp?: string | number;
}

const num = (v: unknown) => Number(v ?? 0);

/** Whether the note shows: settling would be refused for want of funding. */
export function fundingNeeded(
  cycle: { status?: string; fundingLock?: string | null } | undefined,
  totals: FundingTotals | undefined,
): boolean {
  if (!cycle || !totals) return false;
  if (cycle.status === 'CLOSED' || cycle.status === 'CANCELLED') return false;
  if (cycle.fundingLock) return false;
  return totals.profitBasis === 'NONE';
}

export function FundingNote({
  cycle,
  totals,
  canSplit,
  splitting,
  canEdit,
  canFinance,
  onSplit,
  onEnterAmounts,
  onPaidByLender,
}: {
  cycle: { status?: string; fundingLock?: string | null } | undefined;
  totals: FundingTotals | undefined;
  /** Something to split: core partners on it and a cost to fund. */
  canSplit: boolean;
  splitting: boolean;
  /** May edit contributions (Split equally, Enter amounts). */
  canEdit: boolean;
  /** May record a friend's payment: the cycle has an order to pay. */
  canFinance: boolean;
  onSplit: () => void;
  onEnterAmounts: () => void;
  onPaidByLender: () => void;
}) {
  const t = useTranslations('cycles');
  if (!fundingNeeded(cycle, totals)) return null;

  const paid = num(totals!.lenderFinancedEgp);
  // What friends and partners fund between them: the cycle's cost, plus
  // leftovers moved in (§8, L5) — the costing's own figures.
  const cost = num(totals!.cycleCostEgp ?? totals!.landedEgp) + num(totals!.transferredInEgp);

  return (
    <div
      role="status"
      data-testid="funding-note"
      className="rounded-xl border border-accent-200 bg-accent-50 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-accent-600" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <p data-testid="funding-note-title" className="text-sm font-semibold text-accent-900">
              {paid > 0
                ? t.rich('fundingNotePartial', {
                    paid: () => <Money value={paid} />,
                    cost: () => <Money value={cost} />,
                  })
                : t('fundingNoteTitle')}
            </p>
            {paid <= 0 && (
              <p className="text-xs text-accent-800">{t('fundingNoteHint')}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={onSplit}
                disabled={!canSplit || splitting}
                data-testid="funding-note-split"
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-accent-700 disabled:opacity-50 touch-manipulation"
              >
                {splitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Scale className="h-3.5 w-3.5" />
                )}
                {t('splitEqually')}
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={onEnterAmounts}
                data-testid="funding-note-enter"
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent-300 bg-card px-3 py-1.5 text-xs font-medium text-accent-900 hover:bg-accent-100 touch-manipulation"
              >
                <PencilLine className="h-3.5 w-3.5" /> {t('fundingEnterAmounts')}
              </button>
            )}
            {canFinance && (
              <button
                type="button"
                onClick={onPaidByLender}
                data-testid="funding-note-lender"
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent-300 bg-card px-3 py-1.5 text-xs font-medium text-accent-900 hover:bg-accent-100 touch-manipulation"
              >
                <HandCoins className="h-3.5 w-3.5" /> {t('fundingPaidByLender')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
