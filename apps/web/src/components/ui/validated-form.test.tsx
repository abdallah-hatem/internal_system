import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ValidatedForm } from './validated-form';

afterEach(cleanup);

function inArabic(children: ReactNode) {
  return render(
    <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
      {children}
    </NextIntlClientProvider>,
  );
}

function CustomerForm({ onSubmit }: { onSubmit: () => void }) {
  return (
    <ValidatedForm
      data-testid="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <label htmlFor="name">
          {ar.customers.name}
          <span aria-hidden="true">*</span>
        </label>
        <input id="name" name="name" required />
      </div>
      <div>
        <label>{ar.customers.phone}</label>
        <input name="phone" />
      </div>
      <div>
        <label>{ar.purchases.orderedQty}</label>
        <input name="qty" type="number" min="0" />
      </div>
      <button type="submit">{ar.common.save}</button>
    </ValidatedForm>
  );
}

describe('ValidatedForm', () => {
  it('turns the browser’s own (English) bubble off', () => {
    inArabic(<CustomerForm onSubmit={() => {}} />);
    expect(screen.getByTestId('form').hasAttribute('novalidate')).toBe(true);
  });

  it('an empty required field: the translated message names it, nothing is sent, the field is flagged and focused', () => {
    const sent = vi.fn();
    inArabic(<CustomerForm onSubmit={sent} />);
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));

    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      ar.validation.requiredNamed.replace('{fields}', ar.customers.name),
    );
    const name = document.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
    // Not the English one either.
    expect(screen.getByRole('alert').textContent).not.toContain(en.validation.required);
  });

  it('the second time: fixing the field clears the flag and the submit goes through once', () => {
    const sent = vi.fn();
    inArabic(<CustomerForm onSubmit={sent} />);
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    const name = document.querySelector<HTMLInputElement>('input[name="name"]')!;

    fireEvent.input(name, { target: { value: 'محل النيل' } });
    expect(name.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('a rule other than "required" (a negative quantity) is still enforced, with its own wording', () => {
    const sent = vi.fn();
    inArabic(<CustomerForm onSubmit={sent} />);
    fireEvent.input(document.querySelector('input[name="name"]')!, { target: { value: 'x' } });
    fireEvent.input(document.querySelector('input[name="qty"]')!, { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: ar.common.save }));

    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      ar.validation.invalidNamed.replace('{fields}', ar.purchases.orderedQty),
    );
  });
});
