'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { usePathname, useRouter } from '../../i18n/navigation';
import { routing } from '../../i18n/routing';

/**
 * Arabic or English, on the screen the shop already came to for its settings.
 *
 * Each language is written in itself — العربية and English — in both locale
 * files, and that is not an untranslated string left behind. A switcher that
 * labelled the alternative in the language currently on screen is unreadable to
 * exactly the person reaching for it: a shop that opened the store in the wrong
 * language cannot find "الإنجليزية" if they do not read Arabic.
 *
 * The route is swapped rather than a preference stored: the locale is in the
 * URL, the middleware reads it there, and a copied link opens in the language
 * it was copied from. `replace` and not `push`, so Back leaves the account
 * screen instead of walking through the languages it was just set to.
 */
const LABELS: Record<string, string> = { ar: 'arabic', en: 'english' };

export function LanguageSwitch() {
  const t = useTranslations('account');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <Languages className="h-4 w-4 text-gray-400" aria-hidden />
        {t('language')}
      </h2>

      <div role="group" aria-label={t('language')} className="flex gap-2">
        {routing.locales.map((option) => {
          const active = option === locale;
          return (
            <button
              key={option}
              type="button"
              lang={option}
              aria-pressed={active}
              disabled={pending}
              onClick={() => {
                if (active) return;
                startTransition(() => router.replace(pathname, { locale: option }));
              }}
              className={`min-h-11 flex-1 rounded-xl px-4 text-sm font-semibold transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                active
                  ? 'bg-brand-600 text-white'
                  : 'border border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
              }`}
            >
              {t(LABELS[option])}
            </button>
          );
        })}
      </div>
    </section>
  );
}
