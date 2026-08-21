import { snapshot, resetToSeed } from './database';

/**
 * Give the suite a known starting point without costing the owner their data.
 *
 * Several tests pick "the first confirmed order" or "a batch with stock", which
 * is only deterministic if the database starts the same way each time. Without
 * this the same test passed alone and failed in a full run, and each time that
 * cost a diagnosis before establishing the code was fine.
 */
export default async function globalSetup() {
  const bytes = snapshot();
  console.log(`  [db] snapshot taken (${(bytes / 1024).toFixed(0)} KB) — restored after the run`);
  resetToSeed();
  console.log('  [db] reset to the seeded state');
}
