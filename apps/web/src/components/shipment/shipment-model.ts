/**
 * The shapes `GET /cycles/:id/shipment` answers with, and the small pure
 * readings the Shipment panel's dialogs make of them.
 *
 * Nothing here works out where goods are. `shipmentPosition` on the server is
 * the one place that arithmetic lives (CLAUDE.md rule 11): entered, delivered,
 * received, waiting, lost and on the way all arrive ready-made, and these
 * helpers only pick which of the server's numbers a field starts from.
 */

export interface ShipmentLossRefund {
  id: string;
  amountEgp: number | string;
  currency: string;
  amount: number | string;
  recordedOn: string;
  payerType: 'SHIPPING_PROVIDER' | 'SUPPLIER';
  payerName?: string | null;
}

export interface ShipmentLoss {
  id: string;
  legId: string;
  purchaseOrderItemId: string;
  qty: number | string;
  unitCostEgp?: number | string;
  costEgp: number | string;
  reason?: string | null;
  createdAt: string;
  /** Arrive with loss refunds (B5); absent before that, read as nothing refunded. */
  refundedEgp?: number | string;
  unrecoveredEgp?: number | string;
  refunds?: ShipmentLossRefund[];
}

export interface ShipmentDeliveryLine {
  id: string;
  purchaseOrderItemId: string;
  qty: number;
  /** Received into stock from this line (last leg only). */
  received: number;
}

export interface ShipmentDelivery {
  id: string;
  arrivedOn: string;
  lines: ShipmentDeliveryLine[];
}

export interface ShipmentLegLine {
  purchaseOrderItemId: string;
  entered: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  received: number | null;
  waiting: number | null;
}

export interface ShipmentLeg {
  legId: string;
  sequence: number;
  isLast: boolean;
  status: string;
  arrivedOn: string | null;
  entered: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  received: number | null;
  waiting: number | null;
  origin?: string;
  destination?: string;
  departedOn?: string | null;
  lines: ShipmentLegLine[];
  deliveries: ShipmentDelivery[];
  losses?: ShipmentLoss[];
}

export interface ShipmentLine {
  purchaseOrderItemId: string;
  productId?: string;
  productName?: string;
  ordered: number;
  received: number;
  lost: number;
  onTheWay: number;
  waiting: number;
  accounted: boolean;
}

export interface Shipment {
  cycleId: string;
  code: string;
  status: string;
  accounted: boolean;
  totals: { ordered: number; received: number; lost: number; onTheWay: number; waiting: number };
  lines: ShipmentLine[];
  legs: ShipmentLeg[];
}

export const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Thousandths, the precision quantities are stored at, so 0.1 + 0.2 stays 0.3. */
const milli = (v: unknown) => Math.round(num(v) * 1000);
const fromMilli = (m: number) => m / 1000;

/** The cycle statuses in which receiving is allowed (BUSINESS_LOGIC §3, amendment 6). */
export const RECEIVING_STATUSES = ['ARRIVED_EGYPT', 'VERIFICATION', 'SELLING'];

/** Nothing about the shipment moves while a cycle is being settled, is closed or cancelled. */
export const FROZEN_STATUSES = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];

/** Statuses where a cycle cannot hold anything waiting to be received. */
const NOTHING_WAITING = ['PLANNING', 'FUNDING', ...FROZEN_STATUSES];

/** Whether a cycle in this status could have a delivery sitting unreceived. */
export const mayHaveWaiting = (status: string) => !NOTHING_WAITING.includes(status);

/**
 * What each line of a form starts at, read through what was typed.
 *
 * A field the reader has typed into keeps its text, even when the server's
 * figure under it changes on a refetch. A field nobody touched shows the
 * server's current figure. Keeping the two apart is what stops a background
 * refresh from quietly replacing "12" with "25".
 */
export function fieldValue(
  typed: Record<string, string>,
  prefill: Record<string, number>,
  id: string,
): string {
  if (Object.prototype.hasOwnProperty.call(typed, id)) return typed[id];
  const start = prefill[id];
  return start ? String(start) : '';
}

