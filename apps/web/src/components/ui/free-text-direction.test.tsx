import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import { InputField } from './fields';
import { TextareaField } from './textarea-field';
import { CurrentRateHint } from './currency-rate-fields';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';

/**
 * Latin text on an Arabic page (UI audit 2026-11, M5/M6/L5). A field or a run
 * of text takes the page's right-to-left direction unless something says
 * otherwise, and the bidi algorithm then moves a trailing full stop to the
 * front ("Parts Co." → ".Parts Co") and reorders "1 CNY = 7.06" into
 * "CNY = 7.06 1". jsdom lays nothing out, so these pin the direction and
 * isolation that decide it.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => ({ locale: 'ar' }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/ar/suppliers',
}));
vi.mock('@/lib/currency-rates', () => ({ useCurrencyRates: () => ({ CNY: 7.06 }) }));

afterEach(cleanup);

function arabic(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
        <div dir="rtl">{ui}</div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

describe('a free-text field follows its own text', () => {
  it('an English description on the Arabic page reads left to right', () => {
    arabic(<TextareaField label="d" name="description" defaultValue="Spare boom mic, wired mic and speakers for V6 / M2." />);
    expect(field('description').getAttribute('dir')).toBe('auto');
  });

  it('an English name in a text input reads left to right', () => {
    arabic(<InputField label="n" name="name" defaultValue="Guangzhou Moto Parts Co." />);
    expect(field('name').getAttribute('dir')).toBe('auto');
  });

  it('empty, it keeps the page direction, so the Arabic placeholder stays on the right', () => {
    // Chromium resolves an empty dir="auto" field to left to right.
    arabic(<InputField label="n" name="name" placeholder="قطع الفرامل" />);
    arabic(<TextareaField label="d" name="notes" placeholder="ملاحظة" />);
    expect(field('name').hasAttribute('dir')).toBe(false);
    expect(field('notes').hasAttribute('dir')).toBe(false);
  });

  it('typing into an empty field turns it on; clearing it again turns it off', () => {
    arabic(<TextareaField label="d" name="notes" />);
    fireEvent.input(field('notes'), { target: { value: 'Ships Fridays.' } });
    expect(field('notes').getAttribute('dir')).toBe('auto');
    fireEvent.input(field('notes'), { target: { value: '' } });
    expect(field('notes').hasAttribute('dir')).toBe(false);
  });

  it('a field the caller fixes keeps that direction, typed into or not', () => {
    arabic(<TextareaField label="d" name="descriptionAr" dir="rtl" defaultValue="Kit." />);
    fireEvent.input(field('descriptionAr'), { target: { value: 'x' } });
    expect(field('descriptionAr').getAttribute('dir')).toBe('rtl');
  });

  it('a number, an email or a phone is not touched', () => {
    arabic(
      <>
        <InputField label="q" name="qty" type="number" defaultValue={3} />
        <InputField label="e" name="email" type="email" defaultValue="a@b.co" />
      </>,
    );
    expect(field('qty').hasAttribute('dir')).toBe(false);
    expect(field('email').hasAttribute('dir')).toBe(false);
  });

  it('the shared product form: an English description is the field that follows its text', () => {
    arabic(<ENTITY_FORMS.product.Fields record={{ name: 'Helmet Kit', description: 'For V6 / M2.' } as never} />);
    expect(field('description').getAttribute('dir')).toBe('auto');
    expect(field('descriptionAr').getAttribute('dir')).toBe('rtl');
  });
});

describe('the supplier form', () => {
  it('the WhatsApp number reads left to right, as the phone does (L5)', () => {
    arabic(<ENTITY_FORMS.supplier.Fields />);
    expect(field('whatsapp').getAttribute('dir')).toBe('ltr');
  });
});

describe('the current-rate hint (M6)', () => {
  it('in Arabic, "1 CNY = 7.06" is one isolated left-to-right run', () => {
    arabic(<p data-testid="hint"><CurrentRateHint currency="CNY" rate={7.06} /></p>);
    const run = screen.getByTestId('hint').querySelector('bdi')!;
    expect(run).not.toBeNull();
    expect(run.getAttribute('dir')).toBe('ltr');
    expect(run.textContent).toBe('1 CNY = 7.06');
    // The Arabic words stay outside it, in the sentence's own direction.
    expect(screen.getByTestId('hint').textContent).toBe('السعر الحالي: 1 CNY = 7.06 جنيه');
  });

  it('in English the same run, the same words', async () => {
    const en = (await import('@/i18n/locales/en.json')).default;
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <p data-testid="hint"><CurrentRateHint currency="AED" rate="13.85" /></p>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('hint').querySelector('bdi[dir="ltr"]')?.textContent).toBe('1 AED = 13.85');
    expect(screen.getByTestId('hint').textContent).toBe('Current rate: 1 AED = 13.85 EGP');
  });
});
