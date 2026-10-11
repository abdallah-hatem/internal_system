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

/**
 * A preview that must create something before the write it previews can run
 * — a new lender before the payment he made (§18) — rolled back as a whole.
 *
 * `rollingBack` cannot do it: the service reads the lender outside its own
 * transaction, before the point where `inspect` would run. So here the whole
 * rehearsal runs inside one transaction: `run` is handed a database whose
 * every query goes to that transaction and whose `$transaction(fn)` simply
 * runs `fn` in it. Its result is kept and the transaction is then failed on
 * purpose, so nothing it wrote survives.
 *
 * Services handed this database must not call another service that has its
 * own connection (an audit log, a notifier): on a one-connection host that
 * call would wait on the transaction that holds the connection. Pass them
 * stand-ins that do nothing — a preview records no audit and tells nobody.
 */
export async function rehearse<T>(
  prisma: PrismaService,
  run: (db: PrismaService) => Promise<T>,
): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      const nested = new Proxy(tx, {
        get(target, prop) {
          if (prop === '$transaction') {
            return (fn: unknown) => {
              if (typeof fn !== 'function') {
                throw new Error(
                  'rehearse only supports interactive transactions',
                );
              }
              return (fn as (t: Tx) => Promise<unknown>)(target);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as unknown as PrismaService;
      throw new DryRunFinished(await run(nested));
    });
  } catch (err) {
    if (err instanceof DryRunFinished) return err.seen as T;
    throw err;
  }
  throw new Error('rehearsal finished without rolling back');
}
