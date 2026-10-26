'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, HandCoins } from '@/components/ui/icons';
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
 *
 * A cycle a friend paid for shows it too while the partners' amounts are
 * zero (owner 2026-10-19, §18): his payment is a loan the partners repay, so
 * the note says who paid and asks how the partners split repaying him —
 * "it looks vague as if we payed nothing". The owner's words for it:
 * "maybe 30,30,40", which Enter amounts takes.
 */

export interface FundingTotals {
  profitBasis?: 'CUSTOM_SPLIT' | 'CONTRIBUTIONS' | 'NONE';
  lenderFinancedEgp?: string | number;
  cycleCostEgp?: string | number;
  landedEgp?: string | number;
  transferredInEgp?: string | number;
  toFundEgp?: string | number;
}

const num = (v: unknown) => Number(v ?? 0);

/** "Ahmad Eraiby and Mohamed Abu Setta" — the friends who paid, as the reader's language joins them. */
export function lenderList(names: string[], locale: string): string {
  const distinct = [...new Set(names.filter(Boolean))];
  if (distinct.length === 0) return '';
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(distinct);
  } catch {
    return distinct.join(', ');
  }
}

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
  lenders = [],
  canFinance,
  onPaidByLender,
}: {
  cycle: { status?: string; fundingLock?: string | null } | undefined;
  totals: FundingTotals | undefined;
  /** The friends who paid towards the cycle, by name — the note says who. */
  lenders?: string[];
  /** May record a friend's payment: the cycle has an order to pay. */
  canFinance: boolean;
  onPaidByLender: () => void;
}) {
  const t = useTranslations('cycles');
  const locale = useLocale();
  if (!fundingNeeded(cycle, totals)) return null;

  const paid = num(totals!.lenderFinancedEgp);
  // What friends and partners fund between them: the cycle's cost, plus
  // leftovers moved in (§8, L5) — the costing's own figures.
  const cost = num(totals!.cycleCostEgp ?? totals!.landedEgp) + num(totals!.transferredInEgp);
  const lenderArgs = {
    lenders: lenderList(lenders, locale) || t('fundingNoteSomeLender'),
    count: Math.max(lenders.length, 1),
  };

  // One line at the top of the Funding card (owner 2026-10-26): the message,
  // and a friend's payment beside it. Split equally and Enter amounts sit in
  // the card's Contributions, just below.
  return (
    <div
      role="status"
      data-testid="funding-note"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
      <p data-testid="funding-note-title" className="min-w-[12rem] flex-1 text-sm font-medium text-accent-900">
        {paid <= 0
          ? t('fundingNoteTitle')
          : paid >= cost
            ? t.rich('fundingNoteLender', { ...lenderArgs, paid: () => <Money value={paid} /> })
            : t.rich('fundingNotePartial', {
                ...lenderArgs,
                paid: () => <Money value={paid} />,
                cost: () => <Money value={cost} />,
              })}
      </p>
      {canFinance && (
        <button
          type="button"
          onClick={onPaidByLender}
          data-testid="funding-note-lender"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-accent-300 bg-card px-3 py-1.5 text-xs font-medium text-accent-900 hover:bg-accent-100 touch-manipulation"
        >
          <HandCoins className="h-3.5 w-3.5" /> {t('fundingPaidByLender')}
        </button>
      )}
    </div>
  );
}
