'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, X } from 'lucide-react';

import { Link } from '../../i18n/navigation';
import { useSession } from '../../lib/session';
import { pushSupported } from './push';

/**
 * Asking, rather than waiting to be found.
 *
 * Alerts lived only on the account screen, which is a tab nobody opens twice —
 * so the answer to "how do I get told when my order is approved" was to go
 * looking for it. This asks.
 *
 * It does NOT call `Notification.requestPermission()` itself. A permission
 * prompt that appears because a page loaded is the one everybody denies, and a
 * denial is permanent: the browser never asks again and the only way back is
 * its own settings. So this is an ordinary banner that leads to the account
 * screen, where pressing a button is a deliberate act and the instructions are
 * beside it.
 *
 * Shown to signed-in shops only, once dismissed stays dismissed, and never on
 * the account screen itself — where the real control already is.
 */
const DISMISSED_KEY = 'storefront.alertsPromptDismissed';

export function AlertsPrompt({ pathname }: { pathname: string }) {
  const t = useTranslations('account');
  const { token } = useSession();
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Client-only, and after mount: `Notification` does not exist on the
    // server and reading localStorage during render would differ between the
    // two and blow up hydration.
    if (!token) return setShow(false);
    if (pathname.startsWith('/account')) return setShow(false);

    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      // Private mode with storage disabled. Better to ask than to crash.
    }
    if (dismissed) return setShow(false);

    // Already granted means already on — nothing to ask for. `denied` still
    // shows it, because the account screen is where the way back lives and a
    // shop that denied it by reflex has no other route to that page.
    const granted =
      typeof Notification !== 'undefined' && Notification.permission === 'granted';

    setShow(!granted && (pushSupported() || isIosBrowser()));
  }, [token, pathname]);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to do; it will ask again next time, which is the safe failure.
    }
    setShow(false);
  };

  return (
    <div className="mx-auto mb-3 flex max-w-2xl items-start gap-3 rounded-2xl bg-brand-50 p-3 text-start ring-1 ring-brand-600/15 ring-inset">
      <Bell className="mt-0.5 h-5 w-5 shrink-0 text-brand-700" aria-hidden />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{t('alertsPromptTitle')}</p>
        <p className="mt-0.5 text-sm text-gray-600">{t('alertsPromptBody')}</p>

        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            href="/account"
            onClick={dismiss}
            className="inline-flex min-h-10 items-center rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white hover:bg-brand-600"
          >
            {t('alertsPromptYes')}
          </Link>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex min-h-10 items-center rounded-xl px-3 text-sm font-medium text-gray-600 hover:bg-white/60"
          >
            {t('alertsPromptLater')}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label={t('alertsPromptLater')}
        className="shrink-0 rounded-lg p-1 text-gray-400 hover:text-gray-600"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * An iPhone that cannot do push yet but could once installed.
 *
 * `pushSupported()` is false in Safari outside the home screen — sometimes
 * there is no `PushManager` at all — so asking that alone would hide the prompt
 * from precisely the people who need the instructions.
 */
function isIosBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
