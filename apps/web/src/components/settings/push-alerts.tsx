'use client';

import { Bell, BellOff, Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { useApiError } from '../../lib/api-error';
import { HowToAllow } from './how-to-allow';
import {
  needsHomeScreenFirst,
  pushSupported,
  readKeys,
  registerServiceWorker,
  urlBase64ToUint8Array,
} from '../../lib/push';

/**
 * Alerts on this device, for the office.
 *
 * Ported from the storefront's account screen. The machinery is identical —
 * `PushService` keys subscriptions on a user id and never cared which app was
 * asking — so what differs is only the endpoint and what the alerts are for: a
 * shop asking to buy, or asking for an import, is time-sensitive in a way the
 * bell cannot convey when nobody has the tab open.
 *
 * "This device" is the point and is said on screen: a subscription belongs to
 * one browser on one phone, so turning alerts on here does nothing for the
 * laptop at the desk, and turning them off does not silence it either.
 *
 * The section renders nothing when the API reports no VAPID key. A button that
 * cannot work is worse than no button: it gets pressed, nothing happens, and
 * the office concludes alerts are broken rather than never configured.
 *
 * Permission is asked on the press and never on load. A prompt that appears
 * because a page rendered is the prompt everybody denies, and `denied` is
 * final — the browser will not ask again.
 */
type Status = 'checking' | 'unsupported' | 'homeScreenFirst' | 'blocked' | 'off' | 'on';

export function PushAlerts() {
  const t = useTranslations('push');
  const apiError = useApiError();

  const { data: publicKey } = useQuery({
    queryKey: ['push-key'],
    queryFn: () =>
      api.get('/notifications/push-key').then((r) => r.data.data?.publicKey ?? null),
    staleTime: Infinity,
  });

  const [status, setStatus] = useState<Status>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    (async () => {
      // Asked before support, deliberately. Safari outside the home screen may
      // have no `PushManager` at all, and "this browser cannot show alerts"
      // would be true and useless — there is a step to take.
      if (needsHomeScreenFirst()) return live && setStatus('homeScreenFirst');
      if (!pushSupported()) return live && setStatus('unsupported');
      if (Notification.permission === 'denied') return live && setStatus('blocked');

      try {
        const registration = await registerServiceWorker();
        const subscription = await registration.pushManager.getSubscription();
        if (live) setStatus(subscription ? 'on' : 'off');
      } catch {
        // A worker that fails to register is not something the office can act
        // on, and it does not mean alerts are impossible. Offer the button.
        if (live) setStatus('off');
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  const enable = async () => {
    if (!publicKey) return;
    setBusy(true);
    setError(null);

    try {
      const registration = await registerServiceWorker();

      // Only when it has never been answered. On a `denied` browser this
      // resolves instantly and looks like the button did nothing.
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;

      if (permission === 'denied') {
        setStatus('blocked');
        return;
      }
      if (permission !== 'granted') {
        setError(t('notAllowed'));
        return;
      }

      // Reused when it exists: subscribing twice on one browser returns a new
      // endpoint and leaves the first behind, pushed to forever by an API with
      // no way to know it is dead.
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      const keys = readKeys(subscription);
      if (!keys) {
        setError(t('failed'));
        return;
      }

      await api.post('/notifications/push-subscriptions', {
        endpoint: subscription.endpoint,
        keys,
      });
      setStatus('on');
    } catch (err) {
      setError(describe(err, apiError, t('failed')));
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
        // request leaves a row the server goes on pushing to.
        await api.delete('/notifications/push-subscriptions', {
          data: { endpoint: subscription.endpoint },
        });
        await subscription.unsubscribe();
      }

      setStatus('off');
    } catch (err) {
      setError(describe(err, apiError, t('failed')));
    } finally {
      setBusy(false);
    }
  };

  // Nothing to offer: still checking, or push was never configured on the API.
  if (status === 'checking' || publicKey === null || publicKey === undefined) return null;

  const button = (
    <button
      type="button"
      onClick={status === 'on' ? disable : enable}
      disabled={busy}
      data-push={status}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : status === 'on' ? (
        <BellOff className="h-4 w-4" aria-hidden />
      ) : (
        <Bell className="h-4 w-4" aria-hidden />
      )}
      {status === 'on' ? t('turnOff') : t('turnOn')}
    </button>
  );

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6" data-testid="push-alerts">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">{t('title')}</h2>
      <p className="text-sm text-gray-500 mb-4">{t('deviceScope')}</p>

      <div className="space-y-3">
        {status === 'unsupported' ? (
          <p className="flex items-start gap-2 text-sm text-gray-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden />
            <span>{t('unsupported')}</span>
          </p>
        ) : status === 'homeScreenFirst' || status === 'blocked' ? (
          <>
            <HowToAllow reason={status === 'blocked' ? 'blocked' : 'install'} />
            {button}
          </>
        ) : (
          <>
            <p className="text-sm text-gray-600">{status === 'on' ? t('on') : t('intro')}</p>
            {button}
          </>
        )}

        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Two kinds of failure reach the catch blocks and only one has anything to say.
 *
 * A refusal from the API is coded and translated. A `DOMException` from
 * `subscribe()` is an English sentence about a push service, which on an Arabic
 * screen is noise the reader cannot use.
 */
function describe(
  err: unknown,
  apiError: (err: unknown, fallback: string) => string,
  fallback: string,
): string {
  const fromApi = Boolean((err as { response?: unknown })?.response);
  return fromApi ? apiError(err, fallback) : fallback;
}
