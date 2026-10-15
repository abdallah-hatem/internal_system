'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The store's one bottom sheet: the basket and "ask for a part" (owner,
 * 2026-10-15).
 *
 * Both were written by hand, each with its own portal, backdrop, Escape
 * listener and scroll lock, and each scrolled a region that ran edge to edge —
 * the same shape twice, so a fix to one would have been forgotten in the other.
 *
 * What it owns:
 *
 * - **It leaves the tree**, portaled to `<body>`, so a form inside it is never
 *   inside another form.
 * - **One way out.** The backdrop, the X and Escape all call `onClose`; the
 *   caller resets its transient state there, so nothing from last time is on
 *   screen when it opens again.
 * - **The page behind does not scroll** while it is open.
 * - **Height capped with `dvh`**, the header fixed. The content goes in
 *   `SheetBody` (the only part that scrolls) and `SheetFooter` (the actions,
 *   fixed under it), wrapped in a form or not as the caller needs.
 */
export function Sheet({
  open,
  onClose,
  title,
  maxHeight = '88dvh',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A dvh cap: a sheet never reaches the top of the screen. */
  maxHeight?: '88dvh' | '92dvh';
  children: ReactNode;
}) {
  const tCommon = useTranslations('common');
  const titleId = useId();
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    // The sheet scrolls; the page behind it must not, or a thumb drag near the
    // edge scrolls the wrong thing.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  // Opened by a tap, so always on the client; the check keeps a server render
  // from reaching for `document`.
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label={tCommon('close')}
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/40"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex w-full flex-col rounded-t-2xl bg-white shadow-xl sm:mx-auto sm:max-w-lg ${
          maxHeight === '92dvh' ? 'max-h-[92dvh]' : 'max-h-[88dvh]'
        }`}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon('close')}
            className="-me-1 flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The part of a sheet that scrolls. Inset from the sheet's sides so its bar
 * sits inside the card, never on its edge, with the padding reduced to keep
 * the content where it was.
 */
export function SheetBody({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="sheet-body"
      className={`scrollbar-clean mx-1.5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-4 ${className}`}
    >
      {children}
    </div>
  );
}

/** The sheet's actions, fixed under the body, clear of the home indicator. */
export function SheetFooter({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <footer
      data-slot="sheet-footer"
      className={`shrink-0 border-t border-gray-200 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] ${className}`}
    >
      {children}
    </footer>
  );
}

/** A form that is the sheet's content column: body and footer inside it, so Enter submits. */
export function SheetForm({ onSubmit, children }: { onSubmit: (e: React.FormEvent) => void; children: ReactNode }) {
  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      {children}
    </form>
  );
}
