'use client';

import { useTranslations } from 'next-intl';
import { Menu } from '@/components/ui/icons';
import { Link } from '../../i18n/navigation';
import { isActiveHref, isMoreActive, type NavItem } from './nav-model';

type Icon = React.ComponentType<{ className?: string }>;

/**
 * The phone's way around the app: the five daily places one tap away, and
 * "More" for the rest — which opens the same grouped menu the sidebar shows.
 *
 * Below `md` only. It is fixed to the foot of the screen, so the shell pads the
 * page by its height (plus the home-indicator inset) or the last row and a
 * page's own buttons would sit underneath it. Modals open at z-50, above it.
 *
 * The order follows the document's direction: under Arabic the row lays out
 * right to left, so Dashboard is at the right-hand edge where a reader starts.
 */
export function PhoneBar({
  items,
  icons,
  pathname,
  menuOpen,
  onMore,
}: {
  items: readonly NavItem[];
  icons: Record<string, Icon>;
  pathname: string;
  menuOpen: boolean;
  onMore: () => void;
}) {
  const t = useTranslations('nav');
  const moreActive = menuOpen || isMoreActive(pathname, items);
  const cell = `
    flex min-h-14 flex-col items-center justify-center gap-0.5 px-1
    text-[11px] font-medium leading-tight cursor-pointer select-none
    touch-manipulation transition-colors duration-150
  `;
  const tone = (active: boolean) =>
    active ? 'text-primary' : 'text-muted-foreground active:text-foreground';

  return (
    <nav
      aria-label={t('phoneBar')}
      data-testid="phone-bar"
      data-print-hide
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[var(--phone-bar-inset)] md:hidden"
    >
      <ul className="flex">
        {items.map((item) => {
          const Icon = icons[item.key];
          const active = !menuOpen && isActiveHref(pathname, item.href);
          return (
            <li key={item.key} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`${cell} ${tone(active)}`}
              >
                {Icon && <Icon className="h-5 w-5" />}
                <span className="max-w-full truncate">{t(`short.${item.key}` as never)}</span>
              </Link>
            </li>
          );
        })}
        <li className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onMore}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            className={`${cell} w-full ${tone(moreActive)}`}
          >
            <Menu className="h-5 w-5" />
            <span className="max-w-full truncate">{t('more')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
