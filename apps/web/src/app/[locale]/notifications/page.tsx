'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { timeAgo } from '../../../lib/dates';
import {
  Bell, Loader2, CheckCheck, Check,
  AlertTriangle, Info, ShoppingCart, Package, Route, CreditCard, ShieldCheck,
} from 'lucide-react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';

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
  const t = useTranslations('notifications');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();

  const { data: notifications, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await api.get('/notifications');
      return {
        data: res.data.data ?? res.data,
        meta: res.data.meta,
      };
    },
  });

  const [page, setPage] = useState(1);

  const notificationList: Notification[] = Array.isArray(notifications?.data) ? notifications.data : [];
  const unreadCount = notifications?.meta?.unreadCount ?? notificationList.filter((n) => !n.readAt).length;

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
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          {unreadCount > 0 && (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {t('unreadCount', { count: unreadCount })}
            </span>
          )}
        </div>
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

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Notification List */}
      {!isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {notificationList.length === 0 ? (
            <div className="p-12 text-center text-gray-400">
              <Bell className="h-8 w-8 mx-auto mb-3 text-gray-300" />
              <p>{t('noNotifications')}</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {paginated.map((notification) => {
                const Icon = EVENT_ICONS[notification.eventType] ?? Bell;
                return (
                  <div
                    key={notification.id}
                    onClick={() => {
                      if (!notification.readAt) markReadMutation.mutate(notification.id);
                    }}
                    className={`flex items-start gap-4 px-4 py-4 cursor-pointer hover:bg-gray-50 transition-colors ${!notification.readAt ? 'bg-primary-50/30' : ''}`}
                  >
                    <div className={`mt-0.5 p-2 rounded-lg ${!notification.readAt ? 'bg-primary-100 text-primary-600' : 'bg-gray-100 text-gray-400'}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-medium ${!notification.readAt ? 'text-gray-900' : 'text-gray-700'}`}>
                          {notification.title}
                        </p>
                        {!notification.readAt && (
                          <span className="h-2 w-2 bg-primary-500 rounded-full flex-shrink-0" />
                        )}
                      </div>
                      {notification.message && (
                        <p className="text-sm text-gray-500 mt-0.5 truncate">{notification.message}</p>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 whitespace-nowrap flex-shrink-0">
                      {timeAgo(notification.createdAt)}
                    </span>
                  </div>
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
