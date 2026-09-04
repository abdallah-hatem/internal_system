import { restoreAndRelease } from './database';

/**
 * Put the database back exactly as the suite found it.
 *
 * Silent when there is nothing to restore: a production-only run never took a
 * snapshot, and announcing "no snapshot to restore" there reads like something
 * went wrong when nothing did.
 */
export default async function globalTeardown() {
  const restored = restoreAndRelease();
  if (restored) console.log('  [db] snapshot restored');
}
