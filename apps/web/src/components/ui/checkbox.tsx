'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';

/**
 * A checkbox with its label, in the app's tokens. The native control lives
 * here, in the UI kit, so pages never draw their own (eslint rule 6).
 */
export function Checkbox({
  label,
  className = '',
  ...rest
}: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <label className={`flex items-center gap-2 text-sm text-foreground ${className}`}>
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-border text-primary-600 focus:ring-2 focus:ring-ring"
        {...rest}
      />
      {label}
    </label>
  );
}
