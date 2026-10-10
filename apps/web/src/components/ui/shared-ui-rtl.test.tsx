import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Wallet } from 'lucide-react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { Money } from './money';
import { Select } from './select';
import { CustomerLink } from './entity-link';
import { EmptyState } from './empty-state';
import { StatTile } from '../dashboard/stat-tile';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ locale: 'ar' }) }));

beforeAll(() => {
  // cmdk and Radix measure and scroll things jsdom does not lay out.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const ARABIC_INDIC = /[٠-٩٫٬]/;

function show(locale: 'en' | 'ar', ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{ui}</div>
    </NextIntlClientProvider>,
  );
}

describe('Money (finding #14)', () => {
  it('in Arabic shows Latin digits, the minus before the number and the currency after', () => {
    const { container } = show('ar', <Money value={-529.23} />);
    const el = container.querySelector('[data-slot="money"]')!;
    expect(el.textContent).toBe('-529.23 EGP');
    expect(el.textContent).not.toMatch(ARABIC_INDIC);
    // An LTR isolate, so the RTL paragraph cannot move the sign to the far end.
    expect(el.getAttribute('dir')).toBe('ltr');
    expect((el as HTMLElement).style.unicodeBidi).toBe('isolate');
  });

  it('reads the same in both languages, including a large negative', () => {
    const ar1 = show('ar', <Money value={-1234567.891} currency="USD" />).container.textContent;
    cleanup();
    const en1 = show('en', <Money value={-1234567.891} currency="USD" />).container.textContent;
    expect(ar1).toBe('-1,234,567.89 USD');
    expect(en1).toBe(ar1);
  });

  it('a string amount and a missing one', () => {
    expect(show('ar', <Money value="1500" />).container.textContent).toBe('1,500.00 EGP');
    cleanup();
    expect(show('ar', <Money value={undefined} />).container.textContent).toBe('0.00 EGP');
    cleanup();
    expect(show('ar', <Money value="abc" />).container.textContent).toBe('—');
  });
});

describe('StatTile (finding #38)', () => {
  const tile = (value: string | number) =>
    show('ar', <StatTile label="x" value={value} icon={Wallet} color="bg-primary" href={null} testId="t" />);

  it('a money string from the caller renders through Money: number first, Latin digits', () => {
    // The dashboard formats with the browser's locale; an Arabic browser gives this.
    tile('؜-٥٢٩٫٢٣ EGP');
    const money = screen.getByTestId('t').querySelector('[data-slot="money"]');
    expect(money?.textContent).toBe('-529.23 EGP');
  });

  it('a Latin money string is shown in the same order as Money elsewhere', () => {
    tile('1,234.00 EGP');
    expect(screen.getByTestId('t').querySelector('[data-slot="money"]')?.textContent).toBe('1,234.00 EGP');
  });

  it('a count stays a count, in Latin digits, without a currency', () => {
    tile('١٢');
    expect(screen.getByTestId('t').querySelector('[data-slot="money"]')).toBeNull();
    expect(screen.getByTestId('t').textContent).toContain('12');
    cleanup();
    tile(1284);
    expect(screen.getByTestId('t').textContent).toContain('1,284');
  });

  it('text that is not a figure is left as it is', () => {
    tile('—');
    expect(screen.getByTestId('t').textContent).toContain('—');
    expect(screen.getByTestId('t').querySelector('[data-slot="money"]')).toBeNull();
  });
});

describe('Select isolates Latin text inside Arabic (finding #21)', () => {
  const options = [
    { value: 'a', label: 'Guangzhou Trading Co.', hint: 'SKU-001' },
    { value: 'b', label: 'شركة النيل' },
    { value: 'c', label: 'Delta Motors Ltd.' },
    { value: 'd', label: 'Cairo Parts' },
  ];

  it('the chosen label sits in a <bdi>, so its own direction decides truncation', () => {
    show('ar', <Select options={options} defaultValue="a" />);
    const value = screen.getByRole('combobox').querySelector('[data-slot="select-value"]')!;
    expect(value.tagName).toBe('BDI');
    expect(value.textContent).toBe('Guangzhou Trading Co.');
    expect(value.className).toContain('truncate');
  });

  it('every option label and hint is isolated too', () => {
    show('ar', <Select options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    for (const o of options) {
      const label = screen.getByText(o.label);
      expect(label.tagName).toBe('BDI');
    }
    expect(screen.getByText('SKU-001').tagName).toBe('BDI');
  });

  it('the placeholder is translated rather than English in an Arabic form', () => {
    show('ar', <Select options={options} />);
    expect(screen.getByRole('combobox').textContent).toContain(ar.common.selectPlaceholder);
  });
});

describe('the shared empty slot is EmptyState (finding #32)', () => {
  const options = ['One', 'Two', 'Three', 'Four'].map((l) => ({ value: l, label: l }));

  it("a picker's no-match slot renders EmptyState with the translated text", () => {
    show('ar', <Select options={options} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.change(document.querySelector('[cmdk-input]')!, { target: { value: 'zzzz' } });
    const empty = document.querySelector('[data-slot="empty-state"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe(ar.common.noOptionsMatch);
    expect(empty?.getAttribute('data-size')).toBe('compact');
  });

  it("a caller's own empty text still wins", () => {
    show('en', <Select options={options} emptyText="No cycles" />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.change(document.querySelector('[cmdk-input]')!, { target: { value: 'zzzz' } });
    expect(document.querySelector('[data-slot="empty-state"]')?.textContent).toBe('No cycles');
  });

  it('compact and default are one component with one structure', () => {
    show('en', (
      <>
        <EmptyState title="A" />
        <EmptyState title="B" size="compact" />
      </>
    ));
    const [big, small] = Array.from(document.querySelectorAll('[data-slot="empty-state"]'));
    expect(big.getAttribute('data-size')).toBe('default');
    expect(small.getAttribute('data-size')).toBe('compact');
    expect(big.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(small.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });
});

describe('list-row names are isolated (finding #21)', () => {
  it('a linked and an unlinked customer name both sit in <bdi>', () => {
    show('ar', (
      <>
        <CustomerLink id="c1" name="Delta Motors Co." />
        <CustomerLink name="Nile Parts Ltd." />
      </>
    ));
    expect(screen.getByText('Delta Motors Co.').tagName).toBe('BDI');
    expect(screen.getByText('Nile Parts Ltd.').tagName).toBe('BDI');
  });
});
