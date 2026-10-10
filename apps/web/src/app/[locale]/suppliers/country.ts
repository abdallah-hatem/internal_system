import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

/**
 * A supplier's country is free text, typed however the person typing it chose:
 * "China", "CN", "china", "AE", "UAE", "United Arab Emirates". Nothing is
 * stored differently — this only decides which translated name to show.
 *
 * Each ISO code lists the spellings that mean it (lower-case, punctuation and
 * extra spaces removed before lookup). The names themselves live under
 * `codes.country` in en.json / ar.json.
 */
const ALIASES: Record<string, string[]> = {
  CN: ['cn', 'chn', 'china', 'prc', 'peoples republic of china', 'mainland china', 'الصين'],
  AE: ['ae', 'are', 'uae', 'u a e', 'united arab emirates', 'emirates', 'dubai', 'الإمارات', 'الامارات', 'الإمارات العربية المتحدة'],
  EG: ['eg', 'egy', 'egypt', 'مصر'],
  HK: ['hk', 'hkg', 'hong kong', 'هونغ كونغ', 'هونج كونج'],
  TW: ['tw', 'twn', 'taiwan', 'تايوان'],
  JP: ['jp', 'jpn', 'japan', 'اليابان'],
  KR: ['kr', 'kor', 'korea', 'south korea', 'republic of korea', 'كوريا', 'كوريا الجنوبية'],
  TR: ['tr', 'tur', 'turkey', 'turkiye', 'türkiye', 'تركيا'],
  IN: ['in', 'ind', 'india', 'الهند'],
  SA: ['sa', 'sau', 'ksa', 'saudi arabia', 'saudi', 'السعودية'],
  DE: ['de', 'deu', 'germany', 'ألمانيا', 'المانيا'],
  US: ['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america', 'الولايات المتحدة', 'أمريكا'],
  TH: ['th', 'tha', 'thailand', 'تايلاند'],
};

const normalise = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.'’()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LOOKUP = new Map<string, string>(
  Object.entries(ALIASES).flatMap(([code, names]) => names.map((n) => [normalise(n), code] as const)),
);

/** The ISO code a typed country means, or null when it is not one we know. */
export function countryCode(typed: string | null | undefined): string | null {
  if (!typed) return null;
  return LOOKUP.get(normalise(typed)) ?? null;
}

/** Every code this file knows — en.json and ar.json must name each one. */
export const KNOWN_COUNTRIES = Object.keys(ALIASES);

/**
 * Show a typed country in the reader's language.
 *
 *   const countryLabel = useCountryLabel();
 *   countryLabel('CN')     // "China" / "الصين"
 *   countryLabel('UAE')    // "United Arab Emirates" / "الإمارات"
 *   countryLabel('Narnia') // "Narnia" — what was typed, never blank
 *
 * `null`/`undefined`/`''` returns `'—'`.
 */
export function useCountryLabel(): (typed: string | null | undefined) => string {
  const t = useTranslations('codes.country');
  return useCallback(
    (typed: string | null | undefined) => {
      if (!typed || !typed.trim()) return '—';
      const code = countryCode(typed);
      return code && t.has(code) ? t(code) : typed.trim();
    },
    [t],
  );
}
