'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, type IconComponent } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export interface ChoiceCard {
  value: string;
  /** What the choice is called: "China", "USD". */
  label: string;
  /** A line under it: the route, a rate. */
  description?: ReactNode;
  icon?: IconComponent;
  /** Drawn instead of an icon — a currency's symbol, say. */
  mark?: ReactNode;
}

/**
 * A few choices shown as cards, one picked (owner 2026-10-24: the cycle
 * wizard's origin and currency, "easier and looks better" than dropdowns).
 *
 * Underneath it is a radio group of real radio buttons, so the keyboard
 * (Tab into the group, arrows between cards), a screen reader ("radio, 1 of
 * 2, checked"), `required` and the form's own `FormData` all work as they do
 * for any radio — the cards are only their labels. Logical properties only, so
 * Arabic mirrors.
 */
export function ChoiceCards({
  name,
  legend,
  options,
  value,
  onChange,
  required,
  columns = 'sm:grid-cols-2',
  className,
}: {
  name: string;
  /** The question, read out for the group ("Origin"). */
  legend: ReactNode;
  options: readonly ChoiceCard[];
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** Grid columns from sm up, written whole for Tailwind. A phone stacks them unless a class says otherwise. */
  columns?: string;
  className?: string;
}) {
  const id = useId();
  const t = useTranslations('common');
  // Asked to save with nothing picked: say so under the cards, as the shared
  // Select does, until a card is picked.
  const [invalid, setInvalid] = useState(false);
  return (
    <fieldset className={cn('min-w-0', className)} data-testid={`choice-${name}`}>
      <legend id={`${id}-legend`} className="mb-2 block text-sm font-medium text-foreground">
        {legend}
      </legend>
      <div role="radiogroup" aria-labelledby={`${id}-legend`} className={cn('grid grid-cols-1 gap-3', columns)}>
        {options.map((o) => {
          const checked = value === o.value;
          const Icon = o.icon;
          const inputId = `${id}-${o.value}`;
          return (
            <label
              key={o.value}
              htmlFor={inputId}
              data-testid="choice-card"
              data-value={o.value}
              data-checked={checked}
              className={cn(
                'relative flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 text-start transition-colors sm:p-4',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
                checked ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40 hover:bg-muted/40',
                invalid && 'border-destructive',
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                required={required}
                onChange={() => {
                  setInvalid(false);
                  onChange(o.value);
                }}
                onInvalid={() => setInvalid(true)}
                className="peer sr-only"
              />
              {(Icon || o.mark) && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold',
                    checked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {Icon ? <Icon className="size-5" /> : o.mark}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-foreground">{o.label}</span>
                {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
              </span>
              <CheckCircle
                className={cn('size-5 shrink-0 text-primary transition-opacity', checked ? 'opacity-100' : 'opacity-0')}
              />
            </label>
          );
        })}
      </div>
      {invalid && (
        <p role="alert" data-slot="choice-error" className="mt-1 text-xs text-destructive">
          {t('required')}
        </p>
      )}
    </fieldset>
  );
}
