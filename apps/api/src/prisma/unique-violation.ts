import { Prisma } from '@prisma/client';

/**
 * Any unique-index failure (Prisma's P2002).
 *
 * A write that must happen once — a receipt recorded, a confirmation spent —
 * is made single by an index, not by reading first: two requests can both read
 * "not there yet" before either writes, and only the index sees them both.
 * Callers turn this into their own coded refusal.
 *
 * It does not say which index failed. Postgres reports whichever it checked
 * first, so a caller that needs to know looks the row up instead.
 *
 * Lives here because recognising the error needs Prisma's error class as a
 * value, and value imports of `@prisma/client` belong beside the client.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
