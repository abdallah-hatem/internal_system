'use client';

import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { selectOnFocus } from '../../lib/select-on-focus';

/**
 * An amount field that reads like money while it is being typed.
 *
 * 1512.91 is a number; 1,512.91 is an amount. Without the separators a mistyped
 * 15129.1 looks much like 1512.91 at a glance, which is the whole reason these
 * are grouped on every printed invoice in the world.
 *
 * It cannot be an `<input type="number">`: a browser will not display "1,512.91"
 * in one — the value is rejected and comes back empty. So this is a text input
 * with a numeric keypad on mobile, and a hidden field carrying the plain number
 * for anything reading the form through FormData.
 *
 * Typing is the hard part. Reformatting on every keystroke moves the caret,
 * because inserting a comma shifts everything after it — type "1234" and the
 * caret lands before the 4 rather than after it. So the caret is restored by
 * counting digits rather than characters: whatever digit it sat after before
 * the reformat, it sits after again.
 */

/** Digits and at most one decimal point, which is all an amount can be. */
function clean(raw: string): string {
  const stripped = raw.replace(/[^\d.]/g, '');
  const [whole, ...rest] = stripped.split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole;
}

/** Group the whole part, leaving a trailing "." or partial decimals alone. */
function group(value: string): string {
  if (value === '') return '';
  const [whole, decimals] = value.split('.');
  const grouped = whole === '' ? '' : Number(whole).toLocaleString('en-US');
  if (value.includes('.')) return `${grouped}.${decimals ?? ''}`;
  return grouped;
}

/**
 * Digits and the decimal point both count.
 *
 * Counting only digits loses the point the moment it is typed: after "1234."
 * the caret would be placed after the seventh digit, which is *before* the
 * point, so the next keystroke lands ahead of it and "1234.56" comes out as
 * "123456." — the separator walking to the end as you type.
 */
const significantBefore = (text: string, caret: number) =>
  (text.slice(0, caret).match(/[\d.]/g) ?? []).length;

/** Where the caret goes so it sits after the same character it did before. */
function caretAfterSignificant(text: string, count: number): number {
  if (count === 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[\d.]/.test(text[i])) {
      seen += 1;
      if (seen === count) return i + 1;
    }
  }
  return text.length;
}

export function MoneyInput({
  name,
  value,
  defaultValue,
  onChange,
  className = '',
  ...rest
}: {
  name?: string;
  /** Controlled numeric value. Leave undefined for an uncontrolled field. */
  value?: number | string;
  defaultValue?: number | string;
  /** The plain number, as a string — '' when the field is empty. */
  onChange?: (raw: string) => void;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type'>) {
  const controlled = value !== undefined;
  const initial = clean(String(controlled ? value : defaultValue ?? ''));
  const [display, setDisplay] = useState(group(initial));
  const inputRef = useRef<HTMLInputElement>(null);
  const caretTarget = useRef<number | null>(null);

  // A controlled value changed elsewhere — a prefilled price, a recalculated
  // total — should show here, but not while the field is being typed into.
  useEffect(() => {
    if (!controlled) return;
    if (document.activeElement === inputRef.current) return;
    setDisplay(group(clean(String(value ?? ''))));
  }, [controlled, value]);

  // Put the caret back after React has painted the reformatted text.
  useEffect(() => {
    if (caretTarget.current === null) return;
    const input = inputRef.current;
    if (input && document.activeElement === input) {
      input.setSelectionRange(caretTarget.current, caretTarget.current);
    }
    caretTarget.current = null;
  });

  const raw = clean(display);

  return (
    <>
      {name && <input type="hidden" name={name} value={raw} readOnly />}
      <input
        {...rest}
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={display}
        onChange={(e) => {
          const typed = e.target.value;
          const caret = e.target.selectionStart ?? typed.length;
          const nextRaw = clean(typed);
          const nextDisplay = group(nextRaw);

          caretTarget.current = caretAfterSignificant(nextDisplay, significantBefore(typed, caret));
          setDisplay(nextDisplay);
          onChange?.(nextRaw);
        }}
        // The shared select-on-focus, not a copy of it. Selecting inside a
        // requestAnimationFrame — which is what this did — loses a race with
        // fast typing: the callback fires after the first keystroke and
        // selects it, so the second keystroke replaces it and "250" becomes
        // "50". Selecting synchronously and suppressing the mouseup that would
        // collapse it is the version that works.
        onFocus={(e) => {
          selectOnFocus.onFocus(e);
          rest.onFocus?.(e);
        }}
        onMouseUp={(e) => {
          selectOnFocus.onMouseUp(e);
          rest.onMouseUp?.(e);
        }}
        onBlur={(e) => {
          selectOnFocus.onBlur(e);
          // Tidy "1,234." and "" into something a person would have written.
          const tidy = clean(display).replace(/\.$/, '');
          setDisplay(group(tidy));
          onChange?.(tidy);
          rest.onBlur?.(e);
        }}
        className={className}
      />
    </>
  );
}
