'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Share, MoreVertical, Plus, Check } from 'lucide-react';

import { isIos, isStandalone } from '../account/push';

/**
 * How to put this on the home screen, shown rather than described.
 *
 * Written because "add it to your home screen" is a sentence people read and do
 * not act on. The share icon in particular is the problem: on iOS it is the
 * only way in, it is unlabelled, and a shop owner who has never deliberately
 * used it does not know which of the toolbar glyphs it is. A drawing of the
 * toolbar with that one icon pulsing answers the question the sentence raises.
 *
 * It is not decoration. On iOS this is the only route to web push — Safari
 * gives no notifications at all until the app is installed, and no prompt ever
 * appears to say so. A shop that never installs never hears that its order was
 * approved, and nothing on screen explains why.
 *
 * Platform detection is `isIos()` / `isStandalone()` from `account/push.ts`
 * rather than a second copy: iPadOS reports itself as a Mac, that file already
 * knows it, and two answers to "is this an iPhone" is how one of them goes
 * stale.
 */

type Platform = 'ios' | 'android';

export function InstallGuide() {
  const t = useTranslations('install');
  const locale = useLocale();
  const rtl = locale === 'ar';

  // Defaults to iOS on the server, replaced on mount. It only decides which
  // drawing to show, and the switch below lets anyone see the other one.
  const [platform, setPlatform] = useState<Platform>('ios');
  const [step, setStep] = useState(0);

  useEffect(() => setPlatform(isIos() ? 'ios' : 'android'), []);

  const steps = platform === 'ios' ? IOS_STEPS : ANDROID_STEPS;

  // Advance on a timer so it plays like a demonstration rather than waiting to
  // be operated. Someone who wants to study one step can tap the dots.
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % steps.length), 2600);
    return () => clearTimeout(id);
  }, [playing, step, steps.length]);

  return (
    <div className="flex flex-col gap-4">
      {/* No close button here. `DialogContent` already renders one, and two
          of them appeared at opposite ends of the header — which reads as one
          of them doing something else. */}
      <div className="pe-6">
        <h2 className="text-lg font-bold text-gray-900">{t('title')}</h2>
        <p className="mt-0.5 text-sm text-gray-500">{t('why')}</p>
      </div>

      {/* Which phone. Shown even when we detected one, because the detection
          can be wrong and because somebody is often reading this to help a
          colleague holding the other kind. */}
      <div
        role="tablist"
        aria-label={t('choosePlatform')}
        className="flex gap-1 rounded-xl bg-gray-100 p-1"
      >
        {(['ios', 'android'] as const).map((p) => (
          <button
            key={p}
            role="tab"
            type="button"
            aria-selected={platform === p}
            onClick={() => {
              setPlatform(p);
              setStep(0);
              setPlaying(true);
            }}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              platform === p
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t(p === 'ios' ? 'iphone' : 'android')}
          </button>
        ))}
      </div>

      <PhoneMock platform={platform} step={step} rtl={rtl} />

      {/* The steps as text as well as pictures. The animation shows where to
          tap; the words are what someone reads back to themselves while doing
          it, and they are what a screen reader gets. */}
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              onClick={() => {
                setStep(i);
                setPlaying(false);
              }}
              aria-current={step === i ? 'step' : undefined}
              className={`flex w-full items-center gap-3 rounded-xl p-2.5 text-start transition-colors ${
                step === i ? 'bg-brand-50' : 'hover:bg-gray-50'
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  step === i ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {i + 1}
              </span>
              <span
                className={`text-sm ${step === i ? 'font-medium text-gray-900' : 'text-gray-600'}`}
              >
                {t(`steps.${platform}.${s.key}`)}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900">{t('thenWhat')}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const IOS_STEPS = [{ key: 'share' }, { key: 'find' }, { key: 'add' }] as const;
const ANDROID_STEPS = [{ key: 'menu' }, { key: 'install' }, { key: 'confirm' }] as const;

/**
 * A phone, drawn.
 *
 * Deliberately not a screenshot. A screenshot of one iOS version is wrong on
 * the next one and unreadable at this size, and it cannot be translated — the
 * words inside it stay English on an Arabic screen.
 */
function PhoneMock({ platform, step, rtl }: { platform: Platform; step: number; rtl: boolean }) {
  const t = useTranslations('install');

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-b from-gray-100 to-gray-200 p-4">
      <div
        className="mx-auto w-[190px] overflow-hidden rounded-[26px] border-[6px] border-gray-800 bg-white shadow-lg"
        // The drawing is a picture; its own text is decorative and duplicated
        // in the list beneath, which is what a screen reader should read.
        aria-hidden
      >
        {/* Status bar */}
        <div className="flex items-center justify-between bg-white px-3 py-1.5 text-[9px] font-semibold text-gray-800">
          <span>10:10</span>
          <span className="h-1.5 w-8 rounded-full bg-gray-800" />
          <span>100%</span>
        </div>

        <div className="relative h-[210px] bg-gray-50">
          {platform === 'ios' ? (
            <IosScreen step={step} rtl={rtl} label={t('addToHomeScreen')} />
          ) : (
            <AndroidScreen step={step} rtl={rtl} label={t('installApp')} />
          )}
        </div>
      </div>
    </div>
  );
}

/** A pulsing ring over whatever the current step wants tapped. */
function Tap({ className }: { className: string }) {
  return (
    <span className={`pointer-events-none absolute ${className}`}>
      <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/40" />
      <span className="absolute inset-0 rounded-full border-2 border-brand-600 bg-brand-500/20" />
    </span>
  );
}

function IosScreen({ step, rtl, label }: { step: number; rtl: boolean; label: string }) {
  return (
    <>
      {/* The page behind, dimmed once the sheet is up. */}
      <div className={`p-3 transition-opacity ${step > 0 ? 'opacity-30' : 'opacity-100'}`}>
        <div className="h-2 w-16 rounded bg-gray-300" />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="h-14 rounded-lg bg-gray-200" />
          <div className="h-14 rounded-lg bg-gray-200" />
        </div>
      </div>

      {/* Safari's toolbar. Step 1 is the whole point of the drawing: which of
          these glyphs is the share button. */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-around border-t border-gray-200 bg-gray-100 px-2 py-2">
        <span className="h-3 w-3 rounded-sm bg-gray-400" />
        <span className="relative">
          <Share className="h-4 w-4 text-brand-600" strokeWidth={2.5} />
          {step === 0 && <Tap className="-inset-2 rounded-full" />}
        </span>
        <span className="h-3 w-3 rounded-sm bg-gray-400" />
      </div>

      {/* The share sheet, sliding up. */}
      <div
        className={`absolute inset-x-0 bottom-0 rounded-t-xl border-t border-gray-200 bg-white p-2 shadow-lg transition-transform duration-500 ${
          step > 0 ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-gray-300" />
        <div className="space-y-1">
          <div className="h-5 rounded bg-gray-100" />
          <div className="h-5 rounded bg-gray-100" />
          {/* The row they are looking for. */}
          <div
            className={`relative flex items-center justify-between rounded px-2 py-1.5 transition-colors ${
              step >= 1 ? 'bg-brand-50' : ''
            }`}
          >
            <span className="text-[8px] font-medium text-gray-900">{label}</span>
            <Plus className="h-3 w-3 text-gray-600" strokeWidth={3} />
            {step === 1 && <Tap className="-inset-1 rounded-lg" />}
          </div>
          <div className="h-5 rounded bg-gray-100" />
        </div>
      </div>

      {/* Confirmation. */}
      {step === 2 && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg">
            <Check className="h-6 w-6" strokeWidth={3} />
          </span>
        </div>
      )}
    </>
  );
}

