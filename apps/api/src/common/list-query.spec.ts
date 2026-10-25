/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-member-access -- a stand-in for Prisma answers loosely-shaped query objects */
import { HttpException } from '@nestjs/common';
import {
  filterOf,
  listRows,
  pageOf,
  pageOfIds,
  type RowWindow,
  searchOf,
  SEARCH_MAX,
  sortOf,
} from './list-query';

/**
 * Search, filters, sorting and pages on the server (owner 2026-10-25): the
 * one definition every office list reads its query through. These pin what a
 * list may ask for, what is refused (with a code, never a 500), and that a
 * page is the page asked for.
 */

/** The code a refusal carries, or 'none' when the call did not throw. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (e) {
    const body = (e as HttpException).getResponse() as { code: string };
    return body.code;
  }
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('pageOf — the page a list asked for', () => {
  it('no page and no page size: the caller walks cursors (a picker, the export)', () => {
    expect(pageOf({})).toBeNull();
    expect(pageOf({ page: '', pageSize: '' })).toBeNull();
  });

  it('page 3 of 10 skips the first 20 rows', () => {
    expect(pageOf({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
      skip: 20,
      take: 10,
    });
  });

  it('a page without a size gets the list size (10); a size without a page is page 1', () => {
    expect(pageOf({ page: '2' })).toMatchObject({ pageSize: 10, skip: 10 });
    expect(pageOf({ pageSize: '25' })).toMatchObject({ page: 1, skip: 0 });
  });

  it.each(['0', '-1', '1.5', 'abc', '1e3', ' '])(
    'page "%s" is refused, not read as page 1',
    (page) => {
      expect(codeOf(() => pageOf({ page }))).toBe('LIST_PAGE_INVALID');
    },
  );

  it.each(['0', '201', '-5', 'ten', '2.5'])(
    'page size "%s" is refused (1 to 200)',
    (pageSize) => {
      expect(codeOf(() => pageOf({ page: '1', pageSize }))).toBe(
        'LIST_PAGE_SIZE_INVALID',
      );
    },
  );

  it('the largest page, 200, is allowed', () => {
    expect(pageOf({ page: '1', pageSize: '200' })?.take).toBe(200);
  });
});

describe('searchOf — what was typed', () => {
  it('trimmed; nothing typed is no search', () => {
    expect(searchOf({ search: '  helmet ' })).toBe('helmet');
    expect(searchOf({})).toBe('');
    expect(searchOf({ search: '   ' })).toBe('');
  });

  it(`more than ${SEARCH_MAX} characters is refused`, () => {
    expect(codeOf(() => searchOf({ search: 'x'.repeat(SEARCH_MAX) }))).toBe(
      'none',
    );
    expect(codeOf(() => searchOf({ search: 'x'.repeat(SEARCH_MAX + 1) }))).toBe(
      'LIST_SEARCH_TOO_LONG',
    );
  });

  it('a search sent twice (?search=a&search=b arrives as an array) is refused', () => {
    expect(codeOf(() => searchOf({ search: ['a', 'b'] }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('sortOf — the order a list asked for', () => {
  const sorts = { newest: ['n'], balance: ['b'] };

  it('the first order is the default', () => {
    expect(sortOf({}, sorts)).toEqual({ key: 'newest', orderBy: ['n'] });
  });

  it('a named order is used', () => {
    expect(sortOf({ sort: 'balance' }, sorts).orderBy).toEqual(['b']);
  });

  it('an order the list does not offer is refused, not silently ignored', () => {
    expect(codeOf(() => sortOf({ sort: 'password' }, sorts))).toBe(
      'LIST_SORT_UNKNOWN',
    );
    expect(codeOf(() => sortOf({ sort: 'constructor' }, sorts))).toBe(
      'LIST_SORT_UNKNOWN',
    );
  });
});

describe('filterOf — a filter from the values a list offers', () => {
  const statuses = ['PAID', 'DRAFT'] as const;

  it('absent is no filter; an offered value is the filter', () => {
    expect(filterOf(undefined, 'status', statuses)).toBeUndefined();
    expect(filterOf('', 'status', statuses)).toBeUndefined();
    expect(filterOf('PAID', 'status', statuses)).toBe('PAID');
  });

  it('anything else is refused before it reaches Postgres as an enum it cannot cast', () => {
    expect(codeOf(() => filterOf('paid', 'status', statuses))).toBe(
      'LIST_FILTER_INVALID',
    );
    expect(codeOf(() => filterOf(['PAID'], 'status', statuses))).toBe(
      'LIST_FILTER_INVALID',
    );
  });
});

describe('listRows — one page and its count', () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({
    id: uuid(i + 1),
    n: i + 1,
  }));
  const fake = () => {
    const calls: any[] = [];
    return {
      calls,
      read: {
        count: async () => {
          calls.push(['count']);
          return rows.length;
        },
        rows: async (window: RowWindow) => {
          calls.push(['rows', window]);
          const start = window.skip ?? 0;
          return rows.slice(start, start + window.take);
        },
      },
    };
  };

  it('page 3 of 10 is rows 21–23, with the count of every match and the pages', async () => {
    const { read, calls } = fake();
    const out = await listRows({ page: '3', pageSize: '10' }, read);
    expect(out.rows.map((r) => r.n)).toEqual([21, 22, 23]);
    expect(out.meta).toEqual({
      page: 3,
      pageSize: 10,
      total: 23,
      totalPages: 3,
      nextCursor: null,
    });
    expect(calls.find((c) => c[0] === 'rows')[1]).toEqual({
      skip: 20,
      take: 10,
    });
    expect(calls.some((c) => c[0] === 'count')).toBe(true);
  });

  it('a page past the end is empty, and still says how many there are', async () => {
    const { read } = fake();
    const out = await listRows({ page: '9' }, read);
    expect(out.rows).toEqual([]);
    expect(out.meta.total).toBe(23);
  });

  it('without a page it walks cursors as before, and counts nothing', async () => {
    const { read, calls } = fake();
    const out = await listRows({ limit: '20' }, read);
    expect(out.rows).toHaveLength(20);
    expect(out.meta.nextCursor).toBe(uuid(20));
    expect(calls.some((c) => c[0] === 'count')).toBe(false);
  });
});

describe('pageOfIds — a page of an order the database cannot express', () => {
  const ids = Array.from({ length: 12 }, (_, i) => uuid(i + 1));

  it('page 2 of 5 is the 6th to the 10th, with the total', () => {
    const { pageIds, meta } = pageOfIds(ids, { page: '2', pageSize: '5' });
    expect(pageIds).toEqual(ids.slice(5, 10));
    expect(meta).toMatchObject({ total: 12, totalPages: 3 });
  });

  it('cursors walk every id once, in order', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { pageIds, meta } = pageOfIds(ids, {
        limit: '5',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...pageIds);
      cursor = meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  it('a cursor that is not an id is refused', () => {
    expect(codeOf(() => pageOfIds(ids, { cursor: 'abc' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
