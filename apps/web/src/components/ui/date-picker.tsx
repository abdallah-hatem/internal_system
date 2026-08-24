'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Date helpers — everything stays in LOCAL time.
//
// `new Date('2026-08-20')` parses as UTC midnight, which is the previous day in
// any negative offset, and `toISOString()` shifts the other way. Both are how a
// date picker ends up one day off, so neither is used here.
// ---------------------------------------------------------------------------

/** Local calendar day as `YYYY-MM-DD` — the same wire format `<input type="date">` used. */
export function toISODate(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Accepts `YYYY-MM-DD` or a full ISO timestamp; returns local midnight. */
export function parseISODate(value?: string | null): Date | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a: Date | null, b: Date | null): boolean {
  return (
    !!a &&
    !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function addMonths(d: Date, n: number): Date {
  // Clamp the day so 31 Jan + 1 month is 28/29 Feb rather than rolling into March.
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}

/** Arabic weeks start on Saturday, English weeks on Sunday. */
function weekStartFor(locale: string): number {
  return locale === 'ar' ? 6 : 0;
}

function intlLocale(locale: string): string {
  return locale === 'ar' ? 'ar-EG' : 'en-US';
}

// ---------------------------------------------------------------------------
// Calendar — the month grid. Usable on its own; DatePicker wraps it in a popover.
// ---------------------------------------------------------------------------

export interface CalendarProps {
  selected: Date | null;
  onSelect: (date: Date) => void;
  min?: Date | null;
  max?: Date | null;
  /** Month to open on when nothing is selected (defaults to today). */
  defaultMonth?: Date;
  className?: string;
}

export function Calendar({ selected, onSelect, min, max, defaultMonth, className }: CalendarProps) {
  const locale = useLocale();
  const t = useTranslations('common');
  const rtl = locale === 'ar';
  const weekStart = weekStartFor(locale);

  const today = useMemo(() => startOfDay(new Date()), []);
  const [view, setView] = useState<Date>(() => selected ?? defaultMonth ?? today);
  const [mode, setMode] = useState<'days' | 'months'>('days');
  // The cell that owns the tab stop — arrow keys move it without changing the value.
  const [focused, setFocused] = useState<Date>(() => selected ?? defaultMonth ?? today);
  const gridRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);

  // Follow the value when the consumer changes it from outside. `selected` is a
  // fresh Date object on every render, so this compares the day it represents,
  // and adjusts during render rather than in an effect (no cascading render).
  const selectedKey = selected ? toISODate(selected) : '';
  const [lastSelectedKey, setLastSelectedKey] = useState(selectedKey);
  if (selectedKey !== lastSelectedKey) {
    setLastSelectedKey(selectedKey);
    if (selected) {
      setView(selected);
      setFocused(selected);
    }
  }

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        month: 'long',
        year: 'numeric',
        numberingSystem: 'latn',
      }).format(view),
    [locale, view],
  );

  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short' });
    // 4 Jan 1970 was a Sunday — a stable anchor for "weekday index → name".
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(1970, 0, 4 + ((weekStart + i) % 7))));
  }, [locale, weekStart]);

  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(intlLocale(locale), { month: 'short' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2020, i, 1)));
  }, [locale]);

  // Six fixed rows: the panel keeps one height instead of resizing month to month.
  const days = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() - weekStart + 7) % 7;
    return Array.from({ length: 42 }, (_, i) =>
      new Date(view.getFullYear(), view.getMonth(), 1 - lead + i),
    );
  }, [view, weekStart]);

  const isDisabled = useCallback(
    (d: Date) => (min ? d < startOfDay(min) : false) || (max ? d > startOfDay(max) : false),
    [min, max],
  );

  // Move the roving tab stop and pull the view along when it leaves the month.
  const moveFocus = useCallback((next: Date) => {
    shouldFocus.current = true;
    setFocused(next);
    setView((v) =>
      next.getMonth() === v.getMonth() && next.getFullYear() === v.getFullYear() ? v : next,
    );
  }, []);

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${toISODate(focused)}"]`)?.focus();
  }, [focused, view]);

  function onKeyDown(e: React.KeyboardEvent) {
    // In RTL the grid is mirrored, so the arrow keys have to mirror with it.
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const map: Record<string, Date | undefined> = {
      [back]: addDays(focused, -1),
      [forward]: addDays(focused, 1),
      ArrowUp: addDays(focused, -7),
      ArrowDown: addDays(focused, 7),
      PageUp: addMonths(focused, -1),
      PageDown: addMonths(focused, 1),
      Home: addDays(focused, -((focused.getDay() - weekStart + 7) % 7)),
      End: addDays(focused, 6 - ((focused.getDay() - weekStart + 7) % 7)),
    };
    const next = map[e.key];
    if (next) {
      e.preventDefault();
      moveFocus(next);
    }
  }

  const navButton =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40';

  return (
    <div className={cn('w-full select-none', className)} dir={rtl ? 'rtl' : 'ltr'}>
      {/* Header — ‹ August 2026 › */}
      <div className="mb-3 flex items-center justify-between gap-1">
        <button
          type="button"
          className={navButton}
          aria-label={t('previousMonth')}
          data-testid="calendar-prev"
          onClick={() => (mode === 'days' ? setView((v) => addMonths(v, -1)) : setView((v) => addMonths(v, -12)))}
        >
          {rtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        <button
          type="button"
          data-testid="calendar-switch"
          aria-expanded={mode === 'months'}
          onClick={() => setMode((m) => (m === 'days' ? 'months' : 'days'))}
          className={cn(
            'rounded-lg px-2.5 py-1 text-sm font-semibold transition-colors',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            mode === 'months' ? 'bg-primary/10 text-primary' : 'text-foreground',
          )}
        >
          {monthLabel}
        </button>

        <button
          type="button"
          className={navButton}
          aria-label={t('nextMonth')}
          data-testid="calendar-next"
          onClick={() => (mode === 'days' ? setView((v) => addMonths(v, 1)) : setView((v) => addMonths(v, 12)))}
        >
          {rtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>

      {mode === 'months' ? (
        <div className="grid grid-cols-3 gap-1.5 pb-1">
          {monthNames.map((name, i) => {
            const isViewed = i === view.getMonth();
            return (
              <button
                key={name}
                type="button"
                data-testid={`calendar-month-${i}`}
                onClick={() => {
                  setView((v) => new Date(v.getFullYear(), i, 1));
                  setMode('days');
                }}
                className={cn(
                  'rounded-lg py-2 text-sm transition-colors',
                  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  isViewed ? 'bg-primary text-primary-foreground hover:bg-primary' : 'text-foreground',
                )}
              >
                {name}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-0.5">
            {weekdays.map((w, i) => (
              <div
                key={i}
                className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {w}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            role="grid"
            aria-label={monthLabel}
            onKeyDown={onKeyDown}
            className="grid grid-cols-7 gap-0.5"
          >
            {days.map((d) => {
              const outside = d.getMonth() !== view.getMonth();
              const disabled = isDisabled(d);
              const isSelected = sameDay(d, selected);
              const isToday = sameDay(d, today);
              return (
                <button
                  key={toISODate(d)}
                  type="button"
                  role="gridcell"
                  data-day={toISODate(d)}
                  data-today={isToday || undefined}
                  data-outside={outside || undefined}
                  aria-selected={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  disabled={disabled}
                  tabIndex={sameDay(d, focused) ? 0 : -1}
                  onClick={() => {
                    setFocused(d);
                    onSelect(d);
                  }}
                  className={cn(
                    'flex h-9 w-full items-center justify-center rounded-lg text-sm tabular-nums transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    'hover:bg-accent',
                    outside && 'text-muted-foreground/45',
                    !outside && 'text-foreground',
                    isToday && !isSelected && 'font-semibold text-primary ring-1 ring-inset ring-primary/40',
                    isSelected && 'bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary',
                    disabled && 'pointer-events-none opacity-35',
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DatePicker — the form control.
// ---------------------------------------------------------------------------

export interface DatePickerProps {
  /** Form field name. A hidden input carries `YYYY-MM-DD`, so FormData reads are unchanged. */
  name?: string;
  /** Controlled value, `YYYY-MM-DD` (a full ISO timestamp is also accepted). */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** Show an X to empty the field. Defaults to true for optional fields. */
  clearable?: boolean;
  min?: string;
  max?: string;
  className?: string;
  id?: string;
}

/**
 * A date field built on Radix Popover.
 *
 * `<input type="date">` is the browser's own control: it renders differently in
 * every browser, ignores the app's styling, and its picker is a system popup
 * that neither matches this UI nor follows the Arabic layout. This replaces it
 * with the same calendar everywhere, keyboard-navigable, and — because the
 * value still travels in a hidden `YYYY-MM-DD` input — every form that reads
 * FormData keeps working untouched.
 */
export function DatePicker({
  name,
  value,
  defaultValue,
  onChange,
  placeholder,
  required = false,
  disabled = false,
  clearable,
  min,
  max,
  className,
  id,
}: DatePickerProps) {
  const t = useTranslations('common');
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(() => (defaultValue ? defaultValue.slice(0, 10) : ''));
  const current = controlled ? (value ?? '').slice(0, 10) : internal;
  const selected = parseISODate(current);

  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const showClear = (clearable ?? !required) && !!selected && !disabled;

  const commit = (next: string) => {
    if (!controlled) setInternal(next);
    onChange?.(next);
    if (next) setInvalid(false);
  };

  return (
    <div className={cn('relative', className)}>
      <input type="hidden" name={name} value={current} readOnly />

      {/* Mirrors required-ness for forms calling reportValidity(); a hidden
          input cannot be focused, so it cannot carry `required` itself.

          Sized to cover the trigger, not 0x0: on a zero-sized box the browser
          blocks the submit, cannot focus the field to explain why, and gives up
          without a word — the button just stops working. */}
      {required && !current && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value=""
          onChange={() => {}}
          onInvalid={() => setInvalid(true)}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            data-slot="date-picker-trigger"
            data-date-picker={name}
            aria-label={placeholder ?? t('pickDate')}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border border-input bg-background',
              'px-3 py-2 text-start text-sm transition-colors',
              'hover:border-gray-300',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring',
              'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
              open && 'border-ring ring-2 ring-ring/20',
              invalid && !open && 'border-destructive ring-2 ring-destructive/20',
            )}
          >
            <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className={cn('flex-1 truncate', selected ? 'text-foreground' : 'text-muted-foreground')}>
              {selected ? formatDate(current) : (placeholder ?? t('pickDate'))}
            </span>

            {showClear && (
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('clear')}
                onPointerDown={(e) => {
                  // Stop the trigger from toggling the popover open.
                  e.preventDefault();
                  e.stopPropagation();
                  commit('');
                }}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" sideOffset={4} className="w-[19rem] p-3">
          <Calendar
            selected={selected}
            min={parseISODate(min)}
            max={parseISODate(max)}
            onSelect={(d) => {
              commit(toISODate(d));
              setOpen(false);
            }}
          />

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
            <button
              type="button"
              data-testid="date-picker-today"
              onClick={() => {
                commit(toISODate(new Date()));
                setOpen(false);
              }}
              className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {t('today')}
            </button>

            {!required && (
              <button
                type="button"
                data-testid="date-picker-clear"
                onClick={() => {
                  commit('');
                  setOpen(false);
                }}
                className="rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {t('clear')}
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {invalid && (
        <p role="alert" data-slot="date-picker-error" className="mt-1 text-xs text-destructive">
          {t('required')}
        </p>
      )}
    </div>
  );
}
