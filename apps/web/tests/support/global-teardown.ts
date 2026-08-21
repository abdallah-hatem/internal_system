import { restoreSnapshot } from './database';

/** Put the database back exactly as the suite found it. */
export default async function globalTeardown() {
  const restored = restoreSnapshot();
  console.log(restored ? '  [db] snapshot restored' : '  [db] no snapshot to restore');
}
