/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- a stand-in for Prisma's $queryRaw */
import { searchIds } from './list-search';

/**
 * A list's search, in SQL (server-side lists, owner 2026-10-25): every list
 * compares the search key of what was typed with `arabic_search_key()` of
 * its columns, so ة/ه, ى/ي, أ/ا and the vowel marks never decide a match.
 */
const capture = () => {
  const sent: { sql: string; values: unknown[] }[] = [];
  const db = {
    $queryRaw: ((query: any) => {
      sent.push({ sql: query.sql, values: query.values });
      return Promise.resolve([
        { id: '00000000-0000-4000-8000-000000000001' },
      ]) as any;
    }) as any,
  };
  return { db, sent };
};

describe('searchIds — the Arabic-forgiving search, in SQL', () => {
  it('compares the search key of what was typed: خُوذة is sent as خوذه', async () => {
    const { db, sent } = capture();
    const ids = await searchIds(db, 'products t', ['t.name'], 'خُوذة');
    expect(ids).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(sent[0].values).toEqual(['خوذه']);
    expect(sent[0].sql).toContain('strpos(arabic_search_key(t.name), ?) > 0');
  });

  it('every column is searched; the term is a parameter, never pasted into the SQL', async () => {
    const { db, sent } = capture();
    await searchIds(
      db,
      'suppliers t',
      ['t.name', "t.contact_json->>'phone'"],
      "x'); DROP TABLE suppliers; --",
    );
    expect(sent[0].sql).not.toContain('DROP');
    expect(sent[0].sql.match(/arabic_search_key/g)).toHaveLength(2);
    expect(sent[0].sql).toContain('FROM suppliers t WHERE');
  });

  it('a search of nothing but vowel marks matches nothing and asks the database nothing', async () => {
    const { db, sent } = capture();
    expect(await searchIds(db, 'products t', ['t.name'], 'ُ')).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('SQL with a statement separator or a comment is refused before it is sent', async () => {
    const { db, sent } = capture();
    await expect(
      searchIds(db, 'products t; DELETE FROM products', ['t.name'], 'x'),
    ).rejects.toThrow(/not a table or column/);
    await expect(
      searchIds(db, 'products t', ['t.name -- x'], 'x'),
    ).rejects.toThrow(/not a table or column/);
    expect(sent).toHaveLength(0);
  });
});
