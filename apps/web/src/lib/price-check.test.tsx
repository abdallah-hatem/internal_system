import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePriceCheck, type PriceCheckItem } from './price-check';

/**
 * The hook every below-cost warning reads (BUSINESS_LOGIC §4, 2026-10-11).
 * Found by spec 99-below-cost (TC-BC-07): a product's price field going from
 * empty to 850 was first checked at a price of 0 — the lines from before the
 * field settled — and a loss for a price nobody typed was shown.
 */

const post = vi.fn((_path: string, body: { items: PriceCheckItem[] }) =>
  Promise.resolve({
    data: {
      data: {
        currency: 'EGP',
        compared: true,
        lines: body.items.map((_, i) => ({ line: i + 1, productId: 'p', costed: true, belowCost: false, code: null, unitCostEgp: '1.00', unitPriceEgp: '1.00', lossEgp: '0.00' })),
        belowCostLines: 0,
        totalLossEgp: '0.00',
      },
    },
  }),
);
vi.mock('@/lib/api', () => ({ api: { post: (path: string, body: never) => post(path, body) } }));

afterEach(() => {
  cleanup();
  post.mockClear();
});

function Probe({ price, enabled }: { price: string; enabled: boolean }) {
  usePriceCheck([{ productId: 'p', quantity: 1, unitPrice: enabled ? price : 0 }], 'EGP', { enabled });
  return null;
}

function mount() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <Probe price="" enabled={false} />
    </QueryClientProvider>,
  );
  return {
    set: (price: string, enabled: boolean) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Probe price={price} enabled={enabled} />
        </QueryClientProvider>,
      ),
  };
}

describe('usePriceCheck', () => {
  it('nothing is asked while the check is off', async () => {
    mount();
    await new Promise((r) => setTimeout(r, 400));
    expect(post).not.toHaveBeenCalled();
  });

  it('a price typed into an empty field is asked about at that price — never at the empty one', async () => {
    const { set } = mount();
    set('850', true);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls.map(([, body]) => body.items[0].unitPrice)).toEqual([850]);
  });

  it('typing quickly asks once, about where it stopped', async () => {
    const { set } = mount();
    set('8', true);
    set('85', true);
    set('850', true);
    await waitFor(() => expect(post).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 400));
    expect(post.mock.calls.map(([, body]) => body.items[0].unitPrice)).toEqual([850]);
  });
});
