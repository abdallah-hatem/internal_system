import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import { ValidatedForm } from './validated-form';
import { Ship, Truck } from '@/components/ui/icons';
import { ChoiceCards, type ChoiceCard } from './choice-cards';

/**
 * Choice cards (owner 2026-10-24: the cycle wizard's origin and currency): a
 * radio group under the cards, so a click, the keyboard, a screen reader,
 * `required` and the form's data all behave as radios do.
 */

afterEach(() => cleanup());

const ROUTES: ChoiceCard[] = [
  { value: 'CHINA', label: 'China', description: 'China → UAE → Egypt', icon: Ship },
  { value: 'UAE_DIRECT', label: 'UAE direct', description: 'UAE → Egypt', icon: Truck },
];

function Form({ initial = '', onSubmit }: { initial?: string; onSubmit?: (fd: FormData) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.(new FormData(e.currentTarget));
        }}
      >
        <ChoiceCards name="originType" legend="Origin" required options={ROUTES} value={value} onChange={setValue} />
        <button type="submit">Save</button>
      </form>
    </NextIntlClientProvider>
  );
}

describe('choice cards', () => {
  it('a labelled radio group with one radio per card, none picked to start', () => {
    render(<Form />);
    const group = screen.getByRole('radiogroup', { name: 'Origin' });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(['CHINA', 'UAE_DIRECT']);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(group.textContent).toContain('China → UAE → Egypt');
  });

  it('clicking a card picks it, shows it picked, and the form sends its value', () => {
    let sent: FormData | null = null;
    render(<Form onSubmit={(fd) => (sent = fd)} />);
    fireEvent.click(screen.getByText('UAE direct'));
    expect((screen.getByRole('radio', { name: /UAE direct/ }) as HTMLInputElement).checked).toBe(true);
    const cards = screen.getAllByTestId('choice-card');
    expect(cards.map((c) => c.getAttribute('data-checked'))).toEqual(['false', 'true']);
    expect(cards[1].className).toContain('border-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sent!.get('originType')).toBe('UAE_DIRECT');
  });

  it('the second time: picking the other card moves the choice — never two picked', () => {
    render(<Form initial="CHINA" />);
    fireEvent.click(screen.getByText('UAE direct'));
    fireEvent.click(screen.getByText('China'));
    const checked = screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked);
    expect(checked.map((r) => (r as HTMLInputElement).value)).toEqual(['CHINA']);
  });

  it('nothing picked: required leaves the form invalid; picked: valid', () => {
    render(<Form />);
    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    expect(form.checkValidity()).toBe(false);
    fireEvent.click(screen.getByText('China'));
    expect(form.checkValidity()).toBe(true);
  });

  it('a card restored from a draft or a saved cycle shows picked', () => {
    render(<Form initial="UAE_DIRECT" />);
    expect((screen.getByRole('radio', { name: /UAE direct/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('uses no physical left/right classes, so Arabic mirrors', () => {
    const { container } = render(
      <div dir="rtl">
        <Form initial="CHINA" />
      </div>,
    );
    const classes = [...container.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/(^|\s)-?(pl|pr|ml|mr|left|right)-|text-left|text-right/);
  });
});

describe('choice cards in a ValidatedForm', () => {
  it('saving with nothing picked: one message naming the question, not the answers; the cards say required; picking clears it', async () => {
    function Wizardish() {
      const [value, setValue] = useState('');
      return (
        <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
          <ValidatedForm onSubmit={(e) => e.preventDefault()}>
            <ChoiceCards name="originType" legend="Origin" required options={ROUTES} value={value} onChange={setValue} />
            <button type="submit">Save</button>
          </ValidatedForm>
        </NextIntlClientProvider>
      );
    }
    const { container } = render(<Wizardish />);
    fireEvent.submit(container.querySelector('form')!);
    expect(screen.getByText(en.common.required)).toBeTruthy();
    // The form's one line names the question, once — never the cards' labels.
    const summary = container.querySelector('[data-slot="form-error"]')!.textContent ?? '';
    expect(summary).toContain('Origin');
    expect(summary).not.toMatch(/China|UAE/);
    fireEvent.click(screen.getByText('China'));
    expect(screen.queryByText(en.common.required)).toBeNull();
  });
});
