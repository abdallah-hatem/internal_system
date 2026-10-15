'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DatePicker } from './date-picker';

/**
 * The form controls every page had its own copy of.
 *
 * `InputField` was redefined at the bottom of fourteen pages, byte-identical
 * each time, and so was the cancel/submit row. Extracting them is what lets an
 * entity's form live in one place instead of being re-typed wherever it is
 * needed — which is the whole point of the shared entity forms next door.
 *
 * (`components/ui/form-field.tsx` predates this and is imported by nothing. It
 * takes a different shape, and adopting it here would have changed how every
 * existing form renders. Left alone rather than half-migrated.)
 */

/**
 * The mark beside a field's name: `*` when it is required, `(Optional)` when
 * it is not.
 *
 * Marking the optional ones is not decoration — it is what tells a reader that
 * a blank field is a choice rather than something they missed. Every page's own
 * copy of `InputField` did it unconditionally, so a form that renders through
 * this one and stays silent reads as a *different form*, which is exactly how
 * the shared supplier form was spotted as not being the one its tab shows.
 *
 * Silent by default was the wrong default. It is on unless a caller says
 * `optional={false}`, for the few fields where the hint is noise — a picker
 * that already carries a placeholder saying the same thing.
 *
 * It is translated. The fourteen local copies wrote `(Optional)` in English
 * into the markup, so an Arabic reader got one English word per field.
 */
export function FieldMark({
  required,
  optional,
}: {
  required?: boolean;
  optional?: boolean;
}) {
  const t = useTranslations('common');
  if (required) return <span className="text-red-500 ms-1">*</span>;
  if (optional === false) return null;
  return (
    <span className="text-gray-400 ms-1 text-xs font-normal">({t('optional')})</span>
  );
}

export function InputField({
  label,
  name,
  type = 'text',
  defaultValue,
  required,
  placeholder,
  optional,
  dir,
  maxLength,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  placeholder?: string;
  /** `false` hides the "(Optional)" hint a non-required field carries. */
  optional?: boolean;
  /** `rtl` for a field written in Arabic whatever the page's language. */
  dir?: 'rtl' | 'ltr';
  maxLength?: number;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        <FieldMark required={required} optional={optional} />
      </label>
      {/* `type="date"` means the app's own picker, not the browser's. Three of
          the six local copies of this component had that branch and three did
          not, so the same declaration rendered two different controls depending
          which page you were on. */}
      {type === 'date' ? (
        <DatePicker
          name={name}
          defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
          required={required}
          placeholder={placeholder}
        />
      ) : (
        <input
          type={type}
          name={name}
          defaultValue={defaultValue}
          required={required}
          placeholder={placeholder}
          dir={dir}
          maxLength={maxLength}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      )}
    </div>
  );
}

/** A labelled wrapper for a control the caller supplies — a Select, usually. */
export function FieldLabel({
  label,
  required,
  optional,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        <FieldMark required={required} optional={optional} />
      </label>
      {children}
    </div>
  );
}

/**
 * A control with no label in a row of labelled fields — a remove ✕, a +.
 *
 * A `field-row` aligns its fields to the top (see globals.css), so an
 * unlabelled button would sit level with the labels, not the boxes. This keeps
 * an empty line above it in the row's own label style — pass the same classes
 * the row's labels use — and centres the control on a box-high band, so it
 * lines up with the boxes beside it whatever shows under them.
 */
export function RowAction({
  labelClassName = 'block text-sm font-medium mb-1',
  children,
}: {
  /** The classes of the labels beside it, so the empty line is as tall. */
  labelClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-row-action className="shrink-0">
      <span aria-hidden="true" className={`${labelClassName} invisible select-none`}>
        {' '}
      </span>
      <div className="flex h-(--field-h) items-center justify-center">{children}</div>
    </div>
  );
}

export function FormActions({
  onCancel,
  cancelLabel,
  submitLabel,
  busy,
  form,
  disabled,
}: {
  onCancel: () => void;
  cancelLabel: string;
  submitLabel: string;
  busy?: boolean;
  /**
   * The id of the form these submit, when they sit outside it — in a dialog's
   * fixed footer (`components/ui/dialog.tsx`). The submit is still the form's
   * own button, so Enter in a field still submits.
   */
  form?: string;
  /** Submit unavailable for a reason other than a save in flight. */
  disabled?: boolean;
}) {
  return (
    <div className={form ? 'flex justify-end gap-3' : 'flex justify-end gap-3 pt-2'}>
      {/* type="button" on the cancel, or it submits the form it is meant to
          abandon — the default for a button inside a form. */}
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
      >
        {cancelLabel}
      </button>
      <button
        type="submit"
        form={form}
        disabled={busy || disabled}
        className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitLabel}
      </button>
    </div>
  );
}
