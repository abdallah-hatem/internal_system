import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import PartnersView from './partners-view';

/**
 * The Partners tab drew its running-costs section twice on a fresh load: once
 * while the partners loaded and again, in another place, when they arrived.
 * React mounted it a second time, which closed a period picker a partner had
 * already opened (BUILD_LOG "Known e2e debt", 2026-10-19). One slot now.
 */

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/partners/running-costs-section', async () => {
  const { useEffect } = await import('react');
  return {
    RunningCostsSection: () => {
      useEffect(() => {
        mounts.count += 1;
      }, []);
      return <section data-testid="running-costs" />;
    },
  };
});

const reply = vi.hoisted(() => ({ resolve: (_: unknown) => {} }));
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(
      () =>
        new Promise((resolve) => {
          reply.resolve = resolve;
        }),
    ),
  },
}));

const PARTNER = {
  id: 'p1',
  email: 'abdallah@x.test',
  displayName: 'Abdallah',
  role: 'CORE_PARTNER',
  contributedEgp: 1000,
  profitShareEgp: 100,
  accruedProfitEgp: 0,
  atRiskEgp: 0,
  runningCostsEgp: 0,
  cycles: [],
};

afterEach(() => {
  cleanup();
  mounts.count = 0;
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <PartnersView />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('the running-costs section on the Partners tab', () => {
  it('is mounted once: the same section while the partners load and after they arrive', async () => {
    renderView();
    expect(screen.getAllByTestId('running-costs')).toHaveLength(1);
    expect(mounts.count).toBe(1);

    await act(async () => reply.resolve({ data: { data: [PARTNER] } }));
    await screen.findByText('Abdallah');
    expect(screen.getAllByTestId('running-costs')).toHaveLength(1);
    expect(mounts.count).toBe(1);
  });

  it('is not shown once loaded with no partner at all', async () => {
    renderView();
    await act(async () => reply.resolve({ data: { data: [] } }));
    await vi.waitFor(() => expect(screen.queryByTestId('running-costs')).toBeNull());
  });
});