function AndroidScreen({ step, rtl, label }: { step: number; rtl: boolean; label: string }) {
  return (
    <>
      {/* Chrome's toolbar is at the top, and the menu is at the inline end —
          which mirrors under Arabic, so this uses a logical property rather
          than pinning it right. */}
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100 px-2 py-1.5">
        <span className="h-2 w-20 rounded bg-gray-300" />
        <span className="relative">
          <MoreVertical className="h-4 w-4 text-brand-600" strokeWidth={2.5} />
          {step === 0 && <Tap className="-inset-2 rounded-full" />}
        </span>
      </div>

      <div className={`p-3 transition-opacity ${step > 0 ? 'opacity-30' : 'opacity-100'}`}>
        <div className="h-2 w-16 rounded bg-gray-300" />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="h-14 rounded-lg bg-gray-200" />
          <div className="h-14 rounded-lg bg-gray-200" />
        </div>
      </div>

      {/* The dropdown, anchored to the inline end under the menu button. */}
      <div
        className={`absolute top-8 ${rtl ? 'start-2' : 'end-2'} w-28 origin-top rounded-lg border border-gray-200 bg-white p-1 shadow-lg transition-all duration-300 ${
          step > 0 ? 'scale-100 opacity-100' : 'scale-90 opacity-0'
        }`}
      >
        <div className="h-4 rounded bg-gray-100" />
        <div
          className={`relative my-0.5 flex items-center gap-1 rounded px-1.5 py-1 transition-colors ${
            step >= 1 ? 'bg-brand-50' : ''
          }`}
        >
          <Plus className="h-2.5 w-2.5 shrink-0 text-gray-600" strokeWidth={3} />
          <span className="text-[8px] font-medium text-gray-900">{label}</span>
          {step === 1 && <Tap className="-inset-1 rounded" />}
        </div>
        <div className="h-4 rounded bg-gray-100" />
      </div>

      {step === 2 && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg">
            <Check className="h-6 w-6" strokeWidth={3} />
          </span>
        </div>
      )}
    </>
  );
}

/** Nothing to install when it is already installed. */
export function useShouldOfferInstall(): boolean {
  const [offer, setOffer] = useState(false);
  useEffect(() => setOffer(!isStandalone()), []);
  return offer;
}
