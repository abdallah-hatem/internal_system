import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { cycleTimeline, type TimelineInput } from '../../../../api/src/common/cycle-timeline';
import { TimelineCard, type TimelineView } from './timeline-card';

/**
 * The cycle's Timeline card (BUSINESS_LOGIC §1, owner 2026-11-10). The views
 * are made by the server's own `cycleTimeline` from the days a real cycle
 * holds, so the card is tested on what the API actually sends. Pins what a
 * reader sees: each step's words and date, each length in words, numbered
 * deliveries, the total; that nothing not reached shows a date; that a step
 * dated before its predecessor is flagged and never shows a negative; Arabic
 * with Latin digits and nothing left in English; loading, failing, and a
 * timeline that changes after a delivery is recorded.
 */

const state = vi.hoisted(() => ({
  view: null as unknown as TimelineView,
  reads: 0,
  fail: false,
  hang: false,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/cycles/c-1/timeline') {
        state.reads += 1;
        if (state.hang) return new Promise(() => {});
        if (state.fail) return Promise.reject(Object.assign(new Error('boom'), { response: { status: 500 } }));
        return Promise.resolve({ data: { data: state.view } });
      }
      return Promise.resolve({ data: { data: [] } });
    },
  },
}));

const china = (sequence: number, departures: string[], deliveries: string[], complete = deliveries.length > 0) => ({
  sequence,
  ...(sequence === 1
    ? { origin: 'Guangzhou, CN', destination: 'Dubai, UAE' }
    : { origin: 'Dubai, UAE', destination: 'Cairo, Egypt' }),
  departures,
  deliveries,
  waitingToLeave: false,
  complete,
});

function view(over: Partial<TimelineInput>): TimelineView {
  const t = cycleTimeline({
    originType: 'CHINA',
    status: 'PREPARING',
    orderedOn: ['2026-08-01'],
    legs: [],
    receivedOn: [],
    statusChanges: [],
    today: '2026-11-10',
    ...over,
  });
  return { cycleId: 'c-1', code: 'CYC-2026-0002', ...t } as TimelineView;
}

/** China → Dubai → two deliveries in Egypt → received twice → selling. */
const SELLING: Partial<TimelineInput> = {
  status: 'SELLING',
  legs: [china(1, ['2026-08-10'], ['2026-09-05']), china(2, ['2026-09-12'], ['2026-10-01', '2026-10-08'])],
  receivedOn: ['2026-10-02', '2026-10-09'],
  statusChanges: [{ toStatus: 'SELLING', day: '2026-10-02', recorded: true }],
};
/** Left Guangzhou, reached Dubai, on its way to Egypt. */
const IN_TRANSIT: Partial<TimelineInput> = {
  status: 'IN_TRANSIT_TO_EGYPT',
  legs: [china(1, ['2026-08-10'], ['2026-09-05']), china(2, ['2026-09-12'], [], false)],
};

let client: QueryClient;
beforeEach(() => {
  state.view = view(SELLING);
  state.reads = 0;
  state.fail = false;
  state.hang = false;
});
afterEach(cleanup);

