'use client';

import { type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormFieldProps {
  /** Visible label text */
  label: string;
  /** Name attribute forwarded to the child input */
  name: string;
  /** HTML input type – used only when `children` is not provided */
  type?: string;
  /** Show a red asterisk next to the label */
  required?: boolean;
  /** Validation error message – when provided the field shows an error state */
  error?: string;
  /** Custom className applied to the wrapper */
  className?: string;
  /** Pass a custom input / select / textarea element. When omitted a default <input> is rendered. */
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FormField({
  label,
  name,
  type = 'text',
  required = false,
  error,
  className = '',
  children,
}: FormFieldProps) {
  const inputId = `field-${name}`;

  const baseInputClasses = [
    'w-full rounded-lg border px-3 py-2 text-sm',
    'bg-white text-gray-900 placeholder:text-gray-400',
    'transition-colors duration-150',
    'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
    error
      ? 'border-red-400 focus:ring-red-500'
      : 'border-gray-200',
  ].join(' ');

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ms-1 text-red-500">*</span>}
      </label>

      {children ? (
        // If the consumer provides their own element, wrap it with error styling
        <div className={baseInputClasses + ' !p-0'}>
          {children}
        </div>
      ) : (
        <input
          id={inputId}
          name={name}
          type={type}
          required={required}
          className={baseInputClasses}
        />
      )}

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convenience sub-components for common field types
// ---------------------------------------------------------------------------

export function FormSelect({
  label,
  name,
  required = false,
  error,
  className,
  children,
  ...selectProps
}: Omit<FormFieldProps, 'type' | 'children'> &
  SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const inputId = `field-${name}`;

  const baseSelectClasses = [
    'w-full rounded-lg border px-3 py-2 text-sm',
    'bg-white text-gray-900',
    'transition-colors duration-150',
    'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
    error
      ? 'border-red-400 focus:ring-red-500'
      : 'border-gray-200',
  ].join(' ');

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ms-1 text-red-500">*</span>}
      </label>

      <select
        id={inputId}
        name={name}
        required={required}
        className={baseSelectClasses}
        {...selectProps}
      >
        {children}
      </select>

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}

export function FormTextarea({
  label,
  name,
  required = false,
  error,
  className,
  ...textareaProps
}: Omit<FormFieldProps, 'type' | 'children'> &
  TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const inputId = `field-${name}`;

  const baseTextareaClasses = [
    'w-full rounded-lg border px-3 py-2 text-sm',
    'bg-white text-gray-900 placeholder:text-gray-400',
    'transition-colors duration-150 resize-y',
    'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
    error
      ? 'border-red-400 focus:ring-red-500'
      : 'border-gray-200',
  ].join(' ');

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ms-1 text-red-500">*</span>}
      </label>

      <textarea
        id={inputId}
        name={name}
        required={required}
        className={baseTextareaClasses}
        rows={4}
        {...textareaProps}
      />

      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}
