import type { ReactNode } from 'react';
import { BrandMark } from '@/components/layout/brand-mark';

/**
 * The top of a printed document — the logo, its title, who it is from, and
 * its number and date on the other side, over a heavy rule. One header for
 * the contract and the invoice (owner, 2026-10-21: "use the same top bar at
 * the invoice like the contract"), so the two papers a shop is handed match.
 * `children` are the details: `<div><dt/><dd/></div>` rows.
 */
export function DocumentHeader({
  title,
  tagline,
  titleTestId,
  children,
}: {
  title: string;
  tagline: string;
  titleTestId?: string;
  children: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b-2 border-foreground pb-3" data-print-keep>
      <div className="flex items-center gap-3">
        <BrandMark size={44} />
        <div>
          <h1 className="text-[22px] font-bold leading-tight" data-testid={titleTestId}>{title}</h1>
          <p className="text-xs text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <dl className="shrink-0 text-xs text-muted-foreground">{children}</dl>
    </header>
  );
}
