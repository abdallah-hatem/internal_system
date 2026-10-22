'use client';

import { useEffect, useId, useRef, type FormEvent, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Loader2, X } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { useEscapeToClose } from '@/lib/use-escape-to-close';
import { LatinText } from '@/components/ui/latin-text';

/**
 * The one dialog in the office app (owner, 2026-10-15).
 *
 * There were twenty, each written by hand: a local `Modal` in eleven pages and
 * a portal of its own in seven components. They agreed on almost nothing that
 * mattered — the New Product dialog scrolled its whole card, so the bar ran
 * down the rounded right edge and past the corner, and Cancel and Create
 * scrolled away with the form. A layout fix was the same edit twenty times.
 *
 * What every dialog now gets, from here:
 *
 * - **It leaves the tree.** Portaled to `<body>`, so a dialog opened from inside
 *   a form never puts a `<form>` inside a `<form>` (CLAUDE.md §13). Dialogs are
 *   siblings in mount order at one z-index, so the one opened last — the inner
 *   one, when they nest — paints on top. Dialogs at 60, the pickers at 90
 *   (`popover.tsx`), the toasts at 100.
 * - **Width follows content** through `size`, every size capped at the
 *   viewport's width less a margin.
 * - **Height is capped with `dvh`**, not `vh`: on a phone `vh` includes the
 *   area under the browser's toolbars, which is where Save would be.
 * - **Only the body scrolls.** The title above and the actions below (`footer`)
 *   stay put; a Save button that scrolls out of view is one nobody finds.
 * - **The bar stays inside the card.** The scrollbar is drawn on the scrolling
 *   element's own edge, so the body is inset from the card's sides (`mx-1.5`,
 *   its padding reduced to match) and capped by the header and footer — its bar
 *   never sits on the rounded border or runs past a corner. Without a footer it
 *   keeps the same inset from the bottom.
 * - **Escape and the scrim close it**, through the same `onClose` as Cancel and
 *   the X, and none of them does while `busy` (a save in flight). Escape
 *   belongs to an open picker first, and closes only the innermost dialog
 *   (`use-escape-to-close`).
 *
 * A form gets its actions into the footer one of two ways:
 *
 * - `onSubmit` on the dialog: body and footer are one `<form noValidate>`, so a
 *   submit button in the footer submits it and Enter in a field does too.
 * - Its own form in the body (a `ValidatedForm`, a shared entity form) with an
 *   `id`, and `form={id}` on the footer's submit:
 *
 *   ```tsx
 *   <Dialog title={t('create')} onClose={close}
 *     footer={<FormActions form="product-create-form" onCancel={close} … />}>
 *     <ValidatedForm id="product-create-form" onSubmit={save}>…</ValidatedForm>
 *   </Dialog>
 *   ```
 *
 *   A submit button carrying `form` is that form's own button, so it submits
 *   it, and Enter in a field still does: implicit submission uses the first
 *   submit button whose form owner is the form, wherever it sits.
 */

const SIZES = {
  sm: 'max-w-md', // a confirmation, a single field
  md: 'max-w-xl', // a form
  lg: 'max-w-3xl', // a two-column form, a detail view, a table of lines
  xl: 'max-w-5xl', // wide tables
} as const;

export type DialogSize = keyof typeof SIZES;

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'onSubmit'> {
  title: ReactNode;
  /**
   * A second, quieter header line naming what the dialog is about — a product,
   * a cycle. Clamped to one line, so a long name cannot push the title to four
   * lines on a phone (UI audit #34); the full text stays in its `title`.
   */
  subtitle?: string;
  /** A sentence under the title, in the fixed header; it wraps. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** The actions — Save, Create, Cancel — fixed under the scrolling body. */
  footer?: ReactNode;
  /** When set, body and footer are one form, so the footer's submit and Enter submit it. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  size?: DialogSize;
  /** A save in flight: Escape, the scrim and the X do nothing until it ends. */
  busy?: boolean | (() => boolean);
  /** The X in the header. A confirmation whose footer already says Cancel may drop it. */
  showClose?: boolean;
  bodyClassName?: string;
  /** Attributes for the card itself (`data-testid` and the like); the rest go on the outer layer. */
  cardProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
}

