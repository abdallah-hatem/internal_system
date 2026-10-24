/**
 * Whether this is a touch screen with no mouse — a phone or tablet, the
 * installed app and the website alike, in either orientation. Read at the
 * moment it matters (a picker opening). The office app has the same rule in
 * apps/web/src/lib/use-phone.ts.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

export function isTouchScreen(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(TOUCH_QUERY).matches;
}
