'use client';

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The search box every office list puts above its rows.
 *
 * One definition, because there were sixteen: Products wrapped its search in a
 * white card with the filters under it, Suppliers had a bare box, Ledger a row
 * of pickers beside it, Sales stacked a date range and pills underneath — the
 * same action drawn four ways (owner, 2026-10-18: "why products tab is the only
 * tab with different search bar and filters ui?").
 *
 * A plain `type="text"` input on the field background from globals.css, the
 * glass at the start edge (logical `start-3` / `ps-10`, so it moves to the right
 * in Arabic). The placeholder names it for a screen reader too.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  id,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** For a screen reader; the placeholder when not given. */
  label?: string;
  id?: string;
  className?: string;
}) {
  return (
    <div data-slot="search-field" className={cn('relative w-full', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        id={id}
        type="text"
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-input py-2 pe-4 ps-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
    </div>
  );
}

/**
 * The line above a list: the search, then whatever narrows the list further —
 * pickers, a date range, status pills, a button that acts on the list.
 *
 *   <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }}>
 *     <Select className="w-full sm:w-56" … />
 *     <FilterPills … />
 *   </ListToolbar>
 *
 * Straight on the page, never in a card of its own. On a desktop it is one row:
 * the search up to 28rem wide and the filters after it, wrapping to a second
 * row only when they do not fit. On a phone everything stacks, full width, in
 * the same order. A picker gives its own width (`w-full sm:w-56`), as before.
 *
 * `after` sits under the row — a refusal from the server about the range just
 * picked, say — so it never pushes the filters sideways.
 */
export function ListToolbar({
  search,
  children,
  after,
  className,
}: {
  search: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    label?: string;
    id?: string;
  };
  children?: ReactNode;
  after?: ReactNode;
  className?: string;
}) {
  const row = (
    <div
      data-slot="list-toolbar"
      className={cn('flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center', !after && className)}
    >
      {/* 28rem on every list: filters that do not fit after it wrap to the
          next row rather than squeezing the search narrower on one page than
          on the next. Only a window too narrow for the search alone shrinks it. */}
      <SearchField {...search} className="sm:w-auto sm:min-w-64 sm:shrink sm:grow-0 sm:basis-[28rem]" />
      {children}
    </div>
  );
  if (!after) return row;
  return (
    <div className={cn('space-y-3', className)}>
      {row}
      {after}
    </div>
  );
}

/**
 * Status pills: a few fixed views of a list (All, Draft, Paid…), one chosen.
 *
 * Buttons with `aria-pressed`, the shape these filters always had and the one
 * the flows click by name (`getByRole('button', { name: 'Active' })`). Drawn
 * once here so every list's pills are the same size and colour; each states its
 * type so a pill inside a form never submits it.
 */
export function FilterPills<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  className,
}: {
  /** What the pills choose, for a screen reader. */
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      data-slot="filter-pills"
      className={cn('flex flex-wrap gap-2', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            data-value={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0',
              on
                ? 'border border-primary bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground hover:bg-muted',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
