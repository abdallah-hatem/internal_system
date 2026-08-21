import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONTAINER = 'motorcycle_parts_db';
const DB = 'motorcycle_parts';
const SNAPSHOT = '/tmp/motoparts-pretest-snapshot.sql';
const BIG = 256 * 1024 * 1024;

/** Playwright runs from apps/web; the seed script lives in apps/api. */
const API_DIR = path.resolve(process.cwd(), '../api');

function psqlStdin(sql: string) {
  execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=0'],
    { input: sql, encoding: 'utf8', maxBuffer: BIG, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/**
 * Capture the database exactly as the suite found it.
 *
 * The development database is also the test database, so a run must not cost
 * the owner the data they were working with. Restored on the way out.
 */
export function snapshot(): number {
  const dump = execFileSync(
    'docker',
    ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', DB, '--clean', '--if-exists', '--no-owner'],
    { encoding: 'utf8', maxBuffer: BIG },
  );
  writeFileSync(SNAPSHOT, dump);
  return dump.length;
}

export function restoreSnapshot(): boolean {
  if (!existsSync(SNAPSHOT)) return false;
  psqlStdin(readFileSync(SNAPSHOT, 'utf8'));
  return true;
}

/**
 * Empty the working tables and reseed, so every run starts from the same place.
 *
 * Users and reference data are recreated by the seed, so truncating everything
 * is safe. Tests asserting on totals were otherwise reading whatever the last
 * run happened to leave behind.
 */
export function resetToSeed(): void {
  psqlStdin(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', t.tablename);
      END LOOP;
    END $$;
  `);

  execFileSync('npx', ['prisma', 'db', 'seed'], {
    cwd: API_DIR,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
