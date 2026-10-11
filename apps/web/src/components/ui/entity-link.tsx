'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LatinText } from '@/components/ui/latin-text';

/**
 * A named record in a table, linked to its own page.
 *
 * A customer or product name is the natural thing to click when you want to
 * know more, but the only route to either detail page used to be an eye icon
 * in the row's action column — and rows in other tables (payments, sales,
 * inventory) had no route at all.
 *
 * Styled as text that reveals itself on hover rather than a blue link: these
 * appear in nearly every row, and colouring them all would turn a table into a
 * wall of links.
 */
function EntityLink({
  href,
  label,
  className,
  truncate = false,
}: {
  href: string;
  label: string;
  className?: string;
  truncate?: boolean;
}) {
  return (
    <Link
      href={href}
      // Rows elsewhere are clickable themselves (inventory expands, cards open
      // a detail); the link must not trigger those on its way out.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'underline-offset-2 transition-colors hover:text-primary-600 hover:underline',
        truncate && 'block min-w-0',
        className,
      )}
    >
      <LatinText truncate={truncate}>{label}</LatinText>
    </Link>
  );
}

function useLocalePrefix() {
  const params = useParams();
  const locale = (params?.locale as string) ?? 'en';
  return `/${locale}`;
}

/**
 * Falls back to plain text (or an em dash) when there is no record to link to.
 *
 * Names sit in `<bdi>` (finding #21): a Latin name in an Arabic row is its own
 * LTR run, so "Delta Motors Co." keeps its full stop at the end and a truncated
 * name loses its tail, not its start.
 */
export function CustomerLink({
  id,
  name,
  className,
  truncate = false,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
  /** Cut a long name at its end with an ellipsis, in either direction. */
  truncate?: boolean;
}) {
  const prefix = useLocalePrefix();
  if (!name) return <span className={className}>—</span>;
  if (!id) return <LatinText truncate={truncate} className={className}>{name}</LatinText>;
  return <EntityLink href={`${prefix}/customers/${id}`} label={name} className={className} truncate={truncate} />;
}

/** A friend who paid a supplier for us (§18), to his own page. */
export function LenderLink({
  id,
  name,
  className,
  truncate = false,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
  truncate?: boolean;
}) {
  const prefix = useLocalePrefix();
  if (!name) return <span className={className}>—</span>;
  if (!id) return <LatinText truncate={truncate} className={className}>{name}</LatinText>;
  return <EntityLink href={`${prefix}/lenders/${id}`} label={name} className={className} truncate={truncate} />;
}

export function ProductLink({
  id,
  name,
  className,
  truncate = false,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
  /** Cut a long name at its end with an ellipsis, in either direction. */
  truncate?: boolean;
}) {
  const prefix = useLocalePrefix();
  if (!name) return <span className={className}>—</span>;
  if (!id) return <LatinText truncate={truncate} className={className}>{name}</LatinText>;
  return <EntityLink href={`${prefix}/products/${id}`} label={name} className={className} truncate={truncate} />;
}
