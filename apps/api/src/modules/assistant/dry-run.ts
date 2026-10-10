import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';

/**
 * A preview made by the write itself, rolled back.
 *
 * Some services have no `plan…` method that checks everything a write checks
 * without writing — recording a delivery is one. Writing a second copy of its
 * rules here so the assistant could preview would be a second definition of
 * them (CLAUDE.md rule 11): the day the service gains a check, the preview
 * would not.
 *
 * So the preview runs the service's own write against this stand-in for the
 * database. Every query passes straight through; the one difference is that
 * the service's transaction, once its callback has finished every check and
 * every insert, is made to fail. Postgres rolls it back, nothing is kept, and
 * `inspect` — run inside that transaction, after the write — reads what the
 * write would have left behind, which is the preview.
 *
 * The failure is thrown on out of the service, so nothing it would do after
 * its transaction commits (a notification, say) ever runs.
 */
export class DryRunFinished<T> extends Error {
  constructor(readonly seen: T) {
    super('dry run: rolled back on purpose');
  }
}

type Tx = Prisma.TransactionClient;

export function rollingBack<T>(
  prisma: PrismaService,
  inspect: (tx: Tx) => Promise<T>,
): PrismaService {
  const transaction = (fn: unknown, options?: unknown) => {
    if (typeof fn !== 'function') {
      // The batch form takes ready-made queries and has no point at which to
      // look before it commits. Nothing previewed this way uses it.
      throw new Error('rollingBack only supports interactive transactions');
    }
    const run = fn as (tx: Tx) => Promise<unknown>;
    return prisma.$transaction(
      async (tx) => {
        await run(tx);
        throw new DryRunFinished(await inspect(tx));
      },
      options as Parameters<PrismaService['$transaction']>[1],
    );
  };

  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === '$transaction') return transaction;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Runs `write` against `rollingBack`'s database and returns what `inspect`
 * saw. A refusal from the write is thrown as it is; a write that never reached
 * its transaction is a bug, not a preview.
 */
export async function previewByRollback<T>(
  write: () => Promise<unknown>,
): Promise<T> {
  try {
    await write();
  } catch (err) {
    if (err instanceof DryRunFinished) return err.seen as T;
    throw err;
  }
  throw new Error('dry run finished without reaching its transaction');
}
