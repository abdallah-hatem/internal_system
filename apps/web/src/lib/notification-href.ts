import { REQUESTS_ENABLED } from './features';
import { requestsPath } from './requests-route';
import { viewPath } from './page-views';
import type { Notification } from './notifications';

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
export function notificationHref(
  notification: Pick<Notification, 'eventType' | 'payloadJson'>,
  /** Whether this build shows the Requests page (lib/features.ts). Where it is
   *  switched off a request's notification is plain text, not a link that
   *  would only bounce to the dashboard. */
  requestsEnabled: boolean = REQUESTS_ENABLED,
): string | null {
  const payload = (notification.payloadJson ?? {}) as Record<string, string | undefined>;

  switch (notification.eventType) {
    case 'ORDER_REQUEST_SUBMITTED':
    case 'HOLD_EXPIRING':
      return requestsEnabled ? requestsPath('orders') : null;

    case 'IMPORT_REQUEST_SUBMITTED':
      return requestsEnabled ? requestsPath('imports') : null;

    case 'SHOP_SIGNED_UP':
      // Straight to the tab they are waiting in, not the whole customer list.
      return '/customers?verification=UNVERIFIED';

    case 'CYCLE_CREATED':
    case 'CYCLE_STATUS_CHANGED':
    case 'ADDED_TO_CYCLE':
      return payload.cycleId ? `/cycles/${payload.cycleId}/details` : '/cycles';

    case 'PURCHASE_ORDER_CREATED':
      return payload.cycleId ? `/cycles/${payload.cycleId}/details` : viewPath('purchases');

    case 'SHIPMENT_CREATED':
    case 'SHIPMENT_STATUS_CHANGED':
      return viewPath('shipments');

    case 'STOCK_RECEIVED':
    case 'LOW_STOCK':
      return payload.productId ? `/products/${payload.productId}` : '/inventory';

    // What the API raises, after a receipt or a sale (§3): the stock page,
    // which marks every low product. LOW_STOCK above was never raised.
    case 'LOW_STOCK_DETECTED':
      return '/inventory';

    case 'SALE_CREATED':
      return '/sales';

    // A partner's sale, return or cancel (§10): the order itself, opened on Sales.
    case 'SALE_CONFIRMED':
    case 'SALE_RETURNED':
    case 'ORDER_CANCELLED':
    case 'ORDER_EDITED':
      return payload.orderId ? `/sales?order=${payload.orderId}` : '/sales';

    // Samples at a shop for 14 days (§4): the order itself, opened on Sales.
    case 'SAMPLES_REMINDER':
      return payload.orderId ? `/sales?order=${payload.orderId}` : '/sales';

    case 'PAYMENT_RECEIVED':
    case 'PAYMENT_REVERSED':
      return '/payments';

    // PAYMENT_OVERDUE is what the API raises (per instalment since 2026-10-11);
    // PAYMENT_PLAN_OVERDUE was never raised, and kept the link from working.
    case 'PAYMENT_OVERDUE':
    case 'PAYMENT_PLAN_OVERDUE':
    case 'PAYMENT_PLAN_CREATED':
      return '/payments?view=contracts';

    case 'SETTLEMENT_CREATED':
    case 'SETTLEMENT_APPROVED':
    case 'SETTLEMENT_PAID':
      return viewPath('settlements');

    default:
      return null;
  }
}

/**
 * Where a tap on a push lands (owner, 2026-10-18: office alerts reach the
 * phone).
 *
 * The API cannot word the link itself — whether Requests is switched on is a
 * fact about this build — so a push carries what the bell row carries: the
 * event, and the flat ids of its payload, as `/notifications/open?event=…&…`
 * (`bellLink` in the API's notifications service). This answers it with the
 * bell's own mapping, so the phone and the bell cannot disagree. Nowhere to go
 * means the notifications list, where the alert is waiting.
 */
export function pushLanding(
  searchParams: Record<string, string | string[] | undefined>,
  requestsEnabled: boolean = REQUESTS_ENABLED,
): string {
  const { event, ...rest } = searchParams;
  const eventType = typeof event === 'string' ? event : '';
  const payloadJson: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'string') payloadJson[key] = value;
  }
  return (
    (eventType && notificationHref({ eventType, payloadJson }, requestsEnabled)) ||
    '/notifications'
  );
}
