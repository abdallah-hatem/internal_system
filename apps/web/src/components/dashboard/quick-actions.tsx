'use client';

import { useTranslations } from 'next-intl';
import { Banknote, Plus, Ship } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { quickActionsFor, type QuickActionKey } from './dashboard-model';

const ICONS: Record<QuickActionKey, typeof Plus> = {
  newSale: Plus,
  recordPayment: Banknote,
  newCycle: Ship,
};

/**
 * The three things done most from the dashboard. Each one is a link to the
 * list that already owns the form, which opens it on arrival — the form is
 * never copied here. A role the API would refuse does not see the button.
 */
export function QuickActions({ role }: { role: string | undefined }) {
  const t = useTranslations('dashboard');
  const actions = quickActionsFor(role);
  if (actions.length === 0) return null;

  return (
    <nav aria-label={t('quickActions')} className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
      {actions.map((action, i) => {
        const Icon = ICONS[action.key];
        return (
          <Link
            key={action.key}
            href={action.href}
            data-testid={`quick-action-${action.key}`}
            className={`inline-flex min-h-11 cursor-pointer touch-manipulation select-none items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors active:scale-[0.98] ${
              i === 0
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border border-border bg-card text-card-foreground hover:bg-muted'
            }`}
          >
            <Icon aria-hidden="true" className="size-4" />
            {t(`actions.${action.key}`)}
          </Link>
        );
      })}
    </nav>
  );
}
