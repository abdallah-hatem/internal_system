import type { ReactNode } from 'react';
import { Inbox, type IconComponent } from '@/components/ui/icons';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** The main button. `href` renders a locale-aware link; `onClick` a button. */
export type EmptyStateAction =
  | { label: string; href: string; onClick?: never }
  | { label: string; onClick: () => void; href?: never };

export interface EmptyStateProps {
  /** One line saying what goes here — already translated. */
  title: string;
  /** Optional second line: how something gets here. */
  description?: string;
  /** The list's main action ("New sale"), so the empty screen is not a dead end. */
  action?: EmptyStateAction;
  /** A lucide icon component or any node. Defaults to an inbox. Pass `null` for none. */
  icon?: IconComponent | ReactNode;
  /**
   * `default` for a page or a whole list; `compact` for a section inside a card,
   * a popover or a picker — the same look with less room around it, so a small
   * empty slot never falls back to a bare grey sentence.
   */
  size?: 'default' | 'compact';
  className?: string;
}

/**
 * What an empty list shows instead of a blank table (UX #12).
 *
 *   <EmptyState
 *     title={t('noSales')}
 *     description={t('noSalesHint')}
 *     action={{ label: t('newSale'), onClick: openForm }}
 *   />
 *
 * This is the one look for "nothing here": a whole page, a card's section
 * (`size="compact"`), and the picker's no-match slot all render it, instead of a
 * bare "No data available" line in each place's own grey.
 *
 * Every string is passed in translated; the component holds none of its own.
 * Layout is centred and uses theme tokens only, so it reads the same in RTL and
 * dark mode.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  size = 'default',
  className,
}: EmptyStateProps) {
  const compact = size === 'compact';
  const iconNode = renderIcon(icon === undefined ? Inbox : icon, compact);

  return (
    <div
      data-slot="empty-state"
      data-size={size}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-3 py-6' : 'gap-3 px-4 py-12',
        className,
      )}
    >
      {iconNode && (
        <div
          aria-hidden="true"
          className={cn(
            'flex items-center justify-center rounded-full bg-muted text-muted-foreground',
            compact ? 'size-9' : 'size-12',
          )}
        >
          {iconNode}
        </div>
      )}
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action &&
        (action.href !== undefined ? (
          <Button asChild size="sm" className="mt-1 min-h-11 cursor-pointer sm:min-h-9">
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={action.onClick}
            className="mt-1 min-h-11 cursor-pointer sm:min-h-9"
          >
            {action.label}
          </Button>
        ))}
    </div>
  );
}

function renderIcon(icon: IconComponent | ReactNode, compact: boolean): ReactNode {
  if (icon === null || icon === false) return null;
  // A lucide icon is a forwardRef component: an object (or function) with a render.
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && 'render' in icon)) {
    const Icon = icon as IconComponent;
    return <Icon className={compact ? 'size-4' : 'size-6'} />;
  }
  return icon as ReactNode;
}
