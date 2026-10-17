'use client';

import { cn } from '@/lib/utils';

/**
 * A small switch between a few views of the same thing — revenue or units,
 * say. One button per option inside a radiogroup, so a keyboard and a screen
 * reader see one choice, not unrelated buttons. Every button states its type:
 * a switch inside a form must never submit it (CLAUDE.md §13).
 */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  className,
}: {
  /** What is being chosen, for a screen reader. */
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className={cn('inline-flex shrink-0 overflow-hidden rounded-lg border border-border text-xs font-medium', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-9 cursor-pointer px-3 py-1 transition-colors sm:min-h-0',
              on ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
