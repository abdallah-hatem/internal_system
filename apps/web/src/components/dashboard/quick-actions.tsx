'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banknote, Fuel, Plus, Ship, Zap } from 'lucide-react';
import { LedgerEntryDialog } from '@/components/ledger/LedgerEntryDialog';
import { Link } from '@/i18n/navigation';
import { quickActionsFor, type QuickActionKey } from './dashboard-model';

const ICONS: Record<QuickActionKey, typeof Plus> = {
  newSale: Plus,
  recordPayment: Banknote,
  newCycle: Ship,
  recordFuel: Fuel,
};

/** The quick-action tile's look — the first action is filled, the rest outlined. */
function quickActionClass(primary: boolean): string {
  return `inline-flex min-h-11 cursor-pointer touch-manipulation select-none items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors active:scale-[0.98] ${
    primary
      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
      : 'border border-border bg-card text-card-foreground hover:bg-muted'
  }`;
}

/**
 * Fuel: opens the ledger's own form in place, on Expense → Fuel (BUSINESS_LOGIC
 * §9, 2026-10-17). One button, used by the dashboard and the ledger page alike;
 * the form saves and refreshes the ledger and the figures it moves itself.
 */
function FuelQuickAction({ primary = false }: { primary?: boolean }) {
  const t = useTranslations('dashboard');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="quick-action-recordFuel"
        onClick={() => setOpen(true)}
        className={quickActionClass(primary)}
      >
        <Fuel aria-hidden="true" className="size-4" />
        {t('actions.recordFuel')}
      </button>
      <LedgerEntryDialog open={open} presetCategory="fuel" onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * The things done most from the dashboard. Each one is a link to the list that
 * already owns the form, which opens it on arrival — the form is never copied
 * here. Fuel is the exception: it opens the ledger's own form in place, so a
 * fill-up is recorded without leaving the dashboard. A role the API would
 * refuse does not see the button.
 */
export function QuickActions({ role }: { role: string | undefined }) {
  const t = useTranslations('dashboard');
  const actions = quickActionsFor(role);
  if (actions.length === 0) return null;

  return (
    <nav aria-label={t('quickActions')} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {actions.map((action, i) => {
        if (!action.href) return <FuelQuickAction key={action.key} primary={i === 0} />;
        const Icon = ICONS[action.key];
        return (
          <Link
            key={action.key}
            href={action.href}
            data-testid={`quick-action-${action.key}`}
            className={quickActionClass(i === 0)}
          >
            <Icon aria-hidden="true" className="size-4" />
            {t(`actions.${action.key}`)}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The ledger page's quick actions (owner 2026-10-18: the Fuel button on the
 * ledger too, "as a quick action button, not like an ordinary one like add or
 * export"). The same Fuel tile as the dashboard, set apart from the page's
 * toolbar in its own labelled strip under the title. The roles are the
 * dashboard's (`quickActionsFor`), so a role that could not save sees nothing.
 */
export function LedgerQuickActions({ role }: { role: string | undefined }) {
  const t = useTranslations('dashboard');
  if (!quickActionsFor(role).some((a) => a.key === 'recordFuel')) return null;
  return (
    <nav
      aria-label={t('quickActions')}
      data-testid="ledger-quick-actions"
      className="mt-3 inline-flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/60 p-1.5 ps-3"
    >
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Zap aria-hidden="true" className="size-3.5 text-primary" />
        {t('quickActions')}
      </span>
      <FuelQuickAction />
    </nav>
  );
}
