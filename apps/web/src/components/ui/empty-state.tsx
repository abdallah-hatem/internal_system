import type { ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
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
  icon?: LucideIcon | ReactNode;
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
 * Every string is passed in translated; the component holds none of its own.
 * Layout is centred and uses theme tokens only, so it reads the same in RTL and
 * dark mode.
 */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  const iconNode = renderIcon(icon === undefined ? Inbox : icon);

  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-4 py-12 text-center',
        className,
      )}
    >
      {iconNode && (
        <div
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
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

function renderIcon(icon: LucideIcon | ReactNode): ReactNode {
  if (icon === null || icon === false) return null;
  // A lucide icon is a forwardRef component: an object (or function) with a render.
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && 'render' in icon)) {
    const Icon = icon as LucideIcon;
    return <Icon className="size-6" />;
  }
  return icon as ReactNode;
}
