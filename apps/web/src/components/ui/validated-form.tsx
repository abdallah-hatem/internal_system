'use client';

import { forwardRef, useState, type FormHTMLAttributes } from 'react';

type SubmitEvt = Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>['onSubmit']>>[0];
import { useLocale, useTranslations } from 'next-intl';

/**
 * A `<form>` that checks its own fields and says so in the reader's language.
 *
 * Without `noValidate` the browser checks `required`, `min` and the rest itself
 * and answers in its own language — "Please fill out this field", in English,
 * on an Arabic screen (UX #10). With `noValidate` and nothing else, nothing
 * checks them at all and an empty form reaches the API.
 *
 * So this turns the browser's bubble off and keeps its rules: on submit it asks
 * the constraint API (`checkValidity`, which still works on a `noValidate`
 * form) which fields fail. If any do, the submit stops, the first one takes the
 * focus, each is marked `aria-invalid`, and one translated line under the form
 * names them. `checkValidity` also fires each field's `invalid` event, so the
 * shared `Select` and `DatePicker` show their own "Required" as they did
 * before.
 *
 * A drop-in for `<form>`: same props, and `onSubmit` is only called once every
 * field passes. A form that validates in its own handler loses nothing.
 */
export const ValidatedForm = forwardRef<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>(
  function ValidatedForm({ onSubmit, onInput, children, ...rest }, ref) {
    const t = useTranslations('validation');
    const locale = useLocale();
    const [problem, setProblem] = useState<string | null>(null);

    const handleSubmit = (e: SubmitEvt) => {
      const form = e.currentTarget;
      const invalid = invalidFields(form);
      if (invalid.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        form.querySelectorAll('[aria-invalid="true"][data-validated]').forEach((el) => {
          el.removeAttribute('aria-invalid');
          el.removeAttribute('data-validated');
        });
        for (const el of invalid) {
          if (el.getAttribute('aria-hidden') === 'true') continue;
          el.setAttribute('aria-invalid', 'true');
          el.setAttribute('data-validated', '');
        }
        focusable(invalid[0])?.focus();

        const names = [...new Set(invalid.map(labelOf).filter(Boolean))].join(locale === 'ar' ? '، ' : ', ');
        const missing = invalid.some((el) => el.validity.valueMissing);
        setProblem(
          missing
            ? names ? t('requiredNamed', { fields: names }) : t('required')
            : names ? t('invalidNamed', { fields: names }) : t('invalid'),
        );
        return;
      }
      setProblem(null);
      onSubmit?.(e);
    };

    return (
      <form
        {...rest}
        ref={ref}
        noValidate
        onSubmit={handleSubmit}
        onInput={(e) => {
          // Typing into a flagged field clears its flag; the line under the
          // form goes once nothing is flagged.
          const el = e.target as HTMLElement;
          if (el.hasAttribute('data-validated')) {
            el.removeAttribute('aria-invalid');
            el.removeAttribute('data-validated');
            if (!e.currentTarget.querySelector('[data-validated]')) setProblem(null);
          }
          onInput?.(e);
        }}
      >
        {children}
        {problem && (
          <p role="alert" data-slot="form-error" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </form>
    );
  },
);

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Every control in the form that fails its own constraints, in document order. */
export function invalidFields(form: HTMLFormElement): Field[] {
  // Fires `invalid` on each failing control — the shared Select and DatePicker
  // listen for it to show their own message.
  form.checkValidity();
  return Array.from(form.elements).filter(
    (el): el is Field =>
      (el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement) &&
      !el.disabled &&
      !el.validity.valid,
  );
}

/**
 * The visible name of a field: its `<label>`, or the label in the same field
 * group (most forms here put the label beside the input without `htmlFor`).
 * The required mark and "(Optional)" are stripped.
 */
function labelOf(el: Field): string {
  let text = el.labels?.[0]?.textContent ?? null;
  // Climb to the nearest group that holds a label — never past the form.
  let node = el.parentElement;
  for (let i = 0; !text && node && node.tagName !== 'FORM' && i < 4; i++) {
    text = node.querySelector('label')?.textContent ?? null;
    node = node.parentElement;
  }
  return (text ?? '')
    .replace(/\*/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
}

/** The shared pickers hide their proxy input; focus the control beside it. */
function focusable(el: Field | undefined): HTMLElement | null {
  if (!el) return null;
  if (el.getAttribute('aria-hidden') === 'true' || el.tabIndex < 0) {
    return el.parentElement?.querySelector<HTMLElement>('button, input:not([type="hidden"]):not([aria-hidden])') ?? null;
  }
  return el;
}
