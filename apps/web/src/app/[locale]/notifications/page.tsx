'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useDateFormat } from '../../../lib/dates';
import {
  Bell, CheckCheck, Check,
  AlertTriangle, Info, ShoppingCart, Package, Route, CreditCard, ShieldCheck,
} from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { Link } from '../../../i18n/navigation';
import { notificationHref, useNotificationText, useNotifications } from '../../../lib/notifications';
import { isolateCodes } from '@/components/layout/isolate-codes';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';

// ─── Types ────────────────────────────────────────────────────────────
interface Notification {
  id: string;
  title: string;
  message?: string;
  eventType: string;
  readAt: string | null;
  createdAt: string;
}

const EVENT_ICONS: Record<string, typeof Bell> = {
  CYCLE_CREATED: Route,
  CYCLE_STATUS_CHANGED: Route,
  PAYMENT_RECEIVED: CreditCard,
  ORDER_CREATED: ShoppingCart,
  LOW_STOCK: AlertTriangle,
  GENERAL: Info,
  SECURITY: ShieldCheck,
  PRODUCT_UPDATED: Package,
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function NotificationsPage() {
  const notificationText = useNotificationText();
  const { timeAgo } = useDateFormat();
  const t = useTranslations('notifications');
  const queryClient = useQueryClient();

  // The shared query. This page and the bell each had their own under the same
  // key and disagreed about the shape, so whichever mounted first won and the
  // other read the wrong thing — which is why this page said "No notifications"
  // beside a bell showing nine.
  const { data, isLoading } = useNotifications();

  const [page, setPage] = useState(1);

  const notificationList: Notification[] = data?.items ?? [];
  const unreadCount = data?.unreadCount ?? notificationList.filter((n) => !n.readAt).length;

  const totalPages = Math.ceil(notificationList.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(notificationList, page), [notificationList, page]);

  // ── Mutations ─────────────────────────────────────────────────────
  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      {/* As tall as the Mark all button, so the list does not drop when it appears. */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 sm:min-h-10">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          {unreadCount > 0 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {t('unreadCount', { count: unreadCount })}
            </span>
          )}
        </div>
        {/* On a phone the button sits under the title; hold its place until we know. */}
        {isLoading && <Skeleton aria-hidden="true" className="h-10 w-40 rounded-lg sm:hidden" />}
        {unreadCount > 0 && (
          <button
            onClick={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending}
            className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            <CheckCheck className="h-4 w-4" />
            {t('markAllRead')}
          </button>
        )}
      </div>

      {/* Loading: a page of rows in the list's own frame. */}
      {isLoading && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <SkeletonRegion className="divide-y divide-muted">
            {repeat(PAGE_SIZE, (i) => <NotificationRowSkeleton key={i} />)}
          </SkeletonRegion>
        </div>
      )}

      {/* Notification List */}
      {!isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {notificationList.length === 0 ? (
            <EmptyState icon={Bell} title={t('noNotifications')} description={t('emptyHint')} />
          ) : (
            <div className="divide-y divide-gray-100">
              {paginated.map((notification) => {
                const Icon = EVENT_ICONS[notification.eventType] ?? Bell;
                return (
                  <NotificationRow
                    key={notification.id}
                    href={notificationHref(notification)}
                    onOpen={() => {
                      if (!notification.readAt) markReadMutation.mutate(notification.id);
                    }}
                    unread={!notification.readAt}
                  >
                    <div className={`mt-0.5 p-2 rounded-lg ${!notification.readAt ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-400'}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2">
                        <p className={`min-w-0 break-words text-sm font-medium ${!notification.readAt ? 'text-gray-900' : 'text-gray-700'}`}>
                          {isolateCodes(notificationText(notification))}
                        </p>
                        {!notification.readAt && (
                          <span className="mt-1.5 h-2 w-2 bg-primary-500 rounded-full flex-shrink-0" />
                        )}
                      </div>
                      {notification.message && (
                        <p className="text-sm text-gray-500 mt-0.5 truncate">{notification.message}</p>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                      {timeAgo(notification.createdAt)}
                    </span>
                  </NotificationRow>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {notificationList.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={notificationList.length} />
      )}
    </div>
  );
}


/**
 * `NotificationRow` and what the page puts in it, traced: the 32px icon tile,
 * the title line and the time on the end side.
 */
function NotificationRowSkeleton() {
  return (
    <div data-testid="skeleton-row" className="flex items-start gap-3 sm:gap-4 px-4 py-4">
      <Skeleton className="mt-0.5 size-8 rounded-lg" />
      <div className="flex-1 min-w-0">
        <SkeletonText className="w-3/4" />
        {/* A notification's title runs to two lines on a phone. */}
        <SkeletonText className="w-1/2" lineClassName="sm:hidden" />
      </div>
      <SkeletonText size="xs" className="w-14" />
    </div>
  );
}

/**
 * One notification, as a link when there is somewhere to go.
 *
 * A notification you cannot act on wastes the reading of it: "El Nasr Motors
 * asked to buy" was a dead end, and the person had to work out for themselves
 * which screen that lived on. Now it opens the request.
 *
 * A real `<a>` rather than an onClick, so it opens in a new tab with the middle
 * button and shows its destination in the status bar — both of which a div
 * pretending to be a link takes away. Events with nowhere sensible to go stay
 * plain text rather than landing on a dashboard and leaving the reader hunting.
 */
function NotificationRow({
  href,
  onOpen,
  unread,
  children,
}: {
  href: string | null;
  onOpen: () => void;
  unread: boolean;
  children: React.ReactNode;
}) {
  const className = `flex items-start gap-3 sm:gap-4 px-4 py-4 transition-colors ${
    unread ? 'bg-primary-50/30' : ''
  } ${href ? 'cursor-pointer hover:bg-gray-50' : ''}`;

  if (!href) {
    return <div className={className}>{children}</div>;
  }

  return (
    <Link href={href} onClick={onOpen} className={className}>
      {children}
    </Link>
  );
}