/** Per order line, what a leg still has on the way — the Record delivery prefill. */
export function onTheWayByLine(leg: ShipmentLeg): Record<string, number> {
  return Object.fromEntries(leg.lines.map((l) => [l.purchaseOrderItemId, num(l.onTheWay)]));
}

/** Per order line, what can still be marked lost on a leg: on the way, and on the last leg what waits too. */
export function losableByLine(leg: ShipmentLeg): Record<string, number> {
  return Object.fromEntries(
    leg.lines.map((l) => [
      l.purchaseOrderItemId,
      fromMilli(milli(l.onTheWay) + milli(l.waiting ?? 0)),
    ]),
  );
}

/**
 * What can still be received from each line of a last-leg delivery.
 *
 * The server caps a receipt at the smaller of what the delivery line brought
 * less what was already received from it, and what the order line still has
 * waiting (a loss on the last leg can take waiting units). This reads those
 * two server figures and takes the smaller; it is the field's starting value,
 * and the server checks it again.
 */
export function receivableByLine(
  delivery: ShipmentDelivery,
  leg: ShipmentLeg,
): Record<string, number> {
  const waiting = new Map(leg.lines.map((l) => [l.purchaseOrderItemId, milli(l.waiting ?? 0)]));
  return Object.fromEntries(
    delivery.lines.map((line) => {
      const left = Math.max(0, milli(line.qty) - milli(line.received));
      return [line.id, fromMilli(Math.min(left, waiting.get(line.purchaseOrderItemId) ?? 0))];
    }),
  );
}

/** A last-leg delivery with something on it still to be received. */
export function isWaiting(delivery: ShipmentDelivery, leg: ShipmentLeg): boolean {
  if (!leg.isLast) return false;
  return Object.values(receivableByLine(delivery, leg)).some((q) => q > 0);
}

export interface WaitingDelivery {
  cycleId: string;
  cycleCode: string;
  cycleStatus: string;
  leg: ShipmentLeg;
  delivery: ShipmentDelivery;
  /** Units still to be received from it. */
  units: number;
}

/** Every delivery across these shipments that still has stock to be received, oldest first. */
export function waitingDeliveries(shipments: Shipment[]): WaitingDelivery[] {
  const rows: WaitingDelivery[] = [];
  for (const s of shipments) {
    for (const leg of s.legs ?? []) {
      if (!leg.isLast) continue;
      for (const delivery of leg.deliveries ?? []) {
        const units = Object.values(receivableByLine(delivery, leg)).reduce((a, b) => a + milli(b), 0);
        if (units > 0) {
          rows.push({
            cycleId: s.cycleId,
            cycleCode: s.code,
            cycleStatus: s.status,
            leg,
            delivery,
            units: fromMilli(units),
          });
        }
      }
    }
  }
  return rows.sort(
    (a, b) => a.delivery.arrivedOn.localeCompare(b.delivery.arrivedOn) || a.cycleCode.localeCompare(b.cycleCode),
  );
}

/** Refunded so far and what is still unrecovered on a loss; zero refunded when the server sends no figure. */
export function lossRecovery(loss: ShipmentLoss) {
  const cost = num(loss.costEgp);
  const refunded = num(loss.refundedEgp);
  const unrecovered =
    loss.unrecoveredEgp !== undefined && loss.unrecoveredEgp !== null
      ? num(loss.unrecoveredEgp)
      : Math.max(0, Math.round((cost - refunded) * 100) / 100);
  return { cost, refunded, unrecovered, hasRefunds: refunded > 0 || (loss.refunds?.length ?? 0) > 0 };
}

/**
 * The share of what entered a leg that is no longer on the way — delivered or
 * marked lost — as 0..100, for the row's progress bar.
 */
export function legLineProgress(line: ShipmentLegLine): number {
  const entered = milli(line.entered);
  if (entered === 0) return 0;
  return Math.round(((entered - milli(line.onTheWay)) / entered) * 100);
}

/** A typed quantity as a number, or null when it is not one. Empty reads as zero. */
export function parseQty(text: string): number | null {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return 0;
  if (!/^-?\d*\.?\d+$/.test(trimmed) && !/^-?\d+\.?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
