'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, LogOut } from '@/components/ui/icons';
import { useAuth } from '@/lib/auth-context';
import { useCodeLabel } from '@/lib/labels';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

/**
 * Who is signed in, and the way out (owner, 2026-10-14).
 *
 * The header's avatar and name were a picture: nothing on any screen called
 * logout(), so a partner on a shared browser could not leave. The trigger is
 * the house popover (Radix), so Enter and Space open it, Escape closes it and
 * focus goes back to the trigger.
 */
export function AccountMenu() {
  const t = useTranslations('nav');
  const codeLabel = useCodeLabel();
  const { user, logout, isLoading } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const started = useRef(false);

  // The login response carries the name flat (`displayName`); the header read
  // `partner.displayName`, which that response never has, so every partner
  // saw their email where their name should be.
  const displayName = user?.displayName || user?.partner?.displayName || user?.email || '';
  const roleLabel = user?.role ? codeLabel('role', user.role) : '';

  const signOut = () => {
    if (started.current) return;
    started.current = true;
    setSigningOut(true);
    void logout();
  };

  // Who is signed in is read from storage after the first paint, so for that
  // moment the card had no name and simply was not there (owner, 2026-10-15).
  // Trace it instead: the same avatar, name and role lines, the same border.
  if (isLoading) return <AccountMenuSkeleton />;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('accountMenu')}
          data-testid="account-menu-trigger"
          className="flex cursor-pointer items-center gap-2 rounded-lg ps-3 pe-1 py-1 border-s border-border hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary-500"
        >
          {/* Was a hardcoded "A / Admin / Core Partner", so every partner
              saw the same name and could not tell whose session they were
              in — on a system where every action is attributed. */}
          <span
            aria-hidden="true"
            className="h-8 w-8 shrink-0 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold uppercase"
          >
            {(displayName || '?').charAt(0)}
          </span>
          <span className="hidden sm:block text-start">
            <span className="block max-w-48 truncate text-sm font-medium text-foreground">{displayName}</span>
            <span className="block text-xs text-muted-foreground">{roleLabel}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="account-menu"
        className="w-64 p-0"
      >
        <div className="border-b border-border px-4 py-3">
          <p className="truncate text-sm font-semibold text-foreground">{displayName}</p>
          {user?.email && user.email !== displayName && (
            // bdi, not dir="ltr" on the line: the address reads left to right
            // and still sits at the start edge in an Arabic panel.
            <p className="truncate text-xs text-muted-foreground"><bdi>{user.email}</bdi></p>
          )}
          {roleLabel && <p className="mt-1 text-xs text-muted-foreground">{roleLabel}</p>}
        </div>
        <div className="p-1">
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-start text-sm text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-wait disabled:opacity-70"
          >
            {signingOut ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut aria-hidden="true" className="h-4 w-4 rtl:-scale-x-100" />
            )}
            {/* The name stays "Log out" while it works, so it is the same
                control to a screen reader; the spinner says it is busy. */}
            <span>{t('logout')}</span>
            {signingOut && <span className="sr-only">{t('signingOut')}</span>}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The trigger's own box: border, padding, the 32px avatar and two lines. */
function AccountMenuSkeleton() {
  return (
    <div
      data-testid="account-menu-skeleton"
      aria-hidden="true"
      className="skeleton-appear flex items-center gap-2 rounded-lg ps-3 pe-1 py-1 border-s border-border"
    >
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <span className="hidden sm:block">
        <SkeletonText size="sm" className="w-24" />
        <SkeletonText size="xs" className="w-16" />
      </span>
    </div>
  );
}
