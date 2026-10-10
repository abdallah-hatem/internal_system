import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A value typed by a person — a product, provider or customer name, a code —
 * placed inside a line whose direction follows the page.
 *
 *   <LatinText>{provider.name}</LatinText>
 *   <LatinText truncate>{line.productName}</LatinText>
 *
 * Without isolation the bidi algorithm reorders a Latin run against the Arabic
 * around it: "Wizard Sea Freight Ltd." shows its full stop in front of the
 * name, and a truncated name loses its start instead of its end (UI audit #21,
 * re-audit N2/N3).
 *
 * - Plain: a `<bdi>`, which takes its direction from its own first strong
 *   letter. Latin reads left to right with its punctuation in place; an Arabic
 *   name stays right to left.
 * - `truncate`: a block that resolves its own direction from the content
 *   (`dir="auto"`), so the ellipsis lands where the text ends — on the right
 *   for Latin, on the left for Arabic. Its alignment follows the parent
 *   (`text-align: match-parent`), so a short Latin name in an Arabic row still
 *   sits on the row's start edge rather than jumping to the left.
 *
 * The full value is the element's `title` when truncated, so a cut-off name can
 * still be read on hover.
 *
 * `dir="ltr"` forces left to right for a value with no letters in it — a phone
 * number such as "+201000000777". With nothing strong to read, `auto` cannot
 * tell which way it goes, and the "+" ended up after the digits (re-audit N4).
 */
export function LatinText({
  children,
  truncate = false,
  className,
  title,
  dir = 'auto',
}: {
  children: ReactNode;
  truncate?: boolean;
  /** `auto` (default) reads the direction from the text; `ltr` for phone numbers and other digit runs. */
  dir?: 'auto' | 'ltr';
  className?: string;
  /** Hover text for a truncated value. Defaults to the text when it is a string. */
  title?: string;
}) {
  if (!truncate) {
    return (
      <bdi data-slot="latin-text" dir={dir} className={className}>
        {children}
      </bdi>
    );
  }
  const hover = title ?? (typeof children === 'string' ? children : undefined);
  return (
    <span
      data-slot="latin-text"
      data-truncate=""
      dir={dir}
      title={hover}
      className={cn('block min-w-0 truncate [text-align:match-parent] [unicode-bidi:isolate]', className)}
    >
      {children}
    </span>
  );
}
