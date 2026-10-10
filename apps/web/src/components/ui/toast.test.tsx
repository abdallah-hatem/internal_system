import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider, useToast } from './toast';

afterEach(cleanup);

function Fire({ message }: { message: string }) {
  const { error } = useToast();
  return <button type="button" onClick={() => error(message)}>fire</button>;
}

function renderToast(message: string) {
  render(
    <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
      <ToastProvider>
        <Fire message={message} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
  act(() => screen.getByText('fire').click());
}

// The classes that apply below `sm` (phones): no breakpoint prefix.
const phoneClasses = () =>
  screen.getByTestId('toast-viewport').className.split(/\s+/).filter((c) => !c.includes(':'));

describe('Toast container on a phone (UI audit 2026-10-10 #3)', () => {
  it('is inset 16px from both sides instead of being the full width plus an offset', () => {
    renderToast('x');
    const cls = phoneClasses();
    expect(cls).toContain('inset-x-4');
    // `w-full` beside an `end-4` offset is 100% + 16px: the start edge falls off screen.
    expect(cls.some((c) => /^w-/.test(c))).toBe(false);
    expect(cls.some((c) => /^(start|end|left|right)-/.test(c))).toBe(false);
  });

  it('lets a long unbroken message wrap inside the toast rather than widen it', () => {
    renderToast('A'.repeat(300));
    const p = screen.getByRole('alert').querySelector('p')!;
    expect(p.className).toContain('min-w-0');
    expect(p.className).toContain('[overflow-wrap:anywhere]');
  });

  it('labels the dismiss button in the reader\'s language', () => {
    renderToast('تعذّر الحفظ');
    expect(screen.getByRole('button', { name: ar.common.close })).toBeTruthy();
  });
});
