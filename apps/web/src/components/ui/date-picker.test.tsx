import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import { Calendar, DatePicker } from './date-picker';

function wrap(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      {ui}
    </NextIntlClientProvider>,
  );
}

const day = (iso: string) => document.querySelector<HTMLButtonElement>(`[data-day="${iso}"]`)!;

// 23:30 UTC on 15 Dec is 01:30 on 16 Dec in Cairo (UTC+2 in winter). The test
// machine runs in UTC (vitest.config), so its local day is still the 15th —
// a picker reading the browser's clock would get the boundary wrong by a day.
const CLOCK = new Date('2026-12-15T23:30:00Z');

describe('Calendar disableFuture — Cairo midnight boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CLOCK);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("enables Cairo's today and disables Cairo's tomorrow, though the local day is a day earlier", () => {
    wrap(<Calendar selected={null} onSelect={() => {}} disableFuture />);
    expect(day('2026-12-15').disabled).toBe(false);
    expect(day('2026-12-16').disabled).toBe(false); // Cairo's today
    expect(day('2026-12-17').disabled).toBe(true); // Cairo's tomorrow
    expect(day('2026-12-16').getAttribute('aria-current')).toBe('date');
  });

  it('keeps an earlier max when both are given', () => {
    wrap(<Calendar selected={null} onSelect={() => {}} disableFuture max={new Date(2026, 11, 10)} />);
    expect(day('2026-12-10').disabled).toBe(false);
    expect(day('2026-12-11').disabled).toBe(true);
  });

  it('ignores a later max — the future is still refused', () => {
    wrap(<Calendar selected={null} onSelect={() => {}} disableFuture max={new Date(2027, 0, 31)} />);
    expect(day('2026-12-17').disabled).toBe(true);
  });

  it('a disabled future day cannot be picked by clicking', () => {
    const onSelect = vi.fn();
    wrap(<Calendar selected={null} onSelect={onSelect} disableFuture />);
    fireEvent.click(day('2026-12-17'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('without disableFuture, future days stay enabled (existing pickers unchanged)', () => {
    wrap(<Calendar selected={null} onSelect={() => {}} />);
    expect(day('2026-12-17').disabled).toBe(false);
    expect(day('2026-12-31').disabled).toBe(false);
  });

  it('"Today" in a disableFuture picker sets Cairo\'s day, not the browser\'s', () => {
    const onChange = vi.fn();
    wrap(<DatePicker name="d" onChange={onChange} disableFuture />);
    fireEvent.click(screen.getByRole('button', { name: en.common.pickDate }));
    fireEvent.click(screen.getByTestId('date-picker-today'));
    expect(onChange).toHaveBeenCalledWith('2026-12-16');
  });

  it('"Today" without disableFuture keeps the old local-day behaviour', () => {
    const onChange = vi.fn();
    wrap(<DatePicker name="d" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: en.common.pickDate }));
    fireEvent.click(screen.getByTestId('date-picker-today'));
    expect(onChange).toHaveBeenCalledWith('2026-12-15');
  });
});
