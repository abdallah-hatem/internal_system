'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft } from 'lucide-react';
import { Link } from '@/i18n/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Start a new cycle for them" (§8, L5) opens the wizard with
 * `?leftoversFrom=<cycle>`. Once the new cycle exists, this offers the way
 * back: the giving cycle's page with Move leftovers open and the new cycle
 * chosen (`?moveTo=`). The cycle is set up in the wizard as any other; the
 * move itself is still the giving cycle's dialog, so there is one form for it.
 *
 * Read from the address once, after it rendered — not `useSearchParams`,
 * which would make the wizard's page wait on a Suspense boundary for a
 * one-off link.
 */
export function LeftoversReturnLink({ cycleId }: { cycleId: string | null }) {
  const t = useTranslations('transfers');
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const value = new URL(window.location.href).searchParams.get('leftoversFrom');
    // Reading the address once, after it rendered: there is nothing to sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (value && UUID.test(value)) setFrom(value);
  }, []);

  if (!from || !cycleId || from === cycleId) return null;
  return (
    <div data-testid="leftovers-return" className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      <ArrowRightLeft className="h-4 w-4 shrink-0 text-primary rtl:-scale-x-100" aria-hidden="true" />
      <span className="text-foreground">{t('newCycleReady')}</span>
      <Link
        href={`/cycles/${from}/details?moveTo=${cycleId}`}
        className="ms-auto inline-flex min-h-11 items-center font-medium text-primary hover:underline sm:min-h-0"
      >
        {t('backToMove')}
      </Link>
    </div>
  );
}
