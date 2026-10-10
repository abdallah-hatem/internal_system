import { describe, expect, it } from 'vitest';
import {
  fieldValue,
  legLineProgress,
  losableByLine,
  lossRecovery,
  mayHaveWaiting,
  parseQty,
  receivableByLine,
  waitingDeliveries,
  type Shipment,
  type ShipmentLeg,
} from './shipment-model';

const lastLeg = (over: Partial<ShipmentLeg> = {}): ShipmentLeg => ({
  legId: 'leg-1',
  sequence: 1,
  isLast: true,
  status: 'PARTLY_ARRIVED',
  arrivedOn: null,
  entered: 40,
  delivered: 15,
  lost: 0,
  onTheWay: 25,
  received: 14,
  waiting: 1,
  lines: [
    { purchaseOrderItemId: 'poi-1', entered: 40, delivered: 15, lost: 0, onTheWay: 25, received: 14, waiting: 1 },
  ],
  deliveries: [
    { id: 'd-1', arrivedOn: '2026-10-01', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 15, received: 14 }] },
  ],
  ...over,
});

describe('fieldValue — a typed value is never overwritten', () => {
  it('an untouched field shows the server figure, and follows it when it changes', () => {
    expect(fieldValue({}, { a: 25 }, 'a')).toBe('25');
    expect(fieldValue({}, { a: 10 }, 'a')).toBe('10');
  });

  it('a typed field keeps its text whatever the server figure becomes', () => {
    expect(fieldValue({ a: '12' }, { a: 25 }, 'a')).toBe('12');
    expect(fieldValue({ a: '12' }, { a: 3 }, 'a')).toBe('12');
  });

  it('a field typed empty stays empty rather than snapping back to the prefill', () => {
    expect(fieldValue({ a: '' }, { a: 25 }, 'a')).toBe('');
  });

  it('nothing to prefill reads as an empty field, not "0"', () => {
    expect(fieldValue({}, { a: 0 }, 'a')).toBe('');
  });
});

describe('receivableByLine — the receive prefill', () => {
  it('a delivery of 15 received 14 has 1 left', () => {
    expect(receivableByLine(lastLeg().deliveries[0], lastLeg())).toEqual({ 'dl-1': 1 });
  });

  it('a loss that took the waiting unit leaves nothing to receive from the delivery', () => {
    const leg = lastLeg({
      lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 15, lost: 1, onTheWay: 25, received: 14, waiting: 0 }],
    });
    expect(receivableByLine(leg.deliveries[0], leg)).toEqual({ 'dl-1': 0 });
  });

  it('works in thousandths, so 0.1 + 0.2 received of 0.3 leaves nothing', () => {
    const leg = lastLeg({
      lines: [{ purchaseOrderItemId: 'poi-1', entered: 0.3, delivered: 0.3, lost: 0, onTheWay: 0, received: 0.3, waiting: 0 }],
      deliveries: [{ id: 'd', arrivedOn: '2026-10-01', lines: [{ id: 'dl', purchaseOrderItemId: 'poi-1', qty: 0.3, received: 0.1 + 0.2 }] }],
    });
    expect(receivableByLine(leg.deliveries[0], leg)).toEqual({ dl: 0 });
  });
});

describe('losableByLine', () => {
  it('on the last leg, both what is on the way and what waits can be marked lost', () => {
    expect(losableByLine(lastLeg())).toEqual({ 'poi-1': 26 });
  });

  it('on an earlier leg only what is on the way', () => {
    expect(
      losableByLine(
        lastLeg({
          isLast: false,
          lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 30, lost: 0, onTheWay: 10, received: null, waiting: null }],
        }),
      ),
    ).toEqual({ 'poi-1': 10 });
  });
});

describe('waitingDeliveries — the "Receive stock" list', () => {
  const shipment = (code: string, leg: ShipmentLeg): Shipment => ({
    cycleId: `c-${code}`,
    code,
    status: 'SELLING',
    accounted: false,
    totals: { ordered: 40, received: 14, lost: 0, onTheWay: 25, waiting: 1 },
    lines: [],
    legs: [leg],
  });

  it('lists a last-leg delivery with something still to receive, with its units', () => {
    const rows = waitingDeliveries([shipment('CYC-1', lastLeg())]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cycleCode: 'CYC-1', units: 1 });
  });

  it('a fully received delivery is not listed — the list empties once all is in', () => {
    const leg = lastLeg({
      lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 15, lost: 0, onTheWay: 25, received: 15, waiting: 0 }],
      deliveries: [{ id: 'd-1', arrivedOn: '2026-10-01', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 15, received: 15 }] }],
    });
    expect(waitingDeliveries([shipment('CYC-1', leg)])).toEqual([]);
  });

  it('a delivery on an earlier leg (into the UAE) is never stock waiting in Egypt', () => {
    expect(waitingDeliveries([shipment('CYC-1', lastLeg({ isLast: false }))])).toEqual([]);
  });

  it('oldest delivery first, across cycles', () => {
    const later = lastLeg({
      deliveries: [{ id: 'd-2', arrivedOn: '2026-10-05', lines: [{ id: 'dl-2', purchaseOrderItemId: 'poi-1', qty: 15, received: 14 }] }],
    });
    const rows = waitingDeliveries([shipment('CYC-B', later), shipment('CYC-A', lastLeg())]);
    expect(rows.map((r) => r.delivery.id)).toEqual(['d-1', 'd-2']);
  });

  it('cycles that cannot hold anything waiting are not asked for', () => {
    expect(['PLANNING', 'FUNDING', 'SETTLEMENT', 'CLOSED', 'CANCELLED'].some(mayHaveWaiting)).toBe(false);
    expect(['IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION', 'SELLING'].every(mayHaveWaiting)).toBe(true);
  });
});

describe('lossRecovery', () => {
  const loss = { id: 'l', legId: 'leg', purchaseOrderItemId: 'poi', qty: 5, costEgp: '550.00', createdAt: '2026-10-09' };

  it('before loss refunds exist (no refundedEgp) it reads nothing refunded, all unrecovered', () => {
    expect(lossRecovery(loss)).toEqual({ cost: 550, refunded: 0, unrecovered: 550, hasRefunds: false });
  });

  it('reads the server figures when they are sent', () => {
    expect(lossRecovery({ ...loss, refundedEgp: '200.00', unrecoveredEgp: '350.00', refunds: [] })).toMatchObject({
      refunded: 200,
      unrecovered: 350,
      hasRefunds: true,
    });
  });
});

describe('legLineProgress and parseQty', () => {
  it('15 delivered and 5 lost of 40 is half accounted for', () => {
    expect(legLineProgress({ purchaseOrderItemId: 'p', entered: 40, delivered: 15, lost: 5, onTheWay: 20, received: null, waiting: null })).toBe(50);
  });

  it('nothing entered is 0, not a division by zero', () => {
    expect(legLineProgress({ purchaseOrderItemId: 'p', entered: 0, delivered: 0, lost: 0, onTheWay: 0, received: null, waiting: null })).toBe(0);
  });

  it('reads typed quantities', () => {
    expect(parseQty('')).toBe(0);
    expect(parseQty('15')).toBe(15);
    expect(parseQty('1,500')).toBe(1500);
    expect(parseQty('2.5')).toBe(2.5);
    expect(parseQty('-3')).toBe(-3);
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('1e3')).toBeNull();
  });
});
