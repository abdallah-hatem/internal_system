'use client';

import { Bell, BellOff, Info, LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { useRefusal } from '../requests/use-refusal';
import { HowToAllow } from './how-to-allow';
import {
  needsHomeScreenFirst,
  pushSupported,
  readKeys,
  registerServiceWorker,
  urlBase64ToUint8Array,
} from './push';

/**
 * Alerts on this device.
 *
 * "This device" is the whole point and is said on screen: a subscription
 * belongs to one browser on one phone, so turning alerts on here does nothing
 * for the tablet in the back of the shop, and turning them off does not silence
 * it either.
 *
 * The section renders nothing at all when the API reports no VAPID key. A
 * button that cannot work is worse than no button: it is pressed, nothing
 * happens, and the shop concludes the alerts are broken rather than that they
 * were never switched on at this end.
 *
 * Permission is asked for on the press and never on load. A prompt that appears
 * because a page rendered is the prompt everybody denies, and `denied` is
 * final — the browser will not ask again, and the only way back is a settings
 * screen this app cannot reach.
 */

type Status = 'checking' | 'unsupported' | 'homeScreenFirst' | 'blocked' | 'off' | 'on';

export function Notifications({ pushPublicKey }: { pushPublicKey: string }) {
  const t = useTranslations('account');
  const refusal = useRefusal();

  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    (async () => {
      // Asked before support, deliberately. Safari outside the home screen may
      // have no `PushManager` at all, and answering "this browser cannot show
      // alerts" would be true and useless — there is a step to take, and it is
      // the one thing worth saying here.
      if (needsHomeScreenFirst()) return live && setStatus('homeScreenFirst');
      if (!pushSupported()) return live && setStatus('unsupported');
      if (Notification.permission === 'denied') return live && setStatus('blocked');

      try {
        const registration = await registerServiceWorker();
        const subscription = await registration.pushManager.getSubscription();
        if (live) setStatus(subscription ? 'on' : 'off');
      } catch {
        // The worker failing to register is not something the shop can act on,
        // and it does not mean alerts are impossible. Offer the button.
        if (live) setStatus('off');
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);

    try {
      const registration = await registerServiceWorker();

      // Only when it has never been answered. Calling this on a `granted`
      // browser is harmless but pointless, and on a `denied` one it resolves
      // instantly to `denied` and looks like the button did nothing.
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;

      if (permission === 'denied') {
        setStatus('blocked');
        return;
      }
      if (permission !== 'granted') {
        // Dismissed rather than decided. It can be asked again.
        setError(t('notificationsNotAllowed'));
        return;
      }

      // Reused when it exists: subscribing twice on one browser returns a
      // different endpoint and leaves the first one behind, being pushed to
      // forever by an API that has no way to know it is dead.
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by Chrome, and the honest setting anyway: every push this
          // app sends is one the shop is meant to see.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pushPublicKey),
        }));

      const keys = readKeys(subscription);
      if (!keys) {
        setError(t('notificationsFailed'));
        return;
      }

      await api.post('/portal/push-subscriptions', { endpoint: subscription.endpoint, keys });
      setStatus('on');
    } catch (err) {
      setError(describe(err, refusal, t('notificationsFailed')));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      if (subscription) {
        // The API is told first. Unsubscribing locally and then failing the
        // request leaves a row the server goes on pushing to, from a browser
        // that has already forgotten how to receive it.
        await api.delete('/portal/push-subscriptions', {
          data: { endpoint: subscription.endpoint },
        });
        await subscription.unsubscribe();
      }

      setStatus('off');
    } catch (err) {
      setError(describe(err, refusal, t('notificationsFailed')));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'checking') return null;

  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset">
      <h2 className="text-sm font-semibold text-gray-900">{t('notifications')}</h2>

      {status === 'unsupported' ? (
        <Note>{t('notificationsUnsupported')}</Note>
      ) : status === 'homeScreenFirst' || status === 'blocked' ? (
        /* Instructions, not a refusal.
         *
         * Both of these used to render one sentence and stop, which reads as
         * "you cannot" when what is true is "not yet, and here is how". The
         * steps differ per browser and the button stays underneath: on iOS it
         * is what the person presses once they have opened the installed app,
         * and re-pressing after changing a setting is exactly the last step. */
        <>
          <HowToAllow reason={status === 'blocked' ? 'blocked' : 'install'} />
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            data-push={status}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Bell className="h-4 w-4" aria-hidden />
            )}
            {t('enableNotifications')}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600">
            {status === 'on' ? t('notificationsOn') : t('notificationsIntro')}
          </p>

          <button
            type="button"
            onClick={status === 'on' ? disable : enable}
            disabled={busy}
            data-push={status}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            ) : status === 'on' ? (
              <BellOff className="h-4 w-4" aria-hidden />
            ) : (
              <Bell className="h-4 w-4" aria-hidden />
            )}
            {status === 'on' ? t('turnOffNotifications') : t('enableNotifications')}
          </button>
        </>
      )}

      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-gray-600">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Two kinds of failure reach the catch blocks above and only one of them has
 * anything to say.
 *
 * A refusal from the API is worded, coded and translated, and the shop can act
 * on it. A `DOMException` from `subscribe()` is an English sentence from the
 * browser about a push service; showing it on an Arabic screen would be noise
 * the reader cannot use, so it becomes the one sentence that is true either
 * way.
 */
function describe(
  err: unknown,
  refusal: (err: unknown, fallback?: string) => string,
  fallback: string,
): string {
  const fromApi = Boolean((err as { response?: unknown })?.response);
  return fromApi ? refusal(err, fallback) : fallback;
}
