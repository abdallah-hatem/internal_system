import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { cachedListRow } from './server-list';

/**
 * A detail screen reads a row from the list it was opened from before its own
 * request answers: the cycle page draws a UAE cycle's four places or a China
 * one's six. Since the lists moved to the server (2026-10-26) the pages are
 * cached under `[entity, path, params]` with `{ data: rows }`, and the cycle
 * page still read the exact key `['cycles']` — found nothing, and traced six
 * places for every cycle (e2e TC-SKEL-09, 2026-10-28).
 */
describe('cachedListRow', () => {
  const client = () => {
    const c = new QueryClient();
    c.setQueryData(['cycles', '/cycles', { page: 1, pageSize: 10 }], {
      data: [{ id: 'a', originType: 'CHINA' }],
      meta: { total: 12 },
    });
    c.setQueryData(['cycles', '/cycles', { page: 2, pageSize: 10, search: 'CYC' }], {
      data: [{ id: 'b', originType: 'UAE_DIRECT' }],
    });
    c.setQueryData(['sales', '/sales/orders', { page: 1 }], { data: [{ id: 'c', originType: 'UAE_DIRECT' }] });
    return c;
  };

  it('finds the row on any cached page of that list', () => {
    const c = client();
    expect(cachedListRow<{ id: string; originType: string }>(c, 'cycles', 'b')?.originType).toBe('UAE_DIRECT');
    expect(cachedListRow<{ id: string; originType: string }>(c, 'cycles', 'a')?.originType).toBe('CHINA');
  });

  it('the exact key the cycle page used to read holds no page at all', () => {
    expect(client().getQueryData(['cycles'])).toBeUndefined();
  });

  it('never answers from another list, and says nothing for a row it has not seen', () => {
    const c = client();
    expect(cachedListRow(c, 'cycles', 'c')).toBeUndefined();
    expect(cachedListRow(c, 'cycles', 'zzz')).toBeUndefined();
    expect(cachedListRow(new QueryClient(), 'cycles', 'a')).toBeUndefined();
  });
});
