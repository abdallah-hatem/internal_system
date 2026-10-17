import { randomUUID } from 'node:crypto';

/**
 * An in-memory `session_refresh_tokens` table for specs, shaped like the
 * Prisma calls SessionTokensService makes. Not a test itself (the name keeps
 * it out of jest's pattern and out of the build).
 *
 * `$transaction` rolls back on a throw, as Postgres does, so the race guard
 * in `rotate` is tested against the behaviour it relies on.
 */
export interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
}

type Where = Record<string, unknown>;
const matches = (row: object, where: Where) =>
  Object.entries(where).every(
    ([k, v]) => (row as Record<string, unknown>)[k] === v,
  );

/** Lets the event loop run, as a real database call would. */
const tick = () => new Promise((r) => setImmediate(r));

export function fakeSessionTable() {
  const rows: SessionRow[] = [];

  /**
   * The table's calls. `undo`, when given, records how to take each write
   * back, which is what a transaction needs and nothing else does.
   */
  const calls = (undo?: (() => void)[]) => ({
    findUnique: async ({ where }: { where: Where }) => {
      await tick();
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Partial<SessionRow> }) => {
      await tick();
      if (rows.some((r) => r.tokenHash === data.tokenHash)) {
        throw new Error('unique violation on token_hash');
      }
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
        replacedById: null,
        ...data,
      } as SessionRow;
      rows.push(row);
      undo?.push(() => rows.splice(rows.indexOf(row), 1));
      return { ...row };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Where;
      data: Partial<SessionRow>;
    }) => {
      await tick();
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) {
        const was = { ...r };
        Object.assign(r, data);
        undo?.push(() => Object.assign(r, was));
      }
      return { count: hit.length };
    },
  });

  return {
    rows,
    sessionRefreshToken: calls(),
    /**
     * Wire into a fake db: `$transaction: table.transaction(db)`. Only this
     * transaction's own writes are undone on a throw — a concurrent one's
     * stay, as they would in Postgres.
     */
    transaction:
      (db: object) =>
      async <T>(fn: (tx: object) => Promise<T>): Promise<T> => {
        const undo: (() => void)[] = [];
        try {
          return await fn({ ...db, sessionRefreshToken: calls(undo) });
        } catch (err) {
          undo.reverse().forEach((u) => u());
          throw err;
        }
      },
  };
}
