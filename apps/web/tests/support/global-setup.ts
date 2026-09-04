import { snapshot, resetToSeed } from './database';

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
 * Give the suite a known starting point without costing the owner their data.
 *
 * Several tests pick "the first confirmed order" or "a batch with stock", which
 * is only deterministic if the database starts the same way each time. Without
 * this the same test passed alone and failed in a full run, and each time that
 * cost a diagnosis before establishing the code was fine.
 */
export default async function globalSetup() {
  if (productionOnly()) {
    console.log('  [db] production-only run — the local database is not touched');
    return;
  }

  const bytes = snapshot();
  console.log(`  [db] snapshot taken (${(bytes / 1024).toFixed(0)} KB) — restored after the run`);
  resetToSeed();
  console.log('  [db] reset to the seeded state');
}
