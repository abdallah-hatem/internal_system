import { describe, expect, it } from 'vitest';

import { bellLink } from '../../../api/src/common/notification-messages';
import { notificationHref, pushLanding } from './notification-href';

/**
 * Owner, 2026-10-18: office alerts now reach the phone. A tap must open what
 * the bell opens. The API builds the link (`bellLink`) from the same event and
 * payload it stores on the row; this app answers it (`pushLanding`) with the
 * bell's own mapping. These pin the round trip, through the URL a phone would
 * actually be handed.
 */

/** What `/notifications/open?…` hands the page, as Next parses it. */
function landing(link: string, requestsEnabled = true) {
  const url = new URL(link, 'https://office.example');
  expect(url.pathname).toBe('/notifications/open');
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  return pushLanding(params, requestsEnabled);
}

const bell = (eventType: string, payloadJson: Record<string, unknown>, enabled = true) =>
  notificationHref({ eventType, payloadJson }, enabled);

describe('a push opens the page the bell opens', () => {
  it.each([
    ['LOW_STOCK_DETECTED', { products: [{ productId: 'p-1', productName: 'Brake pad' }] }],
    ['ADDED_TO_CYCLE', { cycleId: 'c-7', cycleCode: 'CYC-2026-0007', contribution: 5000 }],
    ['CYCLE_STATUS_CHANGED', { cycleId: 'c-7', toStatus: 'SELLING' }],
    ['PURCHASE_ORDER_CREATED', { purchaseOrderId: 'po-1', cycleId: 'c-9' }],
    ['PAYMENT_OVERDUE', { planId: 'pl', instalmentId: 'i' }],
    ['SHOP_SIGNED_UP', { customerId: 'cu', shopName: 'Nile Motors' }],
    ['SETTLEMENT_APPROVED', {}],
    // A partner's news (§10, 2026-10-25).
    ['SALE_CONFIRMED', { orderId: 'o-1', customerId: 'cu' }],
    ['SALE_RETURNED', { orderId: 'o-1', returnId: 'r-1' }],
    ['ORDER_CANCELLED', { orderId: 'o-1', customerId: 'cu' }],
    ['ORDER_EDITED', { orderId: 'o-1', customerId: 'cu', editId: 'e-1' }],
    ['PAYMENT_RECEIVED', { paymentId: 'pm-1', customerId: 'cu' }],
    ['PAYMENT_REVERSED', { paymentId: 'pm-1', customerId: 'cu' }],
  ])('%s', (eventType, payload) => {
    const expected = bell(eventType, payload);
    expect(expected).not.toBeNull();
    expect(landing(bellLink(eventType, payload))).toBe(expected);
  });

  it("a partner's sale, return or cancel opens that order; a reversal opens Payments", () => {
    expect(bell('SALE_CONFIRMED', { orderId: 'o-1' })).toBe('/sales?order=o-1');
    expect(bell('SALE_RETURNED', { orderId: 'o-1' })).toBe('/sales?order=o-1');
    expect(bell('ORDER_CANCELLED', { orderId: 'o-1' })).toBe('/sales?order=o-1');
    expect(bell('ORDER_EDITED', { orderId: 'o-1' })).toBe('/sales?order=o-1');
    expect(bell('SALE_CONFIRMED', {})).toBe('/sales');
    expect(bell('PAYMENT_REVERSED', { paymentId: 'pm-1' })).toBe('/payments');
  });

  it('low stock lands on the stock page, as the bell does', () => {
    expect(landing(bellLink('LOW_STOCK_DETECTED', { products: [] }))).toBe('/inventory');
  });

  it('a request alert follows this build: its tab when Requests is on, the list when it is off', () => {
    const link = bellLink('ORDER_REQUEST_SUBMITTED', { requestId: 'r', requestNo: 'REQ-1' });
    expect(landing(link, true)).toBe('/requests');
    // The bell shows plain text here; the push has to land somewhere real.
    expect(landing(link, false)).toBe('/notifications');
  });

  it('an event the bell links nowhere, a missing event, or a repeated one lands on the list', () => {
    expect(landing(bellLink('SOMETHING_NEW', { id: 'x' }))).toBe('/notifications');
    expect(pushLanding({})).toBe('/notifications');
    expect(pushLanding({ event: ['CYCLE_CREATED', 'SHOP_SIGNED_UP'] })).toBe('/notifications');
  });

  it('an id that is a path still lands inside this app', () => {
    const to = landing(bellLink('CYCLE_CREATED', { cycleId: '//evil.example' }));
    expect(to.startsWith('/')).toBe(true);
    expect(new URL(`/ar${to}`, 'https://office.example').host).toBe('office.example');
  });
});
