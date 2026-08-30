'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * What a shop has picked out but not yet asked for.
 *
 * Persisted, because this is assembled one-handed on a phone in a workshop and
 * the interruption is the normal case, not the exception — a customer walks in,
 * the screen locks, the browser drops the tab to reclaim memory. Losing a
 * half-built order to any of those means it gets rebuilt from memory or not at
 * all.
 *
 * A line carries only what the customer chose and what they were quoted at the
 * time. No stock figure: the catalogue says "in stock" as a band and never a
 * count (see `ui/stock-badge`), and copying a number in here would be inventing
 * one. Whether the units exist is settled by the server when the request is
 * submitted, which is the only moment the answer is worth anything anyway.
 *
 * `unitPrice` stays the decimal string the API sent. It is never parsed into a
 * number here — see `components/requests/decimal.ts` for why, and for the only
 * arithmetic this basket is allowed to do.
 */

export type BasketLine = {
  productId: string;
  name: string;
  sku: string;
  /** Decimal string, exactly as the API sent it. Never a JavaScript number. */
  unitPrice: string;
  quantity: number;
};

/** A basket is not a stock check. This only stops a fat-fingered paste. */
const MAX_QUANTITY = 999_999;

function clamp(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(MAX_QUANTITY, Math.max(1, Math.floor(quantity)));
}

type BasketState = {
  lines: BasketLine[];
  note: string;

  /**
   * Put a product in, or add to what is already there.
   *
   * The descriptive fields are refreshed from this call rather than left as
   * they were first stored: a basket a week old would otherwise quote a price
   * the catalogue has since changed, and a shop reading a stale estimate is
   * being misled by us rather than by the passage of time.
   */
  add: (line: Omit<BasketLine, 'quantity'>, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  setNote: (note: string) => void;
  clear: () => void;
};

export const useBasket = create<BasketState>()(
  persist(
    (set) => ({
      lines: [],
      note: '',

      add: (line, quantity = 1) =>
        set((state) => {
          const wanted = clamp(quantity);
          const existing = state.lines.find((l) => l.productId === line.productId);
          if (!existing) return { lines: [...state.lines, { ...line, quantity: wanted }] };

          return {
            lines: state.lines.map((l) =>
              l.productId === line.productId
                ? { ...l, ...line, quantity: clamp(l.quantity + wanted) }
                : l,
            ),
          };
        }),

      setQuantity: (productId, quantity) =>
        set((state) => ({
          lines: state.lines.map((l) =>
            l.productId === productId ? { ...l, quantity: clamp(quantity) } : l,
          ),
        })),

      remove: (productId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.productId !== productId) })),

      setNote: (note) => set({ note }),

      // Called only once the API has answered with a request number. Clearing
      // optimistically would throw the basket away on a refusal the shop was
      // meant to read and act on — an unverified account, or a line that is no
      // longer in stock.
      clear: () => set({ lines: [], note: '' }),
    }),
    {
      name: 'storefront.basket',
      version: 1,
      // Guarded rather than trusted: this module is imported by a server render
      // too, where `localStorage` does not exist.
      storage: createJSONStorage(() =>
        typeof window === 'undefined' ? (undefined as unknown as Storage) : window.localStorage,
      ),
      partialize: (state) => ({ lines: state.lines, note: state.note }),
    },
  ),
);

/**
 * Whether the persisted basket has been read back yet.
 *
 * The server renders an empty basket because it cannot see `localStorage`, so
 * anything that renders a line — or a count badge — must render nothing until
 * this is true, or React reconciles a server "0" against a client "3" and warns
 * about it. Deliberately starts `false` on the client as well as the server:
 * zustand rehydrates synchronously at import, so reading `hasHydrated()` during
 * the first render would already say `true` and put the mismatch straight back.
 */
export function useBasketHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useBasket.persist.hasHydrated()) setHydrated(true);
    return useBasket.persist.onFinishHydration(() => setHydrated(true));
  }, []);

  return hydrated;
}

/** How many lines are waiting. Zero until the persisted basket is read back. */
export function useBasketCount(): number {
  const hydrated = useBasketHydrated();
  const lines = useBasket((s) => s.lines);
  return hydrated ? lines.length : 0;
}
