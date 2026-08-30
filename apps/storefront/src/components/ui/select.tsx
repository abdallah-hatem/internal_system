'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

/** Lists shorter than this are faster to scan than to search. */
const SEARCH_THRESHOLD = 4;

export interface SelectOption {
  value: string;
  label: string;
  /** Second line, e.g. an SKU or a cycle's status. */
  hint?: string;
  disabled?: boolean;
}

/**
 * A searchable select, built on Radix Popover and cmdk.
 *
 * A native <select> is right for a handful of options and we keep it there. It
 * stops being right once the list is long: it cannot be filtered, so picking
 * one cycle out of thirty means scrolling a system popup reading codes that
 * differ by two digits.
 *
 * Radix handles the parts that are easy to get subtly wrong — focus trapping,
 * dismissal, scroll locking, aria wiring, and collision-aware positioning so
 * the panel flips above the trigger near the bottom of a modal instead of
 * overflowing it.
 *
 * A hidden input carries `name`, so forms reading values through FormData work
 * unchanged.
 *
 * The search box only appears once the list is long enough to need it
 * (SEARCH_THRESHOLD). On three currencies a search field is noise, and it also
 * steals the first keystroke from someone who just wants to arrow down.
 */
export function Select({
  name,
  options,
  value,
  defaultValue,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  required,
  disabled,
  clearable = false,
  className,
  id,
}: {
  name?: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
  id?: string;
}) {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? '');
  const selected = controlled ? value! : internal;

  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const commandRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();

  const showSearch = options.length >= SEARCH_THRESHOLD;

  const selectedOption = useMemo(
    () => options.find((o) => o.value === selected),
    [options, selected],
  );

  // Match the panel to the trigger so the control reads as one element rather
  // than a button with an unrelated menu hanging off it.
  useEffect(() => {
    if (open) setWidth(triggerRef.current?.offsetWidth);
  }, [open]);

  const commit = (v: string) => {
    if (!controlled) setInternal(v);
    onChange?.(v);
    setInvalid(false);
    setOpen(false);
  };

  return (
    <div className={cn('relative', className)}>
      <input type="hidden" name={name} value={selected} readOnly />

      {/* Mirrors required-ness for forms that call reportValidity(); a hidden
          input cannot be focused, so it cannot carry `required` itself.

          It has to fill the control rather than measure 0x0: on a zero-sized box
          the browser blocks the submit, fails to focus the offending field, and
          gives up silently — the form just stops responding with nothing shown.
          Sized and overlaid, the native bubble lands on the control, and the
          `invalid` event lets us show a message that outlives it. */}
      {required && !selected && (
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
            ref={triggerRef}
            type="button"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
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
            <span
              className={cn(
                'flex-1 truncate',
                selectedOption ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {selectedOption?.label ?? placeholder}
            </span>

            {clearable && selectedOption && !disabled && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Clear"
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

            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground opacity-70" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={4}
          style={width ? { width } : undefined}
          className="p-0"
          onOpenAutoFocus={
            showSearch
              ? undefined
              : (e) => {
                  // No search box means nothing inside is tabbable, so Radix would
                  // leave focus on the panel and cmdk — which listens on its own
                  // root — would never see the arrow keys.
                  e.preventDefault();
                  commandRef.current?.focus();
                }
          }
        >
          <Command
            ref={commandRef}
            // Filter on the hint too, so an SKU or a cycle status finds its row.
            filter={(itemValue, search) => {
              const opt = options.find((o) => o.value === itemValue);
              const haystack = `${opt?.label ?? ''} ${opt?.hint ?? ''}`.toLowerCase();
              return haystack.includes(search.toLowerCase()) ? 1 : 0;
            }}
          >
            {showSearch && <CommandInput placeholder={searchPlaceholder} className="h-9" />}
            <CommandList>
              {showSearch && <CommandEmpty>{emptyText}</CommandEmpty>}
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                    onSelect={commit}
                    className="gap-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate',
                          opt.value === selected && 'font-medium',
                        )}
                      >
                        {opt.label}
                      </span>
                      {opt.hint && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {opt.hint}
                        </span>
                      )}
                    </span>
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0 text-primary',
                        opt.value === selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {invalid && (
        <p role="alert" data-slot="select-error" className="mt-1 text-xs text-destructive">
          {t('required')}
        </p>
      )}
    </div>
  );
}
