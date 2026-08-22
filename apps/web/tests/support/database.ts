import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONTAINER = 'motorcycle_parts_db';
const DB = 'motorcycle_parts';
const SNAPSHOT = '/tmp/motoparts-pretest-snapshot.sql';
/** Kept alongside the live snapshot so a bad run is recoverable by hand. */
const ARCHIVE_DIR = '/tmp/motoparts-snapshots';
const BIG = 256 * 1024 * 1024;

function archive(tag: string) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${ARCHIVE_DIR}/${stamp}-${tag}.sql`;
  copyFileSync(SNAPSHOT, dest);
  return dest;
}

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
  // A snapshot still sitting here means the previous run never reached its
  // teardown. It is the only copy of whatever the database held before that
  // run, and this one is about to truncate and reseed — so overwriting it now
  // would quietly replace real data with the seeded state and leave no way
  // back. Put it back first, then snapshot what that restores.
  //
  // This is not hypothetical: it cost the owner a morning's data entry once,
  // because a failed run left the seeded state behind and the next run
  // snapshotted that.
  if (existsSync(SNAPSHOT)) {
    const kept = archive('unrestored');
    console.log(`  [db] previous run left a snapshot unrestored — restoring it first (kept at ${kept})`);
    restoreSnapshot();
  }

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
 * Restore, then drop the snapshot so its absence means "this run put the
 * database back". While the file exists it is treated as an unfinished run.
 */
export function restoreAndRelease(): boolean {
  if (!existsSync(SNAPSHOT)) return false;
  archive('restored');
  restoreSnapshot();
  rmSync(SNAPSHOT, { force: true });
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
