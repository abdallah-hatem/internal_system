/**
 * The guard of the one-off that gives Ahmad Zogmar his branches
 * (prisma/one-off/2026-10-25-ahmad-zogmar-branches.ts): it writes only to a
 * database on this machine, never production, until the owner has confirmed
 * the names and picked the default.
 */
import {
  BRANCHES,
  CUSTOMER_ID,
  localTarget,
} from '../../prisma/one-off/2026-10-25-ahmad-zogmar-branches';

describe("Ahmad Zogmar's branches one-off", () => {
  it('runs against a local database', () => {
    expect(
      localTarget(
        'postgresql://postgres:postgres@localhost:5432/motorcycle_parts_x?schema=public',
      ),
    ).toEqual({ host: 'localhost', db: 'motorcycle_parts_x' });
    expect(localTarget('postgresql://u:p@127.0.0.1:5432/copy').db).toBe('copy');
  });

  it('refuses any database that is not on this machine', () => {
    expect(() =>
      localTarget(
        'postgresql://u:p@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toThrow(/only against a database on this machine/);
    expect(() => localTarget('postgresql://u:p@10.0.0.5:5432/db')).toThrow();
    expect(() => localTarget(undefined)).toThrow(/DATABASE_URL/);
  });

  it('names the customer and the three branches the owner gave', () => {
    expect(CUSTOMER_ID).toBe('ceadced7-457a-4803-9241-3520b6bda1ac');
    expect([...BRANCHES]).toEqual(['Mokattam', 'Master', 'LS2']);
  });
});
