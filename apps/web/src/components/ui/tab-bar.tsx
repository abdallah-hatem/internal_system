'use client';

import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface TabBarTab<K extends string> {
  key: K;
  label: string;
}

/**
 * A horizontal row of tabs over a page's views (Payments | Instalment plans,
 * owner 2026-10-16). It only draws and reports: which tab is open is the
 * page's to keep — in the URL, so a refresh or the back button returns to it.
 *
 * Arrow keys move between tabs in reading order, so in Arabic the left arrow
 * goes forward; Home and End jump to the ends.
 */
export function TabBar<K extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: readonly TabBarTab<K>[];
  value: K;
  onChange: (key: K) => void;
  /** What the views are, for a screen reader. */
  label: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const step =
      e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    let next = index + step;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (!step) return;
    e.preventDefault();
    next = (next + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    onChange(tabs[next].key);
  };

  return (
    <div role="tablist" aria-label={label} className={cn('scrollbar-clean flex gap-1 overflow-x-auto border-b border-border', className)}>
      {tabs.map((tab, i) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.key}`}
            data-testid={`tab-${tab.key}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              selected
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
