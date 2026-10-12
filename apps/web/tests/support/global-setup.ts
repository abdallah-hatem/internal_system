import { acquireRunLock, assertLocalDatabase, snapshot, resetToSeed } from './database';
import { API_IS_LOCAL, DB_NAME } from './env';

/**
 * Is this run only about the deployed system?
 *
 * `--project=production` audits Neon over HTTPS and never opens a local
 * connection, so snapshotting the developer's Postgres is at best pointless and
 * at worst a hard stop: with Docker down the whole run died in globalSetup on a
 * `pg_dump` for a database nothing was going to read.
 *
 * Read from argv rather than from the config Playwright hands in. `FullConfig`
 * lists every project defined in the file, not the ones selected — measured, it
 * reports ["chromium","production","storefront"] under `--project=production` —
 * so a check against it would have skipped the snapshot for every run.
 */
function productionOnly(): boolean {
  const argv = process.argv.slice(2);
  const chosen: string[] = [];
  argv.forEach((arg, i) => {
    if (arg.startsWith('--project=')) chosen.push(arg.slice('--project='.length));
    else if (arg === '--project' && argv[i + 1]) chosen.push(argv[i + 1]);
  });
  return chosen.length > 0 && chosen.every((name) => name === 'production');
}

/**
 * Is the run aimed somewhere other than the developer's own API?
 *
 * `API_BASE` points the flow suites at the deployed system. Snapshotting and
 * reseeding localhost around a run that never opens it would destroy a
 * morning's data entry to prepare a database nothing was going to read.
 */
function aimedElsewhere(): boolean {
  return !API_IS_LOCAL;
}

/**
 * Give the suite a known starting point without costing the owner their data.
 *
 * Several tests pick "the first confirmed order" or "a batch with stock", which
 * is only deterministic if the database starts the same way each time. Without
 * this the same test passed alone and failed in a full run, and each time that
 * cost a diagnosis before establishing the code was fine.
 */
export default async function globalSetup() {
  if (productionOnly() || aimedElsewhere()) {
    console.log('  [db] not aimed at the local database — it is left untouched');
    return;
  }

  // Only the database DATABASE_URL names (`motorcycle_parts` when unset), and
  // only if it is the local container's. Checked before the lock, so a run
  // aimed at the wrong place stops having touched nothing.
  assertLocalDatabase();
  acquireRunLock();
  const bytes = snapshot();
  console.log(`  [db] ${DB_NAME}: snapshot taken (${(bytes / 1024).toFixed(0)} KB) — restored after the run`);
  resetToSeed();
  console.log(`  [db] ${DB_NAME}: reset to the seeded state`);
}
