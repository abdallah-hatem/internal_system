import { Prisma } from '@prisma/client';

/**
 * A write refused by a unique index — Prisma's P2002.
 *
 * For where the database, not a check before the write, is what makes a thing
 * happen once: a supplier's invoice recorded twice at the same moment, an
 * authorization code redeemed twice. A check before the write cannot see a
 * twin that has not committed yet; the index can.
 *
 * Lives here because recognising the error needs Prisma's error class as a
 * value, and value imports of `@prisma/client` belong beside the client.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
