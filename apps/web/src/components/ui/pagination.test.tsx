import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { Pagination } from './pagination';

afterEach(cleanup);

function renderIn(locale: 'en' | 'ar', props: Partial<Parameters<typeof Pagination>[0]> = {}) {
  const onPageChange = vi.fn();
  const view = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <Pagination page={2} totalPages={2} totalItems={17} onPageChange={onPageChange} {...props} />
      </div>
    </NextIntlClientProvider>,
  );
  return { ...view, onPageChange };
}

describe('Pagination (UI audit 2026-10-10 #7, #8)', () => {
  it('says the range in Arabic, with Latin digits, and no English left over', () => {
    const { container } = renderIn('ar');
    const text = container.querySelector('p')!.textContent!;
    expect(text).toBe('عرض 11 – 17 من 17');
    expect(text).not.toMatch(/Showing|of/);
  });

  it('says the range in English', () => {
    const { container } = renderIn('en', { page: 1 });
    expect(container.querySelector('p')!.textContent).toBe('Showing 1 – 10 of 17');
  });

  it('mirrors both chevrons under RTL, so "previous" points to the start side', () => {
    renderIn('ar');
    for (const id of ['pagination-prev-icon', 'pagination-next-icon']) {
      expect(screen.getByTestId(id).getAttribute('class')).toContain('rtl:rotate-180');
    }
  });

  it('names the arrow buttons in the reader\'s language', () => {
    renderIn('ar');
    expect(screen.getByRole('button', { name: 'الصفحة السابقة' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'الصفحة التالية' })).toBeTruthy();
  });

  it('cannot go past the last page or before the first', () => {
    const last = renderIn('en', { page: 2 });
    const next = screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(last.onPageChange).not.toHaveBeenCalled();
    cleanup();
    renderIn('en', { page: 1 });
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing for a single page', () => {
    const { container } = renderIn('en', { page: 1, totalPages: 1, totalItems: 3 });
    expect(container.querySelector('p')).toBeNull();
  });
});
