'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the screen is a phone's: narrower than Tailwind's `sm` (640px), the
 * breakpoint every phone layout in the office app already switches at. For the
 * few places a phone needs different content, not just different classes.
 *
 * It follows the viewport live — rotating the phone or resizing the window
 * re-renders, nothing is fetched again. The server, and a browser with no
 * `matchMedia`, answer "not a phone", so the first paint is the desktop one.
 */
export const PHONE_QUERY = '(max-width: 639.98px)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const list = window.matchMedia(PHONE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

const snapshot = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches;

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/**
 * Whether this is a touch screen with no mouse — a phone or tablet, the
 * installed app (PWA) and the website alike, in either orientation. Read at
 * the moment it matters (a picker opening), so it needs no hook. A browser with
 * no `matchMedia` answers "no": the desktop behaviour.
 */
export const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

export function isTouchScreen(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(TOUCH_QUERY).matches;
}
