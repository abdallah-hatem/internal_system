'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn } from '@/lib/utils';

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
}: {
  href: string;
  label: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      // Rows elsewhere are clickable themselves (inventory expands, cards open
      // a detail); the link must not trigger those on its way out.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'underline-offset-2 transition-colors hover:text-primary-600 hover:underline',
        className,
      )}
    >
      {label}
    </Link>
  );
}

function useLocalePrefix() {
  const params = useParams();
  const locale = (params?.locale as string) ?? 'en';
  return `/${locale}`;
}

/** Falls back to plain text (or an em dash) when there is no record to link to. */
export function CustomerLink({
  id,
  name,
  className,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
}) {
  const prefix = useLocalePrefix();
  if (!name) return <span className={className}>—</span>;
  if (!id) return <span className={className}>{name}</span>;
  return <EntityLink href={`${prefix}/customers/${id}`} label={name} className={className} />;
}

export function ProductLink({
  id,
  name,
  className,
}: {
  id?: string | null;
  name?: string | null;
  className?: string;
}) {
  const prefix = useLocalePrefix();
  if (!name) return <span className={className}>—</span>;
  if (!id) return <span className={className}>{name}</span>;
  return <EntityLink href={`${prefix}/products/${id}`} label={name} className={className} />;
}
