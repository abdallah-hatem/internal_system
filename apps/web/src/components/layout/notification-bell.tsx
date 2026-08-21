'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { Link } from '../../i18n/navigation';
import { formatDate } from '../../lib/dates';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Notification {
  id: string;
  eventType: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}

/** Above this the badge stops being a count and becomes "lots". */
const BADGE_CAP = 9;

/**
 * The header bell.
 *
 * It previously showed a hardcoded 3 and did nothing when clicked, so the
 * notifications the system had been writing all along — low stock, a shipment
 * arriving, a cycle changing state — reached nobody unless they thought to
 * open the notifications page.
 */
export function NotificationBell() {
  const t = useTranslations('notifications');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: () => api.get('/notifications').then((r) => r.data.data ?? r.data),
    // These are raised by other people's actions, so the tab needs to notice
    // without a reload.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const list = Array.isArray(notifications) ? notifications : [];
  const unread = list.filter((n) => !n.readAt);

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unread.length
              ? `${t('title')} — ${unread.length} ${t('unread')}`
              : t('title')
          }
          className="relative rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <Bell className="h-5 w-5" />
          {/* No badge at zero: a permanent marker stops meaning anything. */}
          {unread.length > 0 && (
            <span
              data-testid="notification-badge"
              className="absolute -top-0.5 -end-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
            >
              {unread.length > BADGE_CAP ? `${BADGE_CAP}+` : unread.length}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
          <span className="text-sm font-semibold text-gray-900">{t('title')}</span>
          {unread.length > 0 && (
            <button
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="text-xs text-primary-600 hover:underline disabled:opacity-50"
            >
              {t('markAllRead')}
            </button>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto">
          {list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">{t('noData')}</p>
          ) : (
            list.slice(0, 8).map((n) => (
              <div
                key={n.id}
                className={cn(
                  'flex items-start gap-2 border-b border-gray-50 px-4 py-3 last:border-0',
                  !n.readAt && 'bg-primary-50/40',
                )}
              >
                <span
                  className={cn(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                    n.readAt ? 'bg-transparent' : 'bg-primary-500',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm', n.readAt ? 'text-gray-600' : 'font-medium text-gray-900')}>
                    {n.title}
                  </p>
                  <p className="text-xs text-gray-400">{formatDate(n.createdAt)}</p>
                </div>
                {!n.readAt && (
                  <button
                    type="button"
                    aria-label={t('markRead')}
                    onClick={() => markRead.mutate(n.id)}
                    className="rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <Link
          href="/notifications"
          onClick={() => setOpen(false)}
          className="block border-t border-gray-100 px-4 py-2.5 text-center text-sm text-primary-600 hover:bg-gray-50"
        >
          {t('viewAll')}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
