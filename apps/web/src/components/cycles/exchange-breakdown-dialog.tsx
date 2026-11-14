'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { Money } from '@/components/ui/money';
import { Dialog, DialogCancel } from '@/components/ui/dialog';
import { EXCHANGE_TONE, ExchangeAmount, exchangeResult } from '@/components/lenders/exchange-result';
import { cn } from '@/lib/utils';

/**
 * Why the Funding card's exchange difference is what it is (owner
 * 2026-11-14: the line "must explain WHY"). The server's breakdown
 * (`common/lender-debt.ts` `exchangeBreakdown`) — the same standing
 * repayments the card's figure sums, so the rows add up to it exactly; this
 * only lays them out: per friend's payment, one sentence of how it works,
 * then each repayment with its rate against his.
 */
export interface ExchangeBreakdown {
  financingId: string;
  lender: string;
  currency: string;
  amount: string;
  fxRateToEgp: string;
  amountEgp: string;
  paidOn: string;
  repaidEgp: string;
  exchangeDifferenceEgp: string;
  repayments: {
    id: string;
    paidOn: string;
    amountEgp: string;
    rateToEgp: string;
    cleared: string;
    exchangeDifferenceEgp: string;
  }[];
}

const num = (v: unknown) => Number(v ?? 0);

export function ExchangeBreakdownDialog({
  friends,
  totalEgp,
  breakdown,
  onClose,
}: {
  /** The friends' names, as the card's line says them. */
  friends: string;
  /** The card's figure: + a cost, − a gain. */
  totalEgp: string;
  breakdown: ExchangeBreakdown[];
  onClose: () => void;
}) {
  const t = useTranslations('fundingCard.exchangeDetails');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  // A rate as entered, at least two places: 15.2 reads 15.20, 15.0443 stays.
  const rate = (v: string) => <bdi dir="ltr">{formatNumber(num(v), { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</bdi>;

  return (
    <Dialog
      size="xl"
      data-testid="exchange-breakdown"
      title={t('title', { friends })}
      onClose={onClose}
      footer={<DialogCancel onClick={onClose} label={tc('close')} />}
    >
      <div className="space-y-5 py-1">
        {breakdown.map((f) => (
          <section key={f.financingId} data-testid="exchange-financing" className="space-y-3">
            <p data-testid="exchange-explain" className="text-sm text-muted-foreground">
              {t.rich('explain', {
                lender: () => <bdi className="font-medium text-foreground">{f.lender}</bdi>,
                foreign: () => <Money value={f.amount} currency={f.currency} className="text-foreground" />,
                rate: () => rate(f.fxRateToEgp),
                cost: () => <Money value={f.amountEgp} className="text-foreground" />,
                pounds: () => <Money value={f.repaidEgp} className="text-foreground" />,
                currency: f.currency,
              })}
            </p>
            <div className="divide-y divide-border text-sm">
              <div
                aria-hidden="true"
                className="hidden grid-cols-[6.5rem_minmax(0,1fr)_5rem_minmax(0,1fr)_minmax(0,1.6fr)] gap-3 py-1.5 text-xs text-muted-foreground sm:grid"
              >
                <span>{t('colDate')}</span>
                <span className="text-end">{t('colPaid')}</span>
                <span className="text-end">{t('colRate')}</span>
                <span className="text-end">{t('colCleared')}</span>
                <span className="text-end">{t('colDiff')}</span>
              </div>
              {f.repayments.map((r) => {
                const diff = num(r.exchangeDifferenceEgp);
                const values = {
                  // Unsigned: the words say gained or lost; the colour is the card's.
                  amount: () => (
                    <Money value={Math.abs(diff)} className={cn('font-medium', EXCHANGE_TONE[exchangeResult(diff)])} />
                  ),
                  rate: () => rate(r.rateToEgp),
                  his: () => rate(f.fxRateToEgp),
                };
                return (
                  <div
                    key={r.id}
                    data-testid="exchange-row"
                    data-result={diff < 0 ? 'gain' : diff > 0 ? 'loss' : 'none'}
                    className="grid grid-cols-2 gap-x-3 gap-y-0.5 py-2 sm:grid-cols-[6.5rem_minmax(0,1fr)_5rem_minmax(0,1fr)_minmax(0,1.6fr)] sm:items-baseline"
                  >
                    <span className="text-xs text-muted-foreground tabular-nums sm:text-sm">{formatDate(r.paidOn)}</span>
                    <Money value={r.amountEgp} className="text-end tabular-nums text-foreground" />
                    <span className="text-xs text-muted-foreground tabular-nums sm:text-end sm:text-sm sm:text-foreground">
                      <span className="sm:hidden">{t('colRate')} </span>
                      {rate(r.rateToEgp)}
                    </span>
                    <span className="text-end text-xs text-muted-foreground tabular-nums sm:text-sm sm:text-foreground">
                      <span className="sm:hidden">{t('colCleared')} </span>
                      <Money value={r.cleared} currency={f.currency} />
                    </span>
                    <span data-testid="exchange-row-diff" className="col-span-2 text-xs text-muted-foreground sm:col-span-1 sm:text-end">
                      {t.rich(diff < 0 ? 'gain' : diff > 0 ? 'loss' : 'none', values)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <div
          data-testid="exchange-total"
          className="flex items-baseline justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-sm font-semibold text-foreground"
        >
          <span>{t('total')}</span>
          <ExchangeAmount diffEgp={totalEgp} />
        </div>
      </div>
    </Dialog>
  );
}
