import type { FocusEvent, MouseEvent } from 'react';

/**
 * Select a field's contents when it takes focus.
 *
 * Item rows start at 1 and 0 rather than empty, so entering a real value meant
 * clearing the placeholder first — and a missed keystroke turns 5 into 15
 * without looking wrong. Selecting on focus makes typing replace, which is what
 * everyone expects of a field that already holds a number.
 *
 * Spread onto an input: `<input {...selectOnFocus} />`.
 *
 * The mouseup handler is the part that makes it work at all. A click fires
 * mousedown → focus → mouseup, and mouseup collapses the selection to a caret
 * — so selecting during focus looks correct and is undone a moment later.
 * Deferring the select to the next frame does not help; it is undone just the
 * same. The collapse has to be suppressed, and only for the click that brought
 * the field into focus: a second click inside an already-focused field should
 * still place the caret where the user aimed.
 *
 * The set tracks which elements are in that first click, so the suppression
 * applies once and per field rather than globally.
 */
const awaitingFirstClick = new WeakSet<HTMLInputElement>();

export const selectOnFocus = {
  onFocus: (e: FocusEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    awaitingFirstClick.add(input);
    input.select();
  },
  onMouseUp: (e: MouseEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (!awaitingFirstClick.has(input)) return;
    awaitingFirstClick.delete(input);
    e.preventDefault();
  },
  onBlur: (e: FocusEvent<HTMLInputElement>) => {
    awaitingFirstClick.delete(e.currentTarget);
  },
};
