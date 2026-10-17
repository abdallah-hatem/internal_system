import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh tokens, the assistant's and the office's, are made and stored the
 * same way: 256 random bits handed out once, and only their hash kept. One
 * definition, so the two cannot drift into different strengths.
 */

/** A fresh token: 256 random bits, handed out once and never stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored in its place. A leaked table yields no usable token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
