/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';
import { InventoryService } from './inventory.service';

/**
 * L2 — the low-stock notification raised on receiving uses the one rule
 * (common/low-stock.ts, BUSINESS_LOGIC §3): active, a minimum set, stock on
 * hand (remaining, every batch) below it. It used to check only that a
 * minimum was set, so a receipt of an inactive product still alerted.
 */

const NOW = new Date('2026-10-10T09:00:00Z');
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: NOW,
  });
});
afterEach(() => jest.useRealTimers());

const ACTOR = randomUUID();
const PARTNER = randomUUID();

let db: Store;
let inventory: InventoryService;
let deliveries: DeliveriesService;
let notify: jest.Mock;

beforeEach(() => {
  db = emptyStore();
  const prisma = fakePrisma(db);
  // One core partner to tell.
  (prisma as any).user.findMany = () => Promise.resolve([{ id: PARTNER }]);
  const audit = { log: jest.fn() } as unknown as AuditService;
  notify = jest.fn();
  const notifications = {
    createForMultipleUsers: notify,
  } as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  const cycles = new CyclesService(prisma, audit, notifications);
  deliveries = new DeliveriesService(prisma, audit, notifications, costing);
  inventory = new InventoryService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
});

/** Order 40, deliver `qty`, receive it all; the product as `product` says. */
async function receiveWith(
  product: { minStock?: number | null; status?: string },
  qty: number,
) {
  const { cycle, items } = cycleWithOrder(db, { status: 'ARRIVED_EGYPT' });
  const item = items[0];
  const prod = db.products.find((p) => p.id === item.productId)!;
  prod.minStock = product.minStock == null ? null : D(product.minStock);
  if (product.status) prod.status = product.status;
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: 400,
  });
  const { data: delivery } = (await deliveries.recordDelivery(
    leg.id,
    {
      arrivedOn: '2026-09-20',
      lines: [{ purchaseOrderItemId: item.id, qty }],
    },
    ACTOR,
  )) as { data: Row };
  await inventory.verifyStock(
    cycle.id,
    {
      deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: qty }],
    },
    ACTOR,
  );
  return { prod, cycle, item };
}

const alerted = () =>
  notify.mock.calls
    .filter(([, n]) => n.eventType === 'LOW_STOCK_DETECTED')
    .flatMap(([, n]) => n.payload.products);

describe('low stock on receiving', () => {
  it('an active product received below its minimum raises one alert, with the figure', async () => {
    const { prod } = await receiveWith({ minStock: 20 }, 15);
    expect(alerted()).toEqual([
      {
        productId: prod.id,
        productName: prod.name,
        currentStock: 15,
        minStock: 20,
      },
    ]);
    expect(notify.mock.calls[0][0]).toEqual([PARTNER]);
  });

  it('an inactive product is never low, however little arrives', async () => {
    await receiveWith({ minStock: 20, status: 'INACTIVE' }, 1);
    expect(alerted()).toEqual([]);
  });

  it('a product with no minimum is never low', async () => {
    await receiveWith({ minStock: null }, 1);
    expect(alerted()).toEqual([]);
  });

  it('exactly at the minimum is not low', async () => {
    await receiveWith({ minStock: 15 }, 15);
    expect(alerted()).toEqual([]);
  });

  it('every batch of the product is summed: 12 already on the shelf + 5 received is 17, not low against 15', async () => {
    const { prod, cycle } = await receiveWith({ minStock: 15 }, 12);
    // That first receipt was 12 < 15 — low.
    expect(alerted()).toHaveLength(1);
    notify.mockClear();

    // A second cycle bringing 5 more of the same product.
    const second = cycleWithOrder(db, { status: 'ARRIVED_EGYPT' });
    const item = second.items[0];
    db.products = db.products.filter((p) => p.id !== item.productId);
    item.productId = prod.id;
    const leg = addLeg(db, second.cycle, 1, { departedOn: '2026-09-01' });
    const { data: delivery } = (await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: '2026-09-25',
        lines: [{ purchaseOrderItemId: item.id, qty: 5 }],
      },
      ACTOR,
    )) as { data: Row };
    await inventory.verifyStock(
      second.cycle.id,
      {
        deliveryId: delivery.id,
        items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 5 }],
      },
      ACTOR,
    );
    expect(cycle.id).not.toBe(second.cycle.id);
    expect(
      db.batches
        .filter((b) => b.productId === prod.id)
        .map((b) => Number(b.remainingQty)),
    ).toEqual([12, 5]);
    expect(alerted()).toEqual([]);
  });
});
