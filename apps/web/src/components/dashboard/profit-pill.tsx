import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/lib/numbers';
import type { StatTileBadge } from './stat-tile';

/**
 * The profit pill beside a cash tile's title (owner 2026-11-06, option B):
 * "+25,502 profit" in green beside Cash from sales / Collected, "+N profit to
 * come" beside To collect. The figure is the server's
 * (`profitOnCollectedEgp` / `profitToCollectEgp`, api
 * `common/profit-on-collected.ts`), rounded to whole pounds here for the pill
 * only. Nothing when it rounds to zero; a loss shows red, "-N loss", never as
 * zero. Each pill carries the text of its (i) popover (`info`).
 *
 * One builder for the dashboard and Analytics' Sales cash, so the two pills
 * cannot read differently (rule 11).
 */
export function useProfitPill() {
  const t = useTranslations('dashboard');
  const { formatNumber } = useNumberFormat();
  return (profit: number | undefined, kind: 'collected' | 'toCome'): StatTileBadge | undefined => {
    // Half a pound away from zero either way: Math.round alone takes -1,234.5
    // to -1,234 but 1,234.5 to 1,235.
    const n = Number(profit ?? 0);
    const whole = Math.sign(n) * Math.round(Math.abs(n));
    if (!Number.isFinite(whole) || whole === 0) return undefined;
    const loss = whole < 0;
    const amount = `${loss ? '-' : '+'}${formatNumber(Math.abs(whole), { maximumFractionDigits: 0 })}`;
    const key = loss
      ? kind === 'collected' ? 'profitPillLoss' : 'profitPillLossToCome'
      : kind === 'collected' ? 'profitPill' : 'profitPillToCome';
    return {
      label: t.rich(key, {
        amount,
        n: (chunks) => (
          // The figure never breaks, even where the pill's words wrap (S1).
          <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
            {chunks}
          </bdi>
        ),
      }),
      srLabel: t(`${key}Sr`, { amount: formatNumber(Math.abs(whole), { maximumFractionDigits: 0 }) }),
      tone: loss ? 'danger' : 'success',
      // The (i) beside the pill says what the figure is (owner 2026-11-06:
      // "leave as is" but explain it). A loss is the same sum with the other
      // sign, so only the title changes.
      info: {
        buttonLabel: t('profitInfoButton'),
        title: t(
          kind === 'collected'
            ? loss ? 'profitInfoLossCollectedTitle' : 'profitInfoCollectedTitle'
            : loss ? 'profitInfoLossToComeTitle' : 'profitInfoToComeTitle',
        ),
        body: t(kind === 'collected' ? 'profitInfoCollectedBody' : 'profitInfoToComeBody'),
      },
    };
  };
}
