import { Prisma } from '@prisma/client';
import { arabicSearchKey } from '../arabic-names';

/**
 * The ids whose text matches a list's search, compared the Arabic-forgiving
 * way (BUSINESS_LOGIC §3, 2026-10-15): أ إ آ as ا, ة as ه, ى as ي, the vowel
 * marks dropped, case ignored — the rule `arabicSearchKey` defines and the
 * database's `arabic_search_key()` mirrors (pinned by 99-arabic-search).
 *
 * Prisma's `contains` cannot fold, so the comparison runs in SQL over `from` —
 * a table aliased `t`, with any joins — and every expression in `columns`. A
 * list then narrows its `where` to `{ id: { in: ids } }` (server-side lists,
 * owner 2026-10-25; `common/list-query.ts`).
 *
 *   searchIds(db, 'suppliers t', ['t.name', "t.contact_json->>'phone'"], term)
 *
 * `from` and `columns` are SQL written in the code that calls this — table
 * and column names, never anything a request sent; only the term is a
 * parameter. A statement separator or a comment in them is refused, so a
 * mistake there cannot become a second statement.
 */
export async function searchIds(
  db: { $queryRaw: <T>(query: Prisma.Sql) => Prisma.PrismaPromise<T> },
  from: string,
  columns: string[],
  term: string,
): Promise<string[]> {
  for (const sql of [from, ...columns]) {
    if (/;|--|\/\*/.test(sql)) {
      throw new Error(`searchIds: not a table or column expression: ${sql}`);
    }
  }
  const key = arabicSearchKey(term);
  if (!key) return [];
  const matches = Prisma.join(
    columns.map(
      (c) =>
        Prisma.sql`strpos(arabic_search_key(${Prisma.raw(c)}), ${key}) > 0`,
    ),
    ' OR ',
  );
  const rows = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT DISTINCT t.id::text AS id FROM ${Prisma.raw(from)} WHERE ${matches}`,
  );
  return rows.map((r) => r.id);
}
