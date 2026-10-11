import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from './toast';
import { QuickCreate } from './quick-create';

vi.mock('@/lib/api', () => ({
  api: { get: () => Promise.resolve({ data: { data: [] } }), post: vi.fn() },
}));

afterEach(cleanup);

/**
 * Escape on a quick-create dialog (I1, 2026-10-11): it closes the dialog the
 * way Cancel does, and the key goes no further — a form or dialog underneath
 * that also listens for Escape must not hear it and close with everything
 * typed into it.
 */
function OuterThatClosesOnEscape({ onEscape }: { onEscape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);
  return (
    <form data-testid="outer">
      <input name="outer" defaultValue="typed underneath" />
      <QuickCreate entity="provider" onCreated={() => undefined} />
    </form>
  );
}

function renderIt(onEscape = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <OuterThatClosesOnEscape onEscape={onEscape} />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return onEscape;
}

const dialog = () => document.querySelector('[data-quick-create-dialog="provider"]');

describe('quick-create and Escape', () => {
  it('Escape closes the dialog and the outer listener never hears it', () => {
    const outer = renderIt();
    fireEvent.click(document.querySelector('[data-quick-create="provider"]')!);
    expect(dialog()).not.toBeNull();

    fireEvent.keyDown(document.querySelector('[data-quick-create-dialog] input')!, { key: 'Escape' });

    expect(dialog()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect((screen.getByDisplayValue('typed underneath') as HTMLInputElement).value).toBe('typed underneath');
  });

  it('with no dialog open, Escape is left alone for whoever else wants it', () => {
    const outer = renderIt();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('other keys pass through untouched', () => {
    const outer = renderIt();
    fireEvent.click(document.querySelector('[data-quick-create="provider"]')!);
    fireEvent.keyDown(document.querySelector('[data-quick-create-dialog] input')!, { key: 'Enter' });
    expect(dialog()).not.toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it('opening it again after Escape starts empty', () => {
    renderIt();
    fireEvent.click(document.querySelector('[data-quick-create="provider"]')!);
    const name = document.querySelector<HTMLInputElement>('[data-quick-create-dialog] input[name="name"]')!;
    fireEvent.change(name, { target: { value: 'half typed' } });
    fireEvent.keyDown(name, { key: 'Escape' });

    fireEvent.click(document.querySelector('[data-quick-create="provider"]')!);
    expect(
      document.querySelector<HTMLInputElement>('[data-quick-create-dialog] input[name="name"]')!.value,
    ).toBe('');
  });
});
