import type { LucideIcon } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Money } from '@/components/ui/money';
import { parseDisplayedMoney, useNumberFormat } from '@/lib/numbers';

export interface StatTileProps {
  label: string;
  /**
   * The figure. A number, or a formatted string such as "1,234.00 EGP" — either
   * way it is re-rendered through the shared formatters, so a tile shows money
   * exactly as `Money` does everywhere else (number first, Latin digits) and a
   * count with Latin digits. Text that is not a figure is shown as given.
   */
  value: string | number;
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
  const figure = <TileFigure value={value} />;
  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
        <p className="mt-1 break-words text-base font-bold text-card-foreground sm:text-2xl">{figure}</p>
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

/**
 * Callers pass the tile a string they formatted themselves, and in Arabic that
 * string read "EGP 1,234.00" — the bare text sat in an RTL paragraph, so the
 * currency drifted in front of the number, unlike every `Money` on the same
 * screen (finding #38). Reading the figure back and rendering it through the
 * shared pieces fixes every tile without each caller having to.
 */
function TileFigure({ value }: { value: string | number }) {
  const { formatNumber } = useNumberFormat();
  const parsed = typeof value === 'number' ? { value, currency: null } : parseDisplayedMoney(value);
  if (!parsed) return <bdi>{value}</bdi>;
  if (parsed.currency) return <Money value={parsed.value} currency={parsed.currency} />;
  const decimals = typeof value === 'string' && /[.\u066b]\d/.test(value);
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {formatNumber(parsed.value, decimals ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {})}
    </span>
  );
}
