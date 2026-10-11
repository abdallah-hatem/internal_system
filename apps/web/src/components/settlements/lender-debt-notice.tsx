'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { Money } from '@/components/ui/money';
import { LenderLink } from '@/components/ui/entity-link';

/**
 * A cycle cannot be settled while it still owes a friend who paid a supplier
 * (BUSINESS_LOGIC §18). The approve refusal says so too; this shows it before
 * anyone presses, with who is owed and how much, each linked to his page.
 * Nothing renders when nobody is owed.
 */
export function LenderDebtNotice({ cycleId }: { cycleId: string }) {
  const t = useTranslations('settlementsPage');
  const { data } = useQuery<{ owed: { lenderId: string; lender: string; currency: string; owed: string }[] }>({
    queryKey: ['financing', 'cycle', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/financing`).then((r) => r.data.data ?? r.data),
  });
  const owed = data?.owed ?? [];
  if (owed.length === 0) return null;
  return (
    <div data-testid="lender-debt-notice" className="space-y-1.5 border-b border-accent-100 bg-accent-50 px-4 py-3 sm:px-5">
      <p className="flex items-center gap-2 text-sm font-medium text-accent-800">
        <AlertTriangle className="h-4 w-4 shrink-0" /> {t('lenderOwedTitle')}
      </p>
      <ul className="space-y-0.5 ps-6 text-sm text-accent-900">
        {owed.map((o) => (
          <li key={`${o.lenderId}:${o.currency}`} className="flex flex-wrap items-center gap-x-2">
            <LenderLink id={o.lenderId} name={o.lender} className="font-medium" />
            <Money value={o.owed} currency={o.currency} className="font-semibold" />
          </li>
        ))}
      </ul>
      <p className="ps-6 text-xs text-accent-700">{t('lenderOwedHint')}</p>
    </div>
  );
}
