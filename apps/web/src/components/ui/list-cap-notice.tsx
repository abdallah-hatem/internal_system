'use client';
import { useTranslations } from 'next-intl';
import { Info } from '@/components/ui/icons';
import { useNumberFormat } from '@/lib/numbers';

/**
 * Said when a list stopped at `LIST_CAP` (see `lib/list-all.ts`), so a list
 * that is not complete never looks complete. Renders nothing otherwise.
 */
export function ListCapNotice({ capped, count }: { capped: boolean; count: number }) {
  const tc = useTranslations('common');
  const { formatNumber } = useNumberFormat();
  if (!capped) return null;
  return (
    <p
      role="status"
      data-testid="list-capped"
      className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <Info className="h-4 w-4 shrink-0" aria-hidden />
      {tc('listCapped', { count: formatNumber(count) })}
    </p>
  );
}
