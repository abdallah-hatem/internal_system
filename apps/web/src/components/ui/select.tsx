'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  /** Second line, e.g. an SKU or a cycle status. */
  hint?: string;
  disabled?: boolean;
}

/**
 * A searchable select.
 *
 * A native <select> is the right tool for a handful of options and we keep it
 * there. It stops being the right tool once the list is long: it cannot be
 * filtered, so picking one cycle out of thirty means scrolling a system popup
 * reading codes that differ by two digits.
 *
 * The component renders a hidden input carrying `name`, so forms that read
 * values through FormData keep working unchanged.
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
  className = '',
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
  const reactId = useId();
  const listId = `${reactId}-listbox`;
  const controlled = value !== undefined;

  const [internal, setInternal] = useState(defaultValue ?? '');
  const selected = controlled ? value! : internal;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((o) => o.value === selected);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.hint ? o.hint.toLowerCase().includes(q) : false),
    );
  }, [options, query]);

  // Close on outside click or Escape, and return focus to the trigger.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Opening puts the caret in the search box: the point of this control is that
  // you can type immediately instead of hunting through a list.
  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = Math.max(0, options.findIndex((o) => o.value === selected));
      setActive(idx);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, options, selected]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (v: string) => {
    if (!controlled) setInternal(v);
    onChange?.(v);
    setOpen(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[active];
      if (opt && !opt.disabled) commit(opt.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {/* Carries the value for FormData-based submits. */}
      <input
        type="hidden"
        name={name}
        value={selected}
        // A hidden input cannot be focused, so browser required-validation
        // would block submit with an unfocusable field. Forms using this
        // control validate the value themselves.
        readOnly
      />

      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`
          w-full flex items-center gap-2 rounded-lg border bg-white
          px-3 py-2 text-sm text-start transition-colors
          ${disabled ? 'cursor-not-allowed bg-gray-50 text-gray-400' : 'hover:border-gray-300'}
          ${open ? 'border-primary-500 ring-2 ring-primary-500/20' : 'border-gray-200'}
        `}
      >
        <span className={`flex-1 truncate ${selectedOption ? 'text-gray-900' : 'text-gray-400'}`}>
          {selectedOption?.label ?? placeholder}
        </span>

        {clearable && selectedOption && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              commit('');
            }}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}

        <ChevronDown
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {required && !selected && (
        <input
          // Mirrors required-ness for forms that call reportValidity().
          tabIndex={-1}
          aria-hidden="true"
          required
          value=""
          onChange={() => {}}
          className="pointer-events-none absolute h-0 w-0 opacity-0"
        />
      )}

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm placeholder:text-gray-400 focus:outline-none"
            />
          </div>

          <ul ref={listRef} id={listId} role="listbox" className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-gray-400">{emptyText}</li>
            ) : (
              filtered.map((opt, i) => {
                const isSelected = opt.value === selected;
                return (
                  <li
                    key={opt.value}
                    data-idx={i}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => !opt.disabled && commit(opt.value)}
                    className={`
                      flex cursor-pointer items-center gap-2 px-3 py-2 text-sm
                      ${opt.disabled ? 'cursor-not-allowed text-gray-300' : ''}
                      ${i === active && !opt.disabled ? 'bg-primary-50' : ''}
                    `}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${isSelected ? 'font-medium text-gray-900' : 'text-gray-700'}`}>
                        {opt.label}
                      </span>
                      {opt.hint && (
                        <span className="block truncate text-xs text-gray-400">{opt.hint}</span>
                      )}
                    </span>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-primary-600" />}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
