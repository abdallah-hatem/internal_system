'use client';

import { useEffect, useRef } from 'react';

/**
 * The dialogs open right now that close on Escape, innermost last.
 *
 * Escape closes one dialog — the top one. Each open dialog listens, and only
 * the one at the end of this list acts; the rest let the key go by.
 */
const openDialogs: symbol[] = [];

/**
 * Escape closes the dialog, through the same `onClose` Cancel and the X use
 * (CLAUDE.md §13: every close path clears the same way, so the next opening
 * inherits nothing). One definition for every dialog with pickers in it —
 * quick-create (I1), the ledger entry (L6), recording a payment and the
 * shipment dialogs (L7). RecordPaymentDialog had its own copy, on the
 * document, and Escape inside its method picker closed the whole form.
 *
 * Three things it must not do, and how it avoids each:
 *
 * - **Close the dialog when a picker inside it is open.** Escape then belongs
 *   to the picker (Radix closes its popover on it); the dialog waits for the
 *   next press. The listener is on `window` in the capture phase — the first
 *   stop for any key, ahead of Radix's own handler on the document, which
 *   takes the picker out of the page before a later listener could see it.
 * - **Close the form underneath.** The page form, or another dialog that also
 *   closes on Escape, would lose everything typed into it: the event stops
 *   here.
 * - **Close two levels at once.** Nested dialogs all listen; only the
 *   innermost (the last in `openDialogs`) acts.
 *
 * While `busy` (a save in flight) the key is swallowed and nothing closes:
 * closing then would drop the answer on the floor. `busy` may be a function,
 * for a ref set synchronously on submit.
 */
export function useEscapeToClose(
  onClose: () => void,
  busy: boolean | (() => boolean) = false,
) {
  const latest = useRef({ onClose, busy });
  useEffect(() => {
    latest.current = { onClose, busy };
  });

  useEffect(() => {
    const me = Symbol('dialog');
    openDialogs.push(me);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (openDialogs[openDialogs.length - 1] !== me) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      e.preventDefault();
      e.stopPropagation();
      const { busy: b, onClose: close } = latest.current;
      if (!(typeof b === 'function' ? b() : b)) close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const at = openDialogs.indexOf(me);
      if (at >= 0) openDialogs.splice(at, 1);
    };
  }, []);
}