function wrap(locale: 'en' | 'ar' = 'en') {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <TimelineCard cycleId="c-1" />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const stepEl = (key: string) => {
  const el = screen.getAllByTestId('timeline-step').find((r) => r.getAttribute('data-step') === key);
  if (!el) throw new Error(`no step ${key}`);
  return el;
};
/** Each line of the summary: what it counts, the total, the two days. */
const summaryLines = () => [...screen.getByTestId('timeline-summary').querySelectorAll('p')].map(text);
const length = (key: string) => text(stepEl(key).querySelector('[data-testid="timeline-length"]'));
const date = (key: string) => text(stepEl(key).querySelector('[data-testid="timeline-date"]'));

describe('TimelineCard — a cycle from China to selling', () => {
  it('says each step, its date and how long it took', async () => {
    wrap();
    await screen.findByTestId('timeline-card');
    expect(text(stepEl('ordered'))).toContain('Ordered');
    expect(date('ordered')).toBe('Aug 1, 2026');
    expect(text(stepEl('leg1-departed-1'))).toContain('Left Guangzhou, CN');
    expect(length('leg1-departed-1')).toBe('9 days after ordering');
    expect(text(stepEl('leg1-delivered-1'))).toContain('Arrived in Dubai, UAE');
    expect(length('leg1-delivered-1')).toBe('26 days on the way');
    expect(text(stepEl('leg2-departed-1'))).toContain('Left Dubai, UAE');
    expect(length('leg2-departed-1')).toBe('waited 7 days');
    expect(text(stepEl('leg2-delivered-1'))).toContain('1st delivery arrived in Cairo, Egypt');
    expect(length('leg2-delivered-1')).toBe('19 days on the way');
    expect(text(stepEl('leg2-delivered-2'))).toContain('2nd delivery arrived in Cairo, Egypt');
    expect(length('leg2-delivered-2')).toBe('+7 days after the 1st');
    expect(stepEl('leg2-delivered-2').querySelector('[data-testid="timeline-all-arrived"]')).not.toBeNull();
    expect(stepEl('leg2-delivered-1').querySelector('[data-testid="timeline-all-arrived"]')).toBeNull();
    expect(text(stepEl('received-first'))).toContain('First received into stock');
    expect(length('received-first')).toBe('1 day after it arrived');
    expect(length('received-last')).toBe('+7 days after the first');
    expect(length('selling')).toBe('the day it was received');
  });

  it('counts order to selling, and how long it has been selling', async () => {
    wrap();
    await screen.findByTestId('timeline-summary');
    expect(summaryLines()).toEqual(['Order to selling', '62 days', 'Aug 1, 2026 →– Oct 2, 2026']);
    expect(text(stepEl('settlement').querySelector('[data-testid="timeline-so-far"]'))).toBe('39 days so far');
    // Only the step under way counts so far.
    expect(screen.getAllByTestId('timeline-so-far')).toHaveLength(1);
  });

  it('marks a status date taken from the audit log, and only that one', async () => {
    wrap();
    await screen.findByTestId('timeline-card');
    expect(screen.getAllByTestId('timeline-recorded').map((el) => el.closest('[data-step]')!.getAttribute('data-step'))).toEqual(['selling']);
    expect(screen.getByTestId('timeline-recorded').getAttribute('title')).toBe(en.cycleTimeline.recordedHint);
  });

  it('in Arabic: every line is translated, with Latin digits, and the places stay as written', async () => {
    wrap('ar');
    const card = await screen.findByTestId('timeline-card');
    expect(text(stepEl('leg2-delivered-2'))).toContain('وصلت التسليمة الثانية إلى Cairo, Egypt');
    expect(length('leg2-delivered-2')).toBe('بعد الأولى بـ7 أيام');
    expect(length('leg1-delivered-1')).toBe('26 يومًا في الطريق');
    expect(length('received-first')).toBe('بعد وصولها بيوم');
    expect(text(screen.getByTestId('timeline-total'))).toBe('62 يومًا');
    // Arabic-Indic digits would mix "62" with "٦٢" on one screen.
    expect(text(card)).not.toMatch(/[٠-٩]/);
    // Nothing English is left once the place names are taken out.
    const words = text(card).replace(/Guangzhou, CN|Dubai, UAE|Cairo, Egypt/g, '');
    expect(words).not.toMatch(/[A-Za-z]{3,}/);
  });
});

describe('TimelineCard — a cycle still on its way', () => {
  beforeEach(() => {
    state.view = view(IN_TRANSIT);
  });

  it('shows the steps to come without dates, and the one under way counts its days', async () => {
    wrap();
    await screen.findByTestId('timeline-card');
    const upcoming = screen.getAllByTestId('timeline-step').filter((r) => r.getAttribute('data-state') === 'UPCOMING');
    expect(upcoming.map((r) => r.getAttribute('data-step'))).toEqual([
      'leg2-delivered-1',
      'received-first',
      'selling',
      'settlement',
      'closed',
    ]);
    for (const row of upcoming) {
      expect(row.querySelector('[data-testid="timeline-date"]')).toBeNull();
      expect(row.querySelector('[data-testid="timeline-length"]')).toBeNull();
    }
    expect(text(stepEl('leg2-delivered-1'))).toContain('Arrive in Cairo, Egypt');
    expect(text(stepEl('leg2-delivered-1'))).toContain('59 days so far');
    expect(summaryLines()).toEqual(['Since the order', '101 days so far', 'Aug 1, 2026 →– today']);
  });

  it('the second time: a delivery recorded refreshes the timeline through the cycle key', async () => {
    wrap();
    await screen.findByTestId('timeline-card');
    expect(state.reads).toBe(1);
    state.view = view({ ...IN_TRANSIT, legs: [IN_TRANSIT.legs![0], china(2, ['2026-09-12'], ['2026-10-01'])] });
    // What the shipment dialogs invalidate after a delivery (SHIPMENT_QUERY_KEYS).
    await act(() => client.invalidateQueries({ queryKey: ['cycle'] }));
    expect(state.reads).toBe(2);
    expect(await screen.findByText('19 days on the way')).toBeTruthy();
    expect(stepEl('leg2-delivered-1').getAttribute('data-state')).toBe('DONE');
  });
});

describe('TimelineCard — the limits', () => {
  it('a delivery dated before its departure is flagged, with its date, and no negative length', async () => {
    state.view = view({ originType: 'UAE_DIRECT', status: 'ARRIVED_EGYPT', legs: [{ ...china(2, ['2026-09-20'], ['2026-09-15']), sequence: 1 }] });
    wrap();
    await screen.findByTestId('timeline-card');
    const row = stepEl('leg1-delivered-1');
    expect(text(row.querySelector('[data-testid="timeline-flag"]'))).toBe(en.cycleTimeline.beforePrevious);
    expect(date('leg1-delivered-1')).toBe('Sep 15, 2026');
    expect(row.querySelector('[data-testid="timeline-length"]')).toBeNull();
    expect(text(screen.getByTestId('timeline-steps'))).not.toMatch(/-\d/);
  });

  it('with nothing ordered there is no total, and it says why', async () => {
    state.view = view({ status: 'PLANNING', orderedOn: [] });
    wrap();
    expect(text(await screen.findByTestId('timeline-no-order'))).toBe(en.cycleTimeline.noOrder);
    expect(screen.queryByTestId('timeline-summary')).toBeNull();
    expect(screen.queryByTestId('timeline-date')).toBeNull();
  });

  it('a cycle entered after the fact says "not recorded" for the steps it skipped', async () => {
    state.view = view({ status: 'SELLING', receivedOn: ['2026-10-02'], statusChanges: [{ toStatus: 'SELLING', day: '2026-10-02', recorded: true }] });
    wrap();
    await screen.findByTestId('timeline-card');
    expect(stepEl('leg1-departed-1').getAttribute('data-state')).toBe('NOT_RECORDED');
    expect(text(stepEl('leg1-departed-1'))).toContain(en.cycleTimeline.notRecorded);
  });

  it('a status reached with no date says so rather than showing one', async () => {
    state.view = view({ status: 'SELLING', receivedOn: ['2026-10-02'] });
    wrap();
    await screen.findByTestId('timeline-card');
    expect(text(stepEl('selling').querySelector('[data-testid="timeline-no-date"]'))).toBe(en.cycleTimeline.noDate);
  });

  it('traces the card while loading, and offers a retry when the read fails', async () => {
    state.hang = true;
    wrap();
    expect(screen.getByTestId('timeline-loading')).toBeTruthy();
    expect(screen.getAllByTestId('skeleton-row').length).toBeGreaterThan(0);
    cleanup();

    state.hang = false;
    state.fail = true;
    wrap();
    await screen.findByTestId('timeline-error');
    state.fail = false;
    fireEvent.click(screen.getByRole('button', { name: en.cycleTimeline.retry }));
    expect(await screen.findByTestId('timeline-card')).toBeTruthy();
  });
});
