/**
 * Who is signed in, in a cookie the server can read (owner, 2026-10-15).
 *
 * The session itself (the token) lives in the browser's storage, which the
 * server never sees, so every page used to render first as if nobody were
 * signed in: the account card and every partner-only button vanished on a
 * refresh and came back once the scripts read storage. This cookie carries
 * only what drawing the screen needs — id, email, name, role — so the server
 * renders the signed-in screen from the first paint.
 *
 * It is not a credential and grants nothing: the API authorises every request
 * from the token, so a hand-edited role here changes what is drawn, never what
 * is allowed. Storage stays the source of truth; the provider rewrites or
 * clears this cookie to match it.
 *
 * Imports nothing, so the server layout and the client provider share it.
 */
export const SESSION_COOKIE = 'sf_session_user';

/**
 * Thirty days, rewritten at every sign-in and refresh, so it rolls with the
 * refresh token (BUSINESS_LOGIC §23) and storage ends first.
 */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  displayName?: string | null;
  partner?: { displayName: string };
}

/** Only the fields the screen needs — never the token, never anything else. */
function slim(user: SessionUser): SessionUser {
  const displayName = user.displayName ?? user.partner?.displayName ?? null;
  return { id: user.id, email: user.email, role: user.role, displayName };
}

export function encodeSessionUser(user: SessionUser): string {
  return encodeURIComponent(JSON.stringify(slim(user)));
}

/** A cookie that does not parse into a user is no user, never an error. */
export function decodeSessionUser(raw: string | undefined | null): SessionUser | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw));
    if (
      v &&
      typeof v.id === 'string' &&
      typeof v.email === 'string' &&
      typeof v.role === 'string' &&
      (v.displayName == null || typeof v.displayName === 'string')
    ) {
      return { id: v.id, email: v.email, role: v.role, displayName: v.displayName ?? null };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Browser only: write the cookie for `user`, or clear it for null. */
export function writeSessionCookie(user: SessionUser | null): void {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? ';secure' : '';
  document.cookie = user
    ? `${SESSION_COOKIE}=${encodeSessionUser(user)};path=/;max-age=${MAX_AGE_SECONDS};samesite=lax${secure}`
    : `${SESSION_COOKIE}=;path=/;max-age=0;samesite=lax${secure}`;
}

/** Browser only: the value the cookie holds now, to avoid rewriting it needlessly. */
export function readSessionCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return hit ? hit.slice(SESSION_COOKIE.length + 1) : null;
}
