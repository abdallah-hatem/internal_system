'use client';

import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * The search box.
 *
 * Holds the raw text; the screen above it decides when that text has settled
 * enough to ask the API. Logical insets throughout (`start-*`, `end-*`,
 * `ps-*`, `pe-*`) so the icon and the clear button swap sides in Arabic
 * without a second rule.
 */
export function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('catalogue');
  const tc = useTranslations('common');

  return (
    <div className="relative flex-1">
      <Search
        aria-hidden
        className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
      />

      <input
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={tc('search')}
        placeholder={t('searchPlaceholder')}
        className="h-12 w-full rounded-xl border border-gray-300 bg-white ps-11 pe-12 text-base text-gray-900 placeholder:text-gray-400 focus:border-brand-600 focus:outline-2 focus:outline-offset-0 focus:outline-brand-600"
      />

      {value ? (
        <button
          // Inside no form today, but stating it costs nothing and a bare
          // button defaults to submit the day this sits in one.
          type="button"
          onClick={() => onChange('')}
          aria-label={t('clearSearch')}
          className="absolute end-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          <X className="h-5 w-5" />
        </button>
      ) : null}
    </div>
  );
}
