'use client';

import { useTranslations } from 'next-intl';
import { Share } from 'lucide-react';

import { browserFamily, type BrowserFamily } from './push';

/**
 * How to actually turn alerts on, in this browser, in order.
 *
 * The first version said "on iPhone, add it to your home screen first" and
 * stopped there — a true sentence and a dead end, which is worse than saying
 * nothing because it reads as a refusal. Somebody standing in a workshop needs
 * the steps, and the steps are genuinely different per browser: a generic
 * "check your browser settings" helps nobody.
 *
 * Two situations get instructions:
 *
 * `install` — Safari on iOS gives no push at all until the app is on the home
 * screen. This is not a permission problem and no prompt will ever appear; it
 * is a thing the person has to do first, and it takes three taps.
 *
 * `blocked` — permission was refused at some point. The browser will never ask
 * again, so the only way back is its own settings, and where those live differs
 * enough between browsers to be worth naming.
 */
export function HowToAllow({ reason }: { reason: 'install' | 'blocked' }) {
  const t = useTranslations('account');
  const family: BrowserFamily = browserFamily();

  const steps = stepsFor(reason, family).map((key) => t(key));

  return (
    <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-medium">
        {reason === 'install' ? t('installToGetAlerts') : t('alertsBlockedTitle')}
      </p>

      <ol className="mt-2 space-y-1.5 ps-5" style={{ listStyleType: 'decimal' }}>
        {steps.map((step, i) => (
          <li key={i} className="leading-relaxed">
            {/* The share icon is worth showing rather than describing: on iOS it
                is the one control people cannot find by name, and "the square
                with an arrow coming out of it" is a sentence nobody should have
                to parse while holding a brake caliper. */}
            {reason === 'install' && family === 'ios-safari' && i === 0 ? (
              <span className="inline-flex items-center gap-1.5">
                {step}
                <Share className="inline h-4 w-4 shrink-0" aria-hidden />
              </span>
            ) : (
              step
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The translation keys for one situation in one browser, in order. */
function stepsFor(reason: 'install' | 'blocked', family: BrowserFamily): string[] {
  if (reason === 'install') {
    return family === 'ios-safari'
      ? ['iosStep1', 'iosStep2', 'iosStep3', 'iosStep4']
      : ['installStep1', 'installStep2'];
  }

  switch (family) {
    case 'ios-safari':
      return ['blockedIosStep1', 'blockedIosStep2', 'blockedIosStep3'];
    case 'safari':
      return ['blockedSafariStep1', 'blockedSafariStep2'];
    case 'firefox':
      return ['blockedFirefoxStep1', 'blockedFirefoxStep2'];
    default:
      return ['blockedChromeStep1', 'blockedChromeStep2'];
  }
}
