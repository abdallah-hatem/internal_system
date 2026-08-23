'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Survives a reload of the new-cycle wizard.
 *
 * The wizard writes to the server as it goes — step 1 creates the cycle, step 2
 * the purchase order, step 3 the legs — but the URL stays /cycles/new the whole
 * time. Reload it and the browser threw away the only reference to the cycle
 * that was just created, along with everything typed but not yet submitted.
 *
 * So the draft holds two different kinds of thing: ids of records that already
 * exist server-side (so a reload can pick the same ones back up rather than
 * creating duplicates), and form values not yet sent anywhere.
 *
 * Only the /cycles/new wizard uses this. Resuming an existing cycle loads from
 * the server, which is the truth for that one; a draft layered on top would
 * fight it.
 */

export interface WizardLineItem {
  productId: string;
  orderedQty: number;
  unitPrice: number;
  discount: number;
}

export interface WizardReceiveItem {
  purchaseOrderItemId: string;
  productId: string;
  receivedQty: number;
  landedUnitCostEgp: number;
}

export interface CycleWizardDraft {
  currentStep: number;
  maxStepReached: number;

  // Already saved server-side — kept so a reload re-attaches instead of
  // creating a second cycle / purchase order / leg.
  cycleId: string | null;
  cycleCode: string | null;
  poId: string | null;
  poReference: string | null;
  legIds: Record<number, string>;
  shippingLegId: string | null;

  // Typed, not necessarily submitted.
  originType: string;
  poSupplierId: string;
  poCurrency: string;
  poFxRate: string;
  poOrderedOn: string;
  lineItems: WizardLineItem[];
  receiveItems: WizardReceiveItem[];
  shippingProvider: string;
  shippingOrigin: string;
  shippingDestination: string;
  shippingTrackingRef: string;
  shippingDepartedOn: string;
  shippingArrivedOn: string;
  shippingAmount: string;
}

/**
 * How long an abandoned draft keeps offering itself.
 *
 * Without a cap, a wizard opened once and walked away from would still be
 * restoring its half-filled form months later, and the person who sees it
 * won't remember enough to tell whether it is worth keeping.
 */
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const noopStorage: Storage = {
  length: 0,
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {},
};

interface DraftState {
  draft: CycleWizardDraft | null;
  savedAt: number | null;
  /** False until persisted state has been read back, on the first render. */
  hydrated: boolean;
  save: (draft: CycleWizardDraft) => void;
  clear: () => void;
}

export const useCycleWizardDraft = create<DraftState>()(
  persist(
    (set) => ({
      draft: null,
      savedAt: null,
      hydrated: false,
      save: (draft) => set({ draft, savedAt: Date.now() }),
      clear: () => set({ draft: null, savedAt: null }),
    }),
    {
      name: 'cycle-wizard-draft',
      // The store is also constructed while rendering on the server, where
      // there is no localStorage. Hand back an empty one there rather than
      // letting the getter throw, which would disable persistence.
      storage: createJSONStorage(() =>
        typeof window === 'undefined' ? noopStorage : window.localStorage,
      ),
      partialize: ({ draft, savedAt }) => ({ draft, savedAt }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.savedAt && Date.now() - state.savedAt > MAX_DRAFT_AGE_MS) {
          state.draft = null;
          state.savedAt = null;
        }
        state.hydrated = true;
      },
    },
  ),
);

/**
 * Whether a draft is worth offering back.
 *
 * A wizard that was opened and abandoned on step 1 holds nothing, and asking
 * about it is worse than silently dropping it.
 *
 * Also the shape check. What comes back is whatever is in localStorage — hand
 * editable, and left behind by whatever version of this code wrote it, which
 * may not be this one. Reading a field off a stale shape threw for real:
 * `lineItems` as null took `.length` and brought the effect down with it. So
 * nothing here assumes a field is the type it is declared as.
 */
export function draftIsWorthKeeping(
  draft: CycleWizardDraft | null,
): draft is CycleWizardDraft {
  if (!draft || typeof draft !== 'object') return false;
  if (typeof draft.currentStep !== 'number') return false;
  if (!Array.isArray(draft.lineItems) || !Array.isArray(draft.receiveItems)) return false;
  return Boolean(
    draft.cycleId ||
      draft.originType ||
      draft.poSupplierId ||
      draft.lineItems.length > 0,
  );
}
