import { badRequest } from './api-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids here are UUID columns. Asking Postgres for `'abc'` fails the cast deep in
 * Prisma and surfaces as a 500 — "An unexpected error occurred", which tells
 * nobody anything (CLAUDE.md rule 1). Check the shape before the query.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Refuses an id that cannot be one, in the code the DTOs use. */
export function assertUuid(
  value: unknown,
  field: string,
): asserts value is string {
  if (!isUuid(value)) {
    throw badRequest('VALIDATION_FAILED', `${field} must be a UUID`, {
      fields: field,
    });
  }
}
