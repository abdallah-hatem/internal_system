import type { ReactNode } from 'react';
import { BrandMark } from '@/components/layout/brand-mark';

/**
 * The top of a printed document — the logo, its title, who it is from, and
 * its number and date on the other side, over a heavy rule. One header for
 * the contract and the invoice (owner, 2026-10-21: "use the same top bar at
 * the invoice like the contract"), so the two papers a shop is handed match.
 * `children` are the details: `<div><dt/><dd/></div>` rows.
 *
 * On a phone the details sit under the title: side by side, a 375px screen
 * squeezed the title to one word a line and pushed the number to the paper's
 * edge (UI audit M15). From `sm`, on paper and in the PDF sheet, they are
 * side by side as before.
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
    <header
      className="flex flex-col gap-3 border-b-2 border-foreground pb-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 print:flex-row print:items-start print:justify-between print:gap-4 sheet:flex-row sheet:items-start sheet:justify-between sheet:gap-4"
      data-print-keep
    >
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
