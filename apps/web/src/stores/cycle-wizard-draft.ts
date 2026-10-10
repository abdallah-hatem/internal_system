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

/** A fresh purchase order line: the order starts with one (UX quick win). */
export const emptyLineItem = (): WizardLineItem => ({
  productId: '',
  orderedQty: 0,
  unitPrice: 0,
  discount: 0,
});

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

  // Typed, not necessarily submitted.
  originType: string;
  poSupplierId: string;
  poCurrency: string;
  poFxRate: string;
  poOrderedOn: string;
  lineItems: WizardLineItem[];
}

/**
 * What was typed on the shipping step and not yet saved, per cycle.
 *
 * The leg form is uncontrolled — its fields read the saved leg once, on mount —
 * so stepping back to the order, or leaving for the list and clicking the cycle
 * again, threw away everything typed there. This holds only the fields that
 * differ from what the form opened with, keyed by cycle, and is cleared the
 * moment the legs are saved, so it never sits on top of the server's values
 * for longer than the edit it protects.
 *
 * Kept outside `draft` because it applies to resumed cycles too, which have no
 * draft: the server is the truth for what was saved, and this is only what was
 * not.
 */
export interface UnsavedLegFields {
  fields: Record<string, string>;
  savedAt: number;
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
  /** Unsaved shipping-step fields, keyed by cycle id. */
  legFields: Record<string, UnsavedLegFields>;
  /** False until persisted state has been read back, on the first render. */
  hydrated: boolean;
  save: (draft: CycleWizardDraft) => void;
  clear: () => void;
  saveLegFields: (cycleId: string, fields: Record<string, string>) => void;
  clearLegFields: (cycleId: string) => void;
}

export const useCycleWizardDraft = create<DraftState>()(
  persist(
    (set) => ({
      draft: null,
      savedAt: null,
      legFields: {},
      hydrated: false,
      save: (draft) => set({ draft, savedAt: Date.now() }),
      clear: () => set({ draft: null, savedAt: null }),
      saveLegFields: (cycleId, fields) =>
        set((s) => {
          const rest = { ...s.legFields };
          delete rest[cycleId];
          return Object.keys(fields).length === 0
            ? { legFields: rest }
            : { legFields: { ...rest, [cycleId]: { fields, savedAt: Date.now() } } };
        }),
      clearLegFields: (cycleId) =>
        set((s) => {
          if (!s.legFields[cycleId]) return s;
          const rest = { ...s.legFields };
          delete rest[cycleId];
          return { legFields: rest };
        }),
    }),
    {
      name: 'cycle-wizard-draft',
      // The store is also constructed while rendering on the server, where
      // there is no localStorage. Hand back an empty one there rather than
      // letting the getter throw, which would disable persistence.
      storage: createJSONStorage(() =>
        typeof window === 'undefined' ? noopStorage : window.localStorage,
      ),
      partialize: ({ draft, savedAt, legFields }) => ({ draft, savedAt, legFields }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.savedAt && Date.now() - state.savedAt > MAX_DRAFT_AGE_MS) {
          state.draft = null;
          state.savedAt = null;
        }
        state.legFields = freshLegFields(state.legFields);
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
  if (!Array.isArray(draft.lineItems)) return false;
  // The order starts with one empty row, so a row on its own is not work; a
  // row with a product chosen is.
  return Boolean(
    draft.cycleId ||
      draft.originType ||
      draft.poSupplierId ||
      draft.lineItems.some((item) => item && typeof item === 'object' && item.productId),
  );
}

/**
 * The unsaved leg fields still worth offering back: well-formed, and younger
 * than a draft is allowed to be. Anything else in storage is dropped.
 */
function freshLegFields(raw: unknown): Record<string, UnsavedLegFields> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, UnsavedLegFields> = {};
  for (const [cycleId, entry] of Object.entries(raw as Record<string, unknown>)) {
    const e = entry as Partial<UnsavedLegFields> | null;
    if (!e || typeof e !== 'object' || !e.fields || typeof e.fields !== 'object') continue;
    if (typeof e.savedAt !== 'number' || Date.now() - e.savedAt > MAX_DRAFT_AGE_MS) continue;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.fields)) if (typeof v === 'string') fields[k] = v;
    out[cycleId] = { fields, savedAt: e.savedAt };
  }
  return out;
}
