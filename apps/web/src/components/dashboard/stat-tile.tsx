import type { IconComponent } from '@/components/ui/icons';
import { Link } from '@/i18n/navigation';
import { Money } from '@/components/ui/money';
import { formatMoney, parseDisplayedMoney, useNumberFormat } from '@/lib/numbers';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Info } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { useId } from 'react';

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
  /**
   * The words `label` shows, as plain text ("+25,502 profit"), for their
   * length: on a phone a worded pill steps its type down to fit its line
   * (PHONE_PILL_FONT). Without it the pill keeps its size and wraps instead.
   */
  text?: string;
  /**
   * What the figure is, behind a small (i) right after the pill (owner
   * 2026-11-06, the profit pills). Opens on a tap, not a hover, so a phone
   * can read it too.
   */
  info?: { buttonLabel: string; title: string; body: string };
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
 * The worded pill on a phone, on its own line under the icon. "+5,011,430
 * profit to come" is wider than a 320 or 375 half-width tile beside its icon,
 * and held on one line it ran out of the tile and was clipped ("…profit to
 * com", UI re-check S1/S2, 2026-11-06). It then sat beside the icon and wrapped
 * under it only when it did not fit, so the tile's height hung on the figure's
 * length and the screen's width, and no skeleton could trace it: at 390,
 * "+135,775 profit" and its (i) wrapped and the first tile came out 22px taller
 * than its skeleton (CI, 2026-11-07). Always under the icon, the tile is one
 * height whatever the figure. The pill's own words still wrap within the
 * tile's width if a figure is ever too long for its line; only the figure
 * stays whole (useProfitPill). rounded-lg is a full round on one line and
 * still a pill on two.
 */
const PHONE_BADGE = `${PILL} min-w-0 max-w-full rounded-lg`;
/**
 * A worded pill on its phone line keeps to one line by stepping its type down
 * from 11px as far as its length needs, as the figure does (EM_PER_CHAR): at
 * 320, "+1,234,568 profit" in 11px wrapped to two lines and the tile came out
 * 14px taller than its skeleton. Measured 0.47–0.49 of an em a character in
 * the pill's face, en and ar (2026-11-07); 0.55 leaves room. The line is the
 * pill line's width (`cqi`, PHONE_PILL_LINE) less the (i) and its gap (20px)
 * and the pill's own padding (12px). It stops at 9px: a figure too long even
 * then wraps its words inside the tile, never past it (PHONE_BADGE) — at 320
 * that is past "+12,345,678 profit", or "+N profit to come" from 6 digits.
 */
const PILL_EM_PER_CHAR = 0.55;
export const PHONE_PILL_FONT = (text: string | undefined) =>
  text
    ? `max(9px, min(11px, calc((100cqi - 32px) / ${(Math.max(text.length, 1) * PILL_EM_PER_CHAR).toFixed(2)})))`
    : undefined;
/** The phone's line for the worded pill, under the icon; the container the pill's type measures against. */
const PHONE_PILL_LINE = '@container flex w-full sm:hidden';
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
  // (2026-11-06). There it sits on its own line under the icon instead
  // (PHONE_BADGE); from sm up, beside the label as a count does.
  const worded = badge !== undefined && typeof badge.label !== 'string';
  const ids = useId();
  const labelId = `${ids}-label`;
  const srId = `${ids}-sr`;
  const figureId = `${ids}-figure`;
  const subId = `${ids}-sub`;
  // The pill and its (i), as one unit: the (i) only ever appears with a pill,
  // and hides with it at the breakpoint where the pill sits elsewhere. On the
  // phone's line under the icon the unit may shrink and wrap with the pill
  // (PHONE_BADGE).
  const pill = (testIdSuffix: string, base: string, extra: string) =>
    badge &&
    (badge.info ? (
      <span
        data-testid={`stat-badge-group${testIdSuffix}`}
        className={`inline-flex items-center gap-1 ${base === PHONE_BADGE ? 'min-w-0 max-w-full' : 'shrink-0'} ${extra}`}
      >
        {pillOnly(testIdSuffix, base, extra)}
        <BadgeInfo info={badge.info} testId={`stat-badge-info${testIdSuffix}`} />
      </span>
    ) : (
      pillOnly(testIdSuffix, base, extra)
    ));
  const pillOnly = (testIdSuffix: string, base: string, extra: string) =>
    badge && (
      <span
        data-testid={`stat-badge${testIdSuffix}`}
        data-tone={badge.tone ?? 'muted'}
        aria-hidden="true"
        // A bare count reads left to right; a worded pill ("+25,502
        // profit", "+25,502 ربح") follows the page and isolates its own figure.
        dir={worded ? undefined : 'ltr'}
        className={`${base} ${BADGE_TONE[badge.tone ?? 'muted']} ${extra}`}
        style={base === PHONE_BADGE ? { fontSize: PHONE_PILL_FONT(badge.text) } : undefined}
        // The length the phone pill's type is fitted to (jsdom drops `cqi` from style).
        data-fit-chars={base === PHONE_BADGE ? badge.text?.length : undefined}
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
            <span id={labelId} className="min-w-0 truncate">{label}</span>
            {pill('', LABEL_BADGE, worded ? 'max-sm:hidden' : '')}
            <span id={srId} className="sr-only">{badge.srLabel}</span>
          </p>
        ) : (
          <p data-testid="stat-label" id={labelId} className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</p>
        )}
        {/* Always one line (2026-11-02): an eight-digit figure, "19,847,808.93
            EGP", wrapped onto a second line at 1440 and at 390, and the tile
            came out 24–34px taller than its skeleton. The figure keeps its
            size while it fits, and steps down only as far as its length needs
            to fit the column (`cqi`, the column's width); its line stays the
            skeleton's height either way. */}
        <p
          data-testid="stat-figure"
          id={figureId}
          className="mt-1 whitespace-nowrap font-bold tabular-nums text-card-foreground"
          style={{
            fontSize: `min(var(--figure), calc(100cqi / ${(Math.max(chars, 1) * EM_PER_CHAR).toFixed(2)}))`,
            lineHeight: 'var(--figure-line)',
          }}
        >
          {figure}
        </p>
        {sub && <div id={subId} className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </div>
      {worded ? (
        <div data-testid="stat-icon-row" className="flex w-full flex-col items-start gap-2 sm:w-auto">
          {icon}
          <div data-testid="stat-pill-line-phone" className={PHONE_PILL_LINE}>
            {pill('-phone', PHONE_BADGE, 'sm:hidden')}
          </div>
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

  const linkClass = 'cursor-pointer touch-manipulation transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-[0.99]';

  if (!badge?.info) {
    return (
      <Link href={href} data-testid={testId} className={`${frame} ${linkClass}`}>
        {body}
      </Link>
    );
  }

  // A tile whose pill has an (i) still opens its list, but cannot be one <a>:
  // the (i) is a button, and a button inside a link is invalid and navigates
  // when tapped (2026-11-06). The link is laid over the tile instead (a
  // stretched link): first in the DOM, so Tab reaches the tile before its (i);
  // positioned, so it paints above the text and takes every click; named by
  // the label, figure and second line, as the whole tile was. The (i) sits
  // above it again (`BadgeInfo`, z-10). The frame carries the link's hover,
  // press and focus ring, as the link did when it was the frame.
  const labelledBy = [labelId, badge ? srId : null, figureId, sub ? subId : null].filter(Boolean).join(' ');
  return (
    <div
      data-testid={testId}
      className={`${frame} relative transition-shadow hover:shadow-md has-[>a:active]:scale-[0.99] has-[>a:focus-visible]:ring-2 has-[>a:focus-visible]:ring-primary`}
    >
      <Link
        href={href}
        data-testid="stat-tile-link"
        aria-labelledby={labelledBy}
        className="absolute inset-0 cursor-pointer touch-manipulation rounded-xl focus-visible:outline-none"
      />
      {body}
    </div>
  );
}

/**
 * The (i) after a pill. A real button (not a hover tooltip), so a tap on a
 * phone opens it; Radix closes it on Escape and on a click outside. 14px, with
 * a hit area grown past its box so the label row keeps its 16px pill height.
 */
function BadgeInfo({ info, testId }: { info: NonNullable<StatTileBadge['info']>; testId: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={info.buttonLabel}
          className="relative z-10 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid={`${testId}-panel`} collisionPadding={12} className="w-72 max-w-[calc(100vw-1.5rem)]">
        <PopoverHeader>
          <PopoverTitle>{info.title}</PopoverTitle>
          <PopoverDescription className="text-xs leading-5">{info.body}</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
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
              {/* A worded pill is a profit pill, which carries its (i). */}
              {badge === 'wide' && <Skeleton data-testid="skeleton-badge-info" className="size-4 shrink-0 rounded-full max-sm:hidden" />}
            </div>
          ) : (
            <SkeletonText size="xs" lineClassName="sm:h-5" className="w-20 sm:h-3 sm:w-24" />
          )}
          <SkeletonText size="base" lineClassName={`mt-1 sm:h-8 ${FOUR_ACROSS_FIGURE_LINE}`} className="w-24 sm:h-5 sm:w-36" />
          {sub && <SkeletonText size="xs" lineClassName="mt-1" className="w-28" />}
        </div>
        {badge === 'wide' ? (
          // On a phone the worded pill and its (i) sit on their own line under
          // the icon (StatTile, PHONE_BADGE).
          <div data-testid="skeleton-icon-row" className="flex w-full flex-col items-start gap-2 sm:w-auto">
            <Skeleton className={`size-7 flex-shrink-0 rounded-lg sm:size-12 ${FOUR_ACROSS_BADGE_SKELETON}`} />
            <div data-testid="skeleton-pill-line-phone" className={PHONE_PILL_LINE}>
              <span className="inline-flex shrink-0 items-center gap-1 sm:hidden">
                <Skeleton data-testid="skeleton-badge-phone" className="h-4 w-20 shrink-0 rounded-full sm:hidden" />
                <Skeleton data-testid="skeleton-badge-info-phone" className="size-4 shrink-0 rounded-full" />
              </span>
            </div>
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
