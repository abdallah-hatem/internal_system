/**
 * The browser half of web push: the bits that are neither React nor the API.
 *
 * Kept apart from the component because every one of these is a thing a browser
 * either does or lies about, and they are easier to reason about — and to fix
 * when Safari changes its mind again — in one place.
 */

/**
 * The VAPID key travels as base64url in JSON and has to reach
 * `applicationServerKey` as bytes.
 *
 * Passing the string straight through works in Chrome and throws in Firefox,
 * which is the worst of both: it looks fine while it is being built and fails
 * on somebody's phone. base64url swaps two characters of the alphabet and drops
 * the padding, so both go back before `atob` sees it.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);

  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Can this browser do push at all? */
export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Is this an iPhone or an iPad?
 *
 * iPadOS 13 and later report themselves as a Mac, so the user agent alone says
 * no to a device that is one. A Mac has no touch points; an iPad claims five.
 */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Running from the home screen rather than inside Safari's chrome. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  // Safari's own flag, which is the authoritative one on iOS and undefined
  // everywhere else.
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  if (typeof legacy === 'boolean') return legacy;

  return window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * On iOS, Safari gives no push at all until the app is on the home screen.
 *
 * Not a degraded prompt — `Notification.requestPermission()` resolves to
 * `denied` without ever asking, or the constructor is missing entirely. A
 * button here would do nothing, twice, and the shop would conclude the alerts
 * are broken rather than that there is a step to take.
 */
export function needsHomeScreenFirst(): boolean {
  return isIos() && !isStandalone();
}

/** Register `/sw.js` and wait until it is actually controlling the page. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js');
  // `register` resolves before the worker is active, and `pushManager` on a
  // registration that is still installing subscribes into nothing.
  return navigator.serviceWorker.ready;
}

export type SubscriptionKeys = { p256dh: string; auth: string };

/** The two keys the API stores, pulled out of the browser's own JSON. */
export function readKeys(subscription: PushSubscription): SubscriptionKeys | null {
  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) return null;
  return { p256dh: keys.p256dh, auth: keys.auth };
}
