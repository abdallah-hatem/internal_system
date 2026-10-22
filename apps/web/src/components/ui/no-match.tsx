'use client';

import { Search } from '@/components/ui/icons';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * What a list shows when it has records but none match the search or filter.
 *
 *   <NoMatch onClear={() => setSearch('')} />
 *   <NoMatch filtered onClear={() => { setSearch(''); setStatus(''); }} />
 *
 * The same compact empty state every other "nothing here" uses, with the way
 * back: a button that clears what is hiding the rows (re-audit N7). It used to
 * be a bare sentence in each page's own grey, and getting the list back meant
 * finding the search box and deleting the text by hand.
 *
 * `filtered` says a filter, not only the search, is narrowing the list, so the
 * button promises to clear both — `onClear` must then reset both.
 */
export function NoMatch({
  onClear,
  filtered = false,
  className,
}: {
  onClear: () => void;
  filtered?: boolean;
  className?: string;
}) {
  const tc = useTranslations('common');
  return (
    <EmptyState
      size="compact"
      icon={Search}
      title={tc('noMatch')}
      action={{ label: filtered ? tc('clearSearchAndFilters') : tc('clearSearch'), onClick: onClear }}
      className={className}
    />
  );
}
