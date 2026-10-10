import type { LucideIcon } from 'lucide-react';
import { Link } from '@/i18n/navigation';

export interface StatTileProps {
  label: string;
  value: string;
  icon: LucideIcon;
  /** Background class of the icon badge. */
  color: string;
  /** The list behind the figure. Null renders a plain tile (the role cannot open it). */
  href: string | null;
  testId?: string;
}

/**
 * One dashboard figure. With an `href` the whole tile is the link, so the
 * target is the full card on a phone rather than a small "view" word.
 */
export function StatTile({ label, value, icon: Icon, color, href, testId }: StatTileProps) {
  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
        <p className="mt-1 break-words text-base font-bold text-card-foreground sm:text-2xl">{value}</p>
      </div>
      <div className={`${color} hidden flex-shrink-0 rounded-lg p-3 sm:block`} aria-hidden="true">
        <Icon className="size-6 text-primary-foreground" />
      </div>
    </div>
  );

  const frame = 'block min-h-11 rounded-xl border border-border bg-card p-3 sm:p-6';

  if (!href) {
    return (
      <div className={frame} data-testid={testId}>
        {body}
      </div>
    );
  }

  return (
    <Link
      href={href}
      data-testid={testId}
      className={`${frame} cursor-pointer touch-manipulation transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-[0.99]`}
    >
      {body}
    </Link>
  );
}
