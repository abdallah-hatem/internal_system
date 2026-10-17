'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banknote, Fuel, Plus, Ship } from 'lucide-react';
import { LedgerEntryDialog } from '@/components/ledger/LedgerEntryDialog';
import { Link } from '@/i18n/navigation';
import { quickActionsFor, type QuickActionKey } from './dashboard-model';

const ICONS: Record<QuickActionKey, typeof Plus> = {
  newSale: Plus,
  recordPayment: Banknote,
  newCycle: Ship,
  recordFuel: Fuel,
};

/**
 * The things done most from the dashboard. Each one is a link to the list that
 * already owns the form, which opens it on arrival — the form is never copied
 * here. Fuel is the exception: it opens the ledger's own form in place, on
 * Expense → Fuel, so a fill-up is recorded without leaving the dashboard
 * (BUSINESS_LOGIC §9, 2026-10-17). A role the API would refuse does not see
 * the button.
 */
export function QuickActions({ role }: { role: string | undefined }) {
  const t = useTranslations('dashboard');
  const actions = quickActionsFor(role);
  const [fuelOpen, setFuelOpen] = useState(false);
  if (actions.length === 0) return null;

  const style = (i: number) =>
    `inline-flex min-h-11 cursor-pointer touch-manipulation select-none items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors active:scale-[0.98] ${
      i === 0
        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
        : 'border border-border bg-card text-card-foreground hover:bg-muted'
    }`;

  return (
    <>
    <nav aria-label={t('quickActions')} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {actions.map((action, i) => {
        const Icon = ICONS[action.key];
        const content = (
          <>
            <Icon aria-hidden="true" className="size-4" />
            {t(`actions.${action.key}`)}
          </>
        );
        return action.href ? (
          <Link key={action.key} href={action.href} data-testid={`quick-action-${action.key}`} className={style(i)}>
            {content}
          </Link>
        ) : (
          <button
            key={action.key}
            type="button"
            data-testid={`quick-action-${action.key}`}
            onClick={() => setFuelOpen(true)}
            className={style(i)}
          >
            {content}
          </button>
        );
      })}
    </nav>
    <LedgerEntryDialog open={fuelOpen} presetCategory="fuel" onClose={() => setFuelOpen(false)} />
    </>
  );
}
