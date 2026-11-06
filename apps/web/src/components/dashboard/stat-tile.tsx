import type { IconComponent } from '@/components/ui/icons';
import { Link } from '@/i18n/navigation';
import { Money } from '@/components/ui/money';
import { formatMoney, parseDisplayedMoney, useNumberFormat } from '@/lib/numbers';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

/**
 * A small pill beside a tile's label. `label` is what is shown; `srLabel` what
 * a screen reader hears instead ("22 units in stock"). `tone` colours it:
 * muted for a count (Stock's units), success for a profit and danger for a
 * loss (the cash tiles' profit pill, owner 2026-11-06).
 */
export interface StatTileBadge {
  label: React.ReactNode;
  srLabel: string;
  tone?: 'muted' | 'success' | 'danger';
}

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
  /**
   * A small pill beside the label — the Stock tile's units, the cash tiles'
   * profit (owner 2026-11-06).
   */
  badge?: StatTileBadge;
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
const FOUR_ACROSS_FIGURE_LINE = '@[68rem]:h-7 @[76rem]:h-8';
const FOUR_ACROSS_BADGE = '@[68rem]:p-2 @[76rem]:p-3';
const FOUR_ACROSS_ICON = '@[68rem]:size-5 @[76rem]:size-6';
const FOUR_ACROSS_BADGE_SKELETON = '@[68rem]:size-9 @[76rem]:size-12';

/**
 * One dashboard figure. With an `href` the whole tile is the link, so the
 * target is the full card on a phone rather than a small "view" word.
 */
/**
 * The figure's size and line, as variables set on the tile's text column, which
 * is also the container the figure measures itself against (below). Set there,
 * the `@[68rem]` steps still read the TileGroup's width: an element's own
 * container queries look at its ancestors, never at itself.
 */
const FIGURE_SIZE =
  '[--figure:1rem] [--figure-line:1.5rem] sm:[--figure:1.5rem] sm:[--figure-line:2rem] ' +
  '@[68rem]:[--figure:1.25rem] @[68rem]:[--figure-line:1.75rem] @[76rem]:[--figure:1.5rem] @[76rem]:[--figure-line:2rem]';

/**
 * The share of an em one character of a bold Plex Sans figure takes on average:
 * measured 0.53–0.54 for "-4,692,036.46 EGP", "19,847,808.93 EGP" and
 * "-123,456,789.01 EGP" (2026-11-02); 0.6 leaves room for a rounding renderer.
 */
const EM_PER_CHAR = 0.6;

/**
 * The muted pill beside a tile's label. One line of text-xs (16px) tall, so the
 * label line keeps the height its skeleton traces, on a phone (text-xs) and
 * from sm (text-sm, 20px) alike.
 */
const PILL = 'inline-flex items-center px-1.5 text-[11px] font-medium leading-4 tabular-nums';
const LABEL_BADGE = `${PILL} shrink-0 whitespace-nowrap rounded-full`;
/**
 * The worded pill on a phone's icon row. "+5,011,430 profit to come" is wider
 * than a 320 or 375 half-width tile beside its icon, and held on one line it
 * ran out of the tile and was clipped ("…profit to com", UI re-check S1/S2,
 * 2026-11-06). The row wraps, so the pill drops under the icon when it does not
 * fit beside it, and the pill's own words wrap within the tile's width; only
 * its figure stays whole (useProfitPill). rounded-lg is a full round on one
 * line and still a pill on two.
 */
const PHONE_BADGE = `${PILL} min-w-0 max-w-full rounded-lg`;
const BADGE_TONE: Record<NonNullable<StatTileBadge['tone']>, string> = {
  muted: 'bg-muted text-muted-foreground',
  success: 'bg-success/10 text-success',
  danger: 'bg-destructive/10 text-destructive',
};

