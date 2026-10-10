'use client';

import { useAuth } from './auth-context';
import { can, type Action } from './permissions';

export type { Action } from './permissions';

/** Whether the signed-in person may take `action` — see `lib/permissions.ts`. */
export function useCan(action: Action): boolean {
  const { user } = useAuth();
  return can(user?.role, action);
}