export function Dialog({
  title,
  subtitle,
  description,
  onClose,
  children,
  footer,
  onSubmit,
  size = 'md',
  busy = false,
  showClose = true,
  bodyClassName,
  cardProps,
  className,
  ...outer
}: DialogProps) {
  const tc = useTranslations('common');
  const titleId = useId();
  const descriptionId = useId();
  const card = useRef<HTMLDivElement>(null);
  const isBusy = () => (typeof busy === 'function' ? busy() : busy);

  useEscapeToClose(onClose, busy);

  // Focus moves into the dialog when it opens (unless a field inside took it
  // with autoFocus) and back to whatever opened it when it closes, so a
  // keyboard user is neither left behind the scrim nor dropped at the top of
  // the page afterwards.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (card.current && !card.current.contains(document.activeElement)) {
      card.current.focus({ preventScroll: true });
    }
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  // Opened by a click, so always on the client; the check keeps a server
  // render from reaching for `document`.
  if (typeof document === 'undefined') return null;

  const content = (
    <>
      <div
        data-dialog-body=""
        className={cn(
          'scrollbar-clean mx-1.5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-[1.125rem] py-6',
          // No footer to cap it: keep the same inset from the rounded bottom.
          !footer && 'mb-1.5 pb-[1.125rem]',
          bodyClassName,
        )}
      >
        {children}
      </div>

      {footer && (
        <div
          data-dialog-footer=""
          className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-border px-6 py-4"
        >
          {footer}
        </div>
      )}
    </>
  );

  return createPortal(
    <div
      data-dialog=""
      {...outer}
      // The card floats inside the screen's safe area: the margin, or the
      // notch and home indicator when they are larger. The footer used to add
      // the home indicator's height under its buttons on a card that never
      // reached the bottom edge — an empty strip on every phone (owner 2026-10-17).
      className={cn(
        'fixed inset-0 z-[60] flex items-center justify-center overflow-hidden p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pb-[max(1rem,env(safe-area-inset-bottom,0px))]',
        className,
      )}
    >
      {/* A scrim is black in either theme; a token would invert it in dark mode. */}
      <div
        data-dialog-scrim=""
        aria-hidden="true"
        className="fixed inset-0"
        style={{ backgroundColor: 'rgb(0 0 0 / 0.5)' }}
        onClick={() => !isBusy() && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        {...cardProps}
        ref={card}
        data-dialog-card=""
        className={cn(
          'relative flex max-h-full w-full max-w-[calc(100vw-2rem)] flex-col rounded-2xl bg-card text-card-foreground shadow-xl outline-none',
          SIZES[size],
          cardProps?.className,
        )}
      >
        <div data-dialog-header="" className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-foreground [overflow-wrap:anywhere]">
              {title}
            </h2>
            {subtitle && (
              <p data-testid="dialog-subtitle" className="text-sm text-muted-foreground">
                <LatinText truncate>{subtitle}</LatinText>
              </p>
            )}
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {showClose && (
            <button
              type="button"
              onClick={() => !isBusy() && onClose()}
              disabled={typeof busy === 'boolean' ? busy : undefined}
              aria-label={tc('close')}
              className="-m-1.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed sm:size-8"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {onSubmit ? (
          <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The footer's quiet button. Always `type="button"`: it must never submit. */
export function DialogCancel({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 cursor-pointer rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted disabled:cursor-not-allowed sm:min-h-0"
    >
      {label}
    </button>
  );
}

/** The footer's main button, busy while its request runs. */
export function DialogPrimary({
  type = 'submit',
  form,
  onClick,
  disabled,
  pending,
  label,
  destructive,
}: {
  type?: 'submit' | 'button';
  /** The form it submits, when that form is in the body rather than the dialog's own. */
  form?: string;
  onClick?: () => void;
  disabled?: boolean;
  pending?: boolean;
  label: string;
  destructive?: boolean;
}) {
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0',
        destructive
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : 'bg-primary text-primary-foreground hover:bg-primary/90',
      )}
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {label}
    </button>
  );
}

/** A refusal or a form problem, shown inside the dialog that caused it. */
export function DialogAlert({ message, testId = 'shipment-refusal' }: { message: string | null; testId?: string }) {
  if (!message) return null;
  return (
    <p role="alert" data-testid={testId} className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}