export function StatTile({ label, value, icon: Icon, color, href, testId, sub, badge, className = '' }: StatTileProps) {
  const figure = <TileFigure value={value} />;
  const chars = useFigureText(value).length;
  // A worded pill ("+25,502 profit") does not fit beside a label in a phone's
  // half-width tile: "Cash from sales" was cut to "Cash f…" at 390
  // (2026-11-06). There it sits on the icon's row instead, at the other end,
  // where the row has room (and below the icon when even that is too narrow,
  // PHONE_BADGE); from sm up, beside the label as a count does.
  const worded = badge !== undefined && typeof badge.label !== 'string';
  const pill = (testIdSuffix: string, base: string, extra: string) =>
    badge && (
      <span
        data-testid={`stat-badge${testIdSuffix}`}
        data-tone={badge.tone ?? 'muted'}
        aria-hidden="true"
        // A bare count reads left to right; a worded pill ("+25,502
        // profit", "+25,502 ربح") follows the page and isolates its own figure.
        dir={worded ? undefined : 'ltr'}
        className={`${base} ${BADGE_TONE[badge.tone ?? 'muted']} ${extra}`}
      >
        {/* One inline run: as flex items the figure and the word lost the
            space between them ("+308,513profit"). */}
        <span>{badge.label}</span>
      </span>
    );
  const icon = (
    <div data-testid="tile-icon" className={`${color} flex-shrink-0 rounded-lg p-1.5 sm:p-3 ${FOUR_ACROSS_BADGE}`} aria-hidden="true">
      <Icon className={`size-4 text-primary-foreground sm:size-6 ${FOUR_ACROSS_ICON}`} />
    </div>
  );
  const body = (
    // Phone: the icon sits above the label, smaller; from sm up, beside the
    // figure as before. The phone used to drop it, and the dashboard read as a
    // wall of grey numbers (owner 2026-10-18, option A).
    <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
      <div className={`@container w-full min-w-0 flex-1 ${FIGURE_SIZE}`}>
        {badge ? (
          <p data-testid="stat-label" className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground sm:text-sm">
            <span className="min-w-0 truncate">{label}</span>
            {pill('', LABEL_BADGE, worded ? 'max-sm:hidden' : '')}
            <span className="sr-only">{badge.srLabel}</span>
          </p>
        ) : (
          <p data-testid="stat-label" className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
        )}
        {/* Always one line (2026-11-02): an eight-digit figure, "19,847,808.93
            EGP", wrapped onto a second line at 1440 and at 390, and the tile
            came out 24–34px taller than its skeleton. The figure keeps its
            size while it fits, and steps down only as far as its length needs
            to fit the column (`cqi`, the column's width); its line stays the
            skeleton's height either way. */}
        <p
          data-testid="stat-figure"
          className="mt-1 whitespace-nowrap font-bold tabular-nums text-card-foreground"
          style={{
            fontSize: `min(var(--figure), calc(100cqi / ${(Math.max(chars, 1) * EM_PER_CHAR).toFixed(2)}))`,
            lineHeight: 'var(--figure-line)',
          }}
        >
          {figure}
        </p>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </div>
      {worded ? (
        <div data-testid="stat-icon-row" className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto">
          {icon}
          {pill('-phone', PHONE_BADGE, 'sm:hidden')}
        </div>
      ) : (
        icon
      )}
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
 * `sub` adds the second line a tile carries under its figure; `badge` the
 * small count pill beside the label (the Stock tile's units).
 */
export function StatTileSkeleton({
  sub = false,
  badge = false,
  className = '',
}: {
  sub?: boolean;
  /** `'wide'` for a worded pill ("+25,502 profit"), `true` for a count. */
  badge?: boolean | 'wide';
  className?: string;
}) {
  return (
    <div data-testid="skeleton-row" className={`block min-h-11 rounded-xl border border-border bg-card p-3 sm:p-6 ${className}`}>
      <div className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0 w-full flex-1">
          {badge ? (
            <div className="flex items-center gap-1.5">
              <SkeletonText size="xs" lineClassName="sm:h-5" className="w-14 sm:h-3 sm:w-16" />
              <Skeleton
                data-testid="skeleton-badge"
                className={`h-4 shrink-0 rounded-full ${badge === 'wide' ? 'w-20 max-sm:hidden' : 'w-7'}`}
              />
            </div>
          ) : (
            <SkeletonText size="xs" lineClassName="sm:h-5" className="w-20 sm:h-3 sm:w-24" />
          )}
          <SkeletonText size="base" lineClassName={`mt-1 sm:h-8 ${FOUR_ACROSS_FIGURE_LINE}`} className="w-24 sm:h-5 sm:w-36" />
          {sub && <SkeletonText size="xs" lineClassName="mt-1" className="w-28" />}
        </div>
        {badge === 'wide' ? (
          // On a phone the worded pill sits on the icon's row (StatTile).
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto">
            <Skeleton className={`size-7 flex-shrink-0 rounded-lg sm:size-12 ${FOUR_ACROSS_BADGE_SKELETON}`} />
            <Skeleton data-testid="skeleton-badge-phone" className="h-4 w-20 shrink-0 rounded-full sm:hidden" />
          </div>
        ) : (
          <Skeleton className={`size-7 flex-shrink-0 rounded-lg sm:size-12 ${FOUR_ACROSS_BADGE_SKELETON}`} />
        )}
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
/** The figure as `TileFigure` draws it, as text — for its length. */
function useFigureText(value: string | number): string {
  const { formatNumber, locale } = useNumberFormat();
  const parsed = typeof value === 'number' ? { value, currency: null } : parseDisplayedMoney(value);
  if (!parsed) return String(value);
  if (parsed.currency) return formatMoney(parsed.value, { locale, currency: parsed.currency });
  const decimals = typeof value === 'string' && /[.\u066b]\d/.test(value);
  return formatNumber(parsed.value, decimals ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
}

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
