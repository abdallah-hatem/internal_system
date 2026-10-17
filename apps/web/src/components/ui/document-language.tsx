'use client';

import type { ReactNode } from 'react';
import { NextIntlClientProvider, createTranslator, useTranslations } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * The language a printed document is in — the contract's and the invoice's —
 * chosen on the document, not taken from the app (owner, 2026-10-17: "in
 * invoice where is the language toggle, with ar as default as in contract").
 * Arabic by default: the shops these go to read Arabic.
 */
export type DocumentLanguage = 'ar' | 'en';
export const DEFAULT_DOCUMENT_LANGUAGE: DocumentLanguage = 'ar';

const MESSAGES = { ar, en } as const;

/**
 * IBM Plex Sans Arabic named first, by name. The app's `font-sans` puts the
 * Latin Plex first, and next/font gives that face an Arial fallback — which
 * has Arabic glyphs, so Arabic text drew in Arial before it ever reached Plex
 * Arabic. The CSS variables follow as the fallback (next/font's own names).
 */
export const DOCUMENT_FONT =
  "'IBM Plex Sans Arabic', 'IBM Plex Sans', var(--font-plex-arabic), var(--font-plex-sans), sans-serif";

export const documentDir = (lang: DocumentLanguage) => (lang === 'ar' ? 'rtl' : 'ltr');

/**
 * Everything inside reads its words, dates and numbers in `lang`, whatever the
 * app's own language — `useTranslations`, `useLocale` and the format hooks
 * built on them all answer from here.
 */
export function DocumentLocale({ lang, children }: { lang: DocumentLanguage; children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={lang} messages={MESSAGES[lang]} timeZone="Africa/Cairo">
      {children}
    </NextIntlClientProvider>
  );
}

/** A translator for `lang` outside the provider — a file name, a share title, a page label. */
export function documentTranslator(
  lang: DocumentLanguage,
  namespace: string,
): (key: string, values?: Record<string, string | number>) => string {
  // createTranslator types keys per literal namespace; callers here name one
  // and the keys they read, and a missing key still falls back to its path.
  const t = createTranslator({ locale: lang, messages: MESSAGES[lang], namespace: namespace as never });
  return (key, values) => (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values);
}

/** The العربية / English switch above a document. */
export function DocumentLanguageSwitch({
  value,
  onChange,
  testIdPrefix,
}: {
  value: DocumentLanguage;
  onChange: (lang: DocumentLanguage) => void;
  /** `contract` gives contract-lang-ar and contract-lang-en. */
  testIdPrefix: string;
}) {
  const t = useTranslations('documents');
  return (
    <div role="group" aria-label={t('language')} className="inline-flex rounded-lg border border-border p-0.5">
      {(['ar', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          data-testid={`${testIdPrefix}-lang-${l}`}
          aria-pressed={value === l}
          onClick={() => onChange(l)}
          className={`rounded-md px-3 py-1.5 text-sm ${
            value === l ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
          }`}
        >
          {l === 'ar' ? 'العربية' : 'English'}
        </button>
      ))}
    </div>
  );
}
