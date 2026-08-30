'use client';

import { useQuery } from '@tanstack/react-query';

import { api } from './api';

/**
 * The notifications query, defined once.
 *
 * The bell and the notifications page each had their own, both under the key
 * `['notifications']`, and they disagreed about the shape: the bell returned the
 * array, the page returned `{ data, meta }`. React Query dedupes by key, so
 * whichever mounted first won — the bell, since it is in the app shell — and the
 * page then read `.data` off an array, got undefined, and rendered "No
 * notifications" while the bell beside it showed nine unread.
 *
 * Nothing was broken on the server and nothing looked broken in either file.
 * One rule, one definition (CLAUDE.md rule 11); a cache key is a rule.
 */

export interface Notification {
  id: string;
  eventType: string;
  title: string;
  payloadJson?: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsPage {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}

export const NOTIFICATIONS_KEY = ['notifications'] as const;

export function useNotifications(limit = 50) {
  return useQuery<NotificationsPage>({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: async () => {
      const res = await api.get('/notifications', { params: { limit } });
      const body = res.data;
      return {
        items: Array.isArray(body.data) ? body.data : [],
        unreadCount: body.meta?.unreadCount ?? 0,
        nextCursor: body.meta?.nextCursor ?? null,
      };
    },
    // Raised by other people's actions, so a tab left open has to notice.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Where a notification takes you.
 *
 * A notification you cannot act on is a notification that wastes the reading of
 * it. Every event here names the thing it happened to, and the payload already
 * carries the id — it was only ever a matter of using it.
 *
 * Returns null when there is nowhere sensible to go, and the row is then plain
 * text rather than a link that lands on a dashboard and leaves the person
 * hunting for what the message was about.
 */
export function notificationHref(notification: Notification): string | null {
  const payload = (notification.payloadJson ?? {}) as Record<string, string | undefined>;

  switch (notification.eventType) {
    case 'ORDER_REQUEST_SUBMITTED':
    case 'HOLD_EXPIRING':
      return '/order-requests';

    case 'IMPORT_REQUEST_SUBMITTED':
      return '/import-requests';

    case 'SHOP_SIGNED_UP':
      // Straight to the tab they are waiting in, not the whole customer list.
      return '/customers?verification=UNVERIFIED';

    case 'CYCLE_CREATED':
    case 'CYCLE_STATUS_CHANGED':
    case 'ADDED_TO_CYCLE':
      return payload.cycleId ? `/cycles/${payload.cycleId}/details` : '/cycles';

    case 'PURCHASE_ORDER_CREATED':
      return payload.cycleId ? `/cycles/${payload.cycleId}/details` : '/purchases';

    case 'SHIPMENT_CREATED':
    case 'SHIPMENT_STATUS_CHANGED':
      return '/shipments';

    case 'STOCK_RECEIVED':
    case 'LOW_STOCK':
      return payload.productId ? `/products/${payload.productId}` : '/inventory';

    case 'SALE_CREATED':
    case 'SALE_CONFIRMED':
      return '/sales';

    case 'PAYMENT_RECEIVED':
      return '/payments';

    case 'PAYMENT_PLAN_OVERDUE':
    case 'PAYMENT_PLAN_CREATED':
      return '/payment-plans';

    case 'SETTLEMENT_CREATED':
    case 'SETTLEMENT_APPROVED':
    case 'SETTLEMENT_PAID':
      return '/settlements';

    default:
      return null;
  }
}
