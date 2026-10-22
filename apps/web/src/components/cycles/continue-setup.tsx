'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight } from '@/components/ui/icons';
import { useCan } from '@/lib/can';
import { WIZARD_STATUSES } from './wizard-walk';

/**
 * The way back into the wizard for a cycle still being set up.
 *
 * Opening a cycle used to mean the wizard whenever the cycle was still in one
 * of the wizard's statuses, and the only road from there to the cycle's own
 * page was to walk to the last step and press Finish (owner, 2026-10-11).
 * Now a row or card always opens the details page, and resuming setup is this
 * separate, named action — on the row, on the card, and in the details header.
 *
 * Offered only to a role that may write the cycle (`cycle.create`, the same
 * permission `WizardGate` checks), and only while the wizard still has
 * something to do: `WIZARD_STATUSES`, the list's resume rule since F1b.
 */
export function canContinueSetup(status: string | undefined, allowed: boolean): boolean {
  return allowed && !!status && WIZARD_STATUSES.includes(status);
}

export function ContinueSetupLink({
  cycleId,
  status,
  className,
}: {
  cycleId: string;
  status: string | undefined;
  className?: string;
}) {
  const t = useTranslations('cycles');
  const locale = useLocale();
  const allowed = useCan('cycle.create');
  if (!canContinueSetup(status, allowed)) return null;

  return (
    <Link
      href={`/${locale}/cycles/${cycleId}`}
      data-testid="continue-setup"
      // The row and the card it sits in open the details page on click; this
      // goes to the wizard instead and must not trigger that too.
      onClick={(e) => e.stopPropagation()}
      className={
        className ??
        'inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm font-medium whitespace-nowrap text-primary-700 transition-colors hover:bg-primary-100 touch-manipulation'
      }
    >
      {t('continueSetup')} <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
    </Link>
  );
}
