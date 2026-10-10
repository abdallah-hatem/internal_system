'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The frame every shipment dialog shares: a scrim, a fixed header and footer,
 * and a body that scrolls on its own.
 *
 * It renders into `document.body`, never where it is used. The panel sits on a
 * page that has forms of its own, and a `<form>` rendered inside another one is
 * invalid markup whose inner submit reaches the outer form (CLAUDE.md §13).
 *
 * `busy` blocks every way out — Escape, the scrim, the X — while a request is
 * in flight, so a dialog cannot be closed on a write whose answer is still
 * coming.
 */
export function ShipmentDialog({
  title,
  onClose,
  busy = false,
  size = 'md',
  children,
  footer,
  onSubmit,
  testId,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer: ReactNode;
  /** When set, body and footer are one form, so Enter submits it. */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  testId?: string;
}) {
  const tc = useTranslations('common');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  if (typeof document === 'undefined') return null;

  const body = (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
        {children}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-3 border-t border-border px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
        {footer}
      </div>
    </>
  );

  return createPortal(
    <div data-shipment-dialog={testId} className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* A scrim is black in either theme; a token would invert it in dark mode. */}
      <div
        className="fixed inset-0"
        style={{ backgroundColor: 'rgb(0 0 0 / 0.5)' }}
        onClick={() => !busy && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100vw-2rem)] flex-col rounded-2xl bg-background shadow-xl',
          size === 'sm' && 'sm:max-w-md',
          size === 'md' && 'sm:max-w-xl',
          size === 'lg' && 'sm:max-w-3xl',
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={tc('close')}
            className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:text-foreground disabled:cursor-not-allowed sm:size-8"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {onSubmit ? (
          <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {body}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
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
  onClick,
  disabled,
  pending,
  label,
  destructive,
}: {
  type?: 'submit' | 'button';
  onClick?: () => void;
  disabled?: boolean;
  pending?: boolean;
  label: string;
  destructive?: boolean;
}) {
  return (
    <button
      type={type}
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
export function DialogAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" data-testid="shipment-refusal" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

/**
 * Everything a shipment write can change on another screen: the panel, the
 * cycle and its status, stock, the "Receive stock" list, the shipments page and
 * every profit figure. Invalidated after each write, so nothing needs a reload.
 */
export const SHIPMENT_QUERY_KEYS = [
  'shipment',
  'cycle',
  'cycles',
  'inventory',
  'inventoryBatches',
  'landedCost',
  'analytics',
  'shipments',
];

export function useRefreshShipment() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of SHIPMENT_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** The input every quantity field uses: 16px on phones, no spinner, no wheel. */
export const qtyInputClass =
  'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-end text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';
