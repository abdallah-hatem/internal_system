'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Money } from '@/components/ui/money';
import { useDateFormat } from '@/lib/dates';
import {
  PayoutBreakdownView,
  type PayoutBreakdown,
} from '@/components/settlements/payout-breakdown';

/**
 * One person's payouts, each able to explain itself (§8 "a payout explains
 * itself", L7). The breakdown is the settlement's own — the API sends the very
 * lines the settlement screen shows, limited to this person's.
 */

export interface PartnerPayout {
  settlementId: string;
  cycleId: string;
  cycleCode: string;
  paidAt: string | null;
  breakdown: PayoutBreakdown;
}

export function PayoutHistory({ payouts, name }: { payouts: PartnerPayout[]; name: string }) {
  const t = useTranslations('partners');
  const { formatDate } = useDateFormat();
  const [open, setOpen] = useState<string | null>(null);

  if (payouts.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">{t('noPayouts')}</p>;
  }

  return (
    <ul data-testid="payout-history" className="space-y-1">
      {payouts.map((p) => {
        const paid = p.breakdown.participants.reduce((s, l) => s + Number(l.paidEgp), 0);
        const expanded = open === p.settlementId;
        const panelId = `payout-${p.settlementId}`;
        return (
          <li key={p.settlementId} data-settlement={p.settlementId} className="rounded-lg border border-border text-xs">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              title={t('showBreakdown')}
              onClick={() => setOpen(expanded ? null : p.settlementId)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span dir="ltr" className="font-mono text-primary">{p.cycleCode}</span>
                {p.paidAt && (
                  <span className="text-muted-foreground">{t('paidOn', { date: formatDate(p.paidAt) })}</span>
                )}
              </span>
              <span className="flex items-center gap-1 whitespace-nowrap font-semibold tabular-nums text-foreground">
                <Money value={paid} />
                <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </span>
            </button>
            {expanded && (
              <div id={panelId}>
                <PayoutBreakdownView
                  breakdown={p.breakdown}
                  status="PAID"
                  names={Object.fromEntries(p.breakdown.participants.map((l) => [l.participantId, name]))}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
