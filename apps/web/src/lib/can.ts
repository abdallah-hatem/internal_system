'use client';

import { useAuth } from './auth-context';
import { can, type Action } from './permissions';

export type { Action } from './permissions';

/**
 * The role to draw the screen for.
 *
 * The session is read from storage after the first paint (the server has no
 * storage), so for that moment nobody is signed in and every partner-only
 * button and menu item vanished on a refresh, then came back (owner,
 * 2026-10-15). Until it is read, draw for a core partner, the role every login
 * the business has today carries; once it is known, the real role decides. The
 * screen only mirrors permissions — the API refuses whoever may not, either way.
 */
export const ROLE_BEFORE_SESSION_IS_READ = 'CORE_PARTNER';

export function useDrawnRole(): string | undefined {
  const { user, isLoading } = useAuth();
  return isLoading ? ROLE_BEFORE_SESSION_IS_READ : user?.role;
}

/** Whether the signed-in person may take `action` — see `lib/permissions.ts`. */
export function useCan(action: Action): boolean {
  return can(useDrawnRole(), action);
}
