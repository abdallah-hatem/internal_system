'use client';

import { useTranslations } from 'next-intl';
import { Money } from '@/components/ui/money';
import { useCodeLabel } from '@/lib/labels';

/**
 * A payout explains itself (BUSINESS_LOGIC §8, owner 2026-10-11; built L7).
 *
 * The settlement card used to show one "Expenses" figure. This lays the same
 * money out line by line — the cycle's revenue, the cost of the goods, each
 * cost by kind, its profit; then for each participant his share, the
 * investor's fee, capital back, his share of the running costs and what he is
 * paid. Every figure comes from the API (`breakdown` on a settlement, read from
 * the settlement's own projection); nothing is worked out here, so it cannot
 * disagree with what was paid.
 *
 * Each money line carries `data-amount` (signed, as it moves the total) and the
 * total `data-total`, so a test can check the lines add up to what they sit
 * over — which is the promise the screen makes.
 */

export interface CycleCostLine {
  kind: 'charge' | 'loss' | 'exchange' | 'recovery' | 'otherIncome';
  category: string | null;
  amountEgp: string;
}

export interface ParticipantPayout {
  participantId: string;
  type: string;
  sharePct: string | null;
  profitShareEgp: string;
  investorFeeEgp: string;
  feeReceivedEgp: string;
  capitalBackEgp: string;
  runningCostsEgp: string;
  runningCostsFrom: string | null;
  runningCostsTo: string | null;
  runningCostsStatus: 'charged' | 'projected' | 'released' | 'none';
  paidEgp: string;
}

export interface PayoutBreakdown {
  revenueEgp: string;
  cogsEgp: string;
  costs: CycleCostLine[] | null;
  expensesEgp: string;
  cycleProfitEgp: string;
  leftoversMovedEgp: string;
  participants: ParticipantPayout[];
}

const num = (v: string | number) => Number(v);
/**
 * A date inside a translated sentence, kept left-to-right: in Arabic the bidi
 * algorithm otherwise splits "(2026-10-12)" into "(2026-" and "12-10)".
 */
const ltr = (day: string) => `\u2066${day}\u2069`;

function Line({
  label,
  amount,
  note,
}: {
  label: string;
  amount: number;
  note?: string;
}) {
  return (
    <div data-line data-amount={amount} className="flex items-baseline justify-between gap-3 py-1">
      <dt className="min-w-0 text-muted-foreground">
        <span data-label>{label}</span>
        {note && <span className="ms-2 text-[11px] text-muted-foreground">{note}</span>}
      </dt>
      <dd className="shrink-0 whitespace-nowrap tabular-nums text-foreground">
        <Money value={amount} />
      </dd>
    </div>
  );
}

function Total({ label, amount, tone }: { label: string; amount: number; tone?: 'profit' }) {
  const color =
    tone === 'profit' ? (amount >= 0 ? 'text-success' : 'text-destructive') : 'text-foreground';
  return (
    <div
      data-total
      data-amount={amount}
      className="mt-1 flex items-baseline justify-between gap-3 border-t border-border pt-2 font-semibold"
    >
      <dt className="min-w-0 text-foreground">
        <span data-label>{label}</span>
      </dt>
      <dd className={`shrink-0 whitespace-nowrap tabular-nums ${color}`}>
        <Money value={amount} />
      </dd>
    </div>
  );
}

export function PayoutBreakdownView({
  breakdown: b,
  status,
  names,
  showCycle = true,
}: {
  breakdown: PayoutBreakdown;
  status: string;
  /** participantId → the name to head his lines with. */
  names: Record<string, string>;
  showCycle?: boolean;
}) {
  const t = useTranslations('settlementsPage');
  const codeLabel = useCodeLabel();
  const open = status === 'DRAFT' || status === 'APPROVED';

  const costLabel = (c: CycleCostLine) => {
    const category = codeLabel('ledgerCategory', c.category);
    switch (c.kind) {
      case 'loss':
        return t('costLoss');
      case 'exchange':
        return t('costExchange');
      case 'recovery':
        return t('costRecovery', { category });
      case 'otherIncome':
        return t('costOtherIncome', { category });
      default:
        return category;
    }
  };

  return (
    <section data-testid="payout-breakdown" className="space-y-4 px-4 py-4 text-sm sm:px-5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('howWorkedOut')}
      </h3>

      {showCycle && (
        <div className="rounded-lg border border-border p-3">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('cycleLines')}</h4>
          <dl data-testid="breakdown-cycle">
            <Line label={t('revenue')} amount={num(b.revenueEgp)} />
            <Line label={t('cogsLine')} amount={-num(b.cogsEgp)} />
            {b.costs === null ? (
              <Line label={t('costsNotItemised')} amount={-num(b.expensesEgp)} />
            ) : b.costs.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">{t('noCycleCosts')}</p>
            ) : (
              b.costs.map((c, i) => (
                <Line key={`${c.kind}-${c.category ?? i}`} label={costLabel(c)} amount={-num(c.amountEgp)} />
              ))
            )}
            <Total label={t('cycleProfit')} amount={num(b.cycleProfitEgp)} tone="profit" />
          </dl>
          {num(b.leftoversMovedEgp) !== 0 && (
            <p data-testid="breakdown-leftovers" className="mt-2 flex justify-between gap-3 text-xs text-muted-foreground">
              <span>{t('leftoversMoved')}</span>
              <span className="whitespace-nowrap tabular-nums">
                <Money value={b.leftoversMovedEgp} />
              </span>
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {b.participants.map((p) => {
          const pct = p.sharePct;
          const running = num(p.runningCostsEgp);
          return (
            <div key={p.participantId} className="rounded-lg border border-border p-3">
              <h4 className="mb-1 font-medium text-foreground">
                <bdi>{names[p.participantId] ?? t('unknownParticipant')}</bdi>
              </h4>
              <dl data-testid={`breakdown-${p.participantId}`}>
                <Line
                  label={pct === null ? t('shareOfProfit') : t('shareOfProfitPct', { pct })}
                  amount={num(p.profitShareEgp)}
                />
                {num(p.investorFeeEgp) !== 0 && (
                  <Line label={t('investorFeeTaken')} amount={num(p.investorFeeEgp)} />
                )}
                {num(p.feeReceivedEgp) !== 0 && (
                  <Line label={t('investorFeeReceived')} amount={num(p.feeReceivedEgp)} />
                )}
                <Line label={t('capitalBack')} amount={num(p.capitalBackEgp)} />
                {p.runningCostsStatus !== 'none' && (
                  <Line
                    label={
                      p.runningCostsFrom && p.runningCostsTo
                        ? p.runningCostsFrom === p.runningCostsTo
                          ? t('runningCostsDay', { day: ltr(p.runningCostsFrom) })
                          : t('runningCostsPeriod', { from: ltr(p.runningCostsFrom), to: ltr(p.runningCostsTo) })
                        : t('runningCostsLine')
                    }
                    amount={running}
                    note={
                      p.runningCostsStatus === 'projected'
                        ? t('runningCostsProjected')
                        : p.runningCostsStatus === 'released'
                          ? t('runningCostsReleased')
                          : undefined
                    }
                  />
                )}
                <Total label={open ? t('wouldBePaid') : t('paidToHim')} amount={num(p.paidEgp)} />
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}
