import type { IconComponent } from '@/components/ui/icons';
import { Link } from '@/i18n/navigation';
import { Money } from '@/components/ui/money';
import { parseDisplayedMoney, useNumberFormat } from '@/lib/numbers';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

export interface StatTileProps {
  label: string;
  /**
   * The figure. A number, or a formatted string such as "1,234.00 EGP" — either
   * way it is re-rendered through the shared formatters, so a tile shows money
   * exactly as `Money` does everywhere else (number first, Latin digits) and a
   * count with Latin digits. Text that is not a figure is shown as given.
   */
  value: string | number;
  icon: IconComponent;
  /** Background class of the icon badge. */
  color: string;
  /** The list behind the figure. Null renders a plain tile (the role cannot open it). */
  href: string | null;
  testId?: string;
  /** A second line under the figure — what it is made of. */
  sub?: React.ReactNode;
  /** Extra classes for the frame — a grid span, say. */
  className?: string;
}

/**
 * Four tiles across a row leave a figure about 170px beside its badge, and
 * "669,584.64 EGP" in the 2xl face is 200px — so it broke onto two lines at
 * 1440 (2026-10-23). Read off the width of the group the tile sits in (an
 * `@container`, the dashboard's TileGroup), not the screen: from 68rem, where
 * the group goes four across, the figure and badge step down a size, and back
 * up from 76rem, where four 2xl figures fit. Outside a container nothing changes.
 */
const FOUR_ACROSS_FIGURE = '@[68rem]:text-xl @[76rem]:text-2xl';
const FOUR_ACROSS_FIGURE_LINE = '@[68rem]:h-7 @[76rem]:h-8';
const FOUR_ACROSS_BADGE = '@[68rem]:p-2 @[76rem]:p-3';
const FOUR_ACROSS_ICON = '@[68rem]:size-5 @[76rem]:size-6';
const FOUR_ACROSS_BADGE_SKELETON = '@[68rem]:size-9 @[76rem]:size-12';

/**
 * One dashboard figure. With an `href` the whole tile is the link, so the
 * target is the full card on a phone rather than a small "view" word.
 */
export function StatTile({ label, value, icon: Icon, color, href, testId, sub, className = '' }: StatTileProps) {
  const figure = <TileFigure value={value} />;
  const body = (
    // Phone: the icon sits above the label, smaller; from sm up, beside the
    // figure as before. The phone used to drop it, and the dashboard read as a
    // wall of grey numbers (owner 2026-10-18, option A).
    <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
        <p className={`mt-1 break-words text-base font-bold text-card-foreground sm:text-2xl ${FOUR_ACROSS_FIGURE}`}>{figure}</p>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </div>
      <div data-testid="tile-icon" className={`${color} flex-shrink-0 rounded-lg p-1.5 sm:p-3 ${FOUR_ACROSS_BADGE}`} aria-hidden="true">
        <Icon className={`size-4 text-primary-foreground sm:size-6 ${FOUR_ACROSS_ICON}`} />
      </div>
    </div>
  );

  const frame = `block min-h-11 rounded-xl border border-border bg-card p-3 sm:p-6 ${className}`;

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
 * A tile that has not arrived, traced from `StatTile`: the same frame, the
 * label and figure lines at their responsive sizes, and the icon badge
 * (`p-3` round a `size-6` icon, 48px) that sets the height from `sm` up.
 * `sub` adds the second line the owed-to-lenders tile carries.
 */
export function StatTileSkeleton({ sub = false, className = '' }: { sub?: boolean; className?: string }) {
  return (
    <div data-testid="skeleton-row" className={`block min-h-11 rounded-xl border border-border bg-card p-3 sm:p-6 ${className}`}>
      <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0 w-full flex-1">
          <SkeletonText size="xs" lineClassName="sm:h-5" className="w-20 sm:h-3 sm:w-24" />
          <SkeletonText size="base" lineClassName={`mt-1 sm:h-8 ${FOUR_ACROSS_FIGURE_LINE}`} className="w-24 sm:h-5 sm:w-36" />
          {sub && <SkeletonText size="xs" lineClassName="mt-1" className="w-28" />}
        </div>
        <Skeleton className={`size-7 flex-shrink-0 rounded-lg sm:size-12 ${FOUR_ACROSS_BADGE_SKELETON}`} />
      </div>
    </div>
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
