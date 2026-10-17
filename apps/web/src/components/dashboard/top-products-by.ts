'use client';

import { useSyncExternalStore } from 'react';

/** How the top products are ranked — the API's `by` (analytics.service TOP_PRODUCTS_BY). */
export type TopProductsBy = 'units' | 'revenue';

const KEY = 'topProductsBy';
const DEFAULT: TopProductsBy = 'units';
const listeners = new Set<() => void>();

/** The choice made this visit when storage refused to keep it (a private window). */
let unsaved: TopProductsBy | null = null;

function read(): TopProductsBy {
  if (unsaved) return unsaved;
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === 'revenue' || stored === 'units' ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/**
 * The ranking the person last chose, kept on this device. Units first (owner
 * 2026-10-18: "top 5 sold products, as in qty not revenue"). The server draws
 * the default and the browser takes the stored choice after hydrating, so the
 * two never disagree on the first paint. Storage can be refused (a private
 * window): the default stands and nothing breaks.
 */
export function useTopProductsBy(): [TopProductsBy, (by: TopProductsBy) => void] {
  const by = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    () => DEFAULT,
  );
  const choose = (next: TopProductsBy) => {
    try {
      window.localStorage.setItem(KEY, next);
      unsaved = null;
    } catch {
      unsaved = next;
    }
    listeners.forEach((l) => l());
  };
  return [by, choose];
}
