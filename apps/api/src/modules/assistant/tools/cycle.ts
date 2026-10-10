import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CycleStatus } from '@prisma/client';
import { z } from 'zod';

import { notFound } from '../../../common/api-error';
import { CYCLE_ROUTES, expectedLegs } from '../../../common/cycle-routes';
import { formatMoney, formatQty } from '../../../common/money';
import { loadShipment } from '../../../common/shipment-load';
import {
  shipmentPosition,
  type PositionDeliveryInput,
} from '../../../common/shipment-position';
import { isUuid } from '../../../common/uuid';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CostingService } from '../../costing/costing.service';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryService } from '../../inventory/inventory.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { DeliveriesService } from '../../shipping/deliveries.service';
import { ShippingService } from '../../shipping/shipping.service';
import { previewByRollback, rollingBack } from '../dry-run';
import { writeTool, type AssistantContext } from '../tool-kit';

/**
 * The cycle tools: create_cycle, add_shipping_leg, transition_cycle,
 * record_delivery, verify_stock. Each changes something, so each is a
 * `writeTool`. There is no tool for marking goods lost: that books a loss, and
 * a partner decides it on a screen in the office app (BUSINESS_LOGIC §16).
 *
 * Every preview comes from the service's own `plan…` method and every commit
 * from the method the office app's controller calls, which starts by running
 * that same plan. Preview and commit therefore cannot disagree about what is
 * allowed, what a leg costs, which orders a transition locks or what a unit of
 * stock lands at — and the assistant is refused whatever the office app is.
 * Recording a delivery has no plan method; its preview is the write itself,
 * rolled back (`dry-run.ts`), which comes to the same thing.
 */

const ALL_STATUSES = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly CycleStatus[];

/**
 * Where the assistant may move a cycle. §16 gives it the intake path — from
 * receipt to sellable stock — so SELLING is as far as it goes; SETTLEMENT and
 * CLOSED belong to settlements, which stay in the office app.
 */
const ASSISTANT_TARGETS = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'CANCELLED',
] as const satisfies readonly CycleStatus[];

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar day, YYYY-MM-DD');
const cycleId = z
  .string()
  .describe('The cycle id (a UUID) — get_cycle or list_cycles gives it.');

const route = (from: string, to: string) => `${from} → ${to}`;

export function registerCycleTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const cycles = () => ctx.resolve(CyclesService);
  const shipping = () => ctx.resolve(ShippingService);
  const inventory = () => ctx.resolve(InventoryService);
  const deliveries = () => ctx.resolve(DeliveriesService);
  const prisma = () => ctx.resolve(PrismaService);

  // ─── create_cycle ───────────────────────────────────────────────────────
  const createShape = {
    route: z
      .enum(CYCLE_ROUTES)
      .describe(
        'CHINA ships in two legs (China → UAE, then UAE → Egypt); UAE_DIRECT in one (UAE → Egypt).',
      ),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'a three-letter currency code')
      .optional()
      .describe('Defaults to EGP.'),
    startedOn: day
      .optional()
      .describe(
        'Only for a cycle that started before today. Never the future.',
      ),
  };
  const createInput = (i: {
    route: string;
    currency?: string;
    startedOn?: string;
  }) => ({
    originType: i.route,
    currency: i.currency,
    startedOn: i.startedOn,
  });

  writeTool(
    server,
    ctx,
    'create_cycle',
    {
      title: 'Create an import cycle',
      description:
        'Start a new import cycle (one physical shipment) in PLANNING. The active core partners join it with zero contributions.',
      inputSchema: createShape,
    },
    {
      async preview(input) {
        const plan = await cycles().planCreate(createInput(input));
        const legs = plan.expectedLegs;
        const partners = (plan.defaultPartners ?? []).map(
          (p) => p.partner?.displayName ?? p.email,
        );
        return {
          summary: [
            `Create cycle ${plan.code} (${plan.originType}, ${plan.currency}), starting ${plan.startedOn.toISOString().slice(0, 10)}, in PLANNING.`,
            `It ships in ${legs.length} leg${legs.length === 1 ? '' : 's'}: ${legs
              .map((l) => `${l.sequence}. ${route(l.origin, l.destination)}`)
              .join('; ')}. Add them with add_shipping_leg.`,
            partners.length
              ? `Participants: ${partners.join(', ')}, contributions to be set once the cycle is costed.`
              : 'No active core partner will be added.',
            'The code is the next free one now; if another cycle is created first it moves on by one.',
          ].join('\n'),
          data: {
            code: plan.code,
            route: plan.originType,
            currency: plan.currency,
            startedOn: plan.startedOn,
            expectedLegs: legs,
            participants: partners,
          },
        };
      },
      async commit(input) {
        const { data: cycle } = await cycles().create(
          createInput(input),
          ctx.user.id,
        );
        const legs = expectedLegs(cycle.originType);
        return {
          summary: `Created cycle ${cycle.code} (${cycle.originType}) in PLANNING. It expects ${legs.length} shipping leg${legs.length === 1 ? '' : 's'}.`,
          data: {
            id: cycle.id,
            code: cycle.code,
            route: cycle.originType,
            status: cycle.status,
            expectedLegs: legs,
          },
        };
      },
    },
  );

  // ─── add_shipping_leg ───────────────────────────────────────────────────
  const legShape = {
    cycleId,
    sequence: z
      .number()
      .int()
      .describe(
        'CHINA: 1 = China → UAE, 2 = UAE → Egypt. UAE_DIRECT: 1 = UAE → Egypt.',
      ),
    origin: z
      .string()
      .min(1)
      .optional()
      .describe("Defaults to the route's usual place."),
    destination: z
      .string()
      .min(1)
      .optional()
      .describe("Defaults to the route's usual place."),
    provider: z.string().optional(),
    trackingRef: z.string().optional(),
    departedOn: day.optional(),
    arrivedOn: day
      .optional()
      .describe('Needs departedOn. Neither date may be in the future.'),
    costBasis: z
      .enum(['PER_PIECE', 'PER_WEIGHT', 'FLAT'])
      .optional()
      .describe('Defaults to FLAT (one agreed amount).'),
    ratePerUnit: z
      .number()
      .nonnegative()
      .optional()
      .describe('Per piece, or per kg for PER_WEIGHT.'),
    chargeablePieces: z.number().nonnegative().optional(),
    chargeableWeightKg: z.number().nonnegative().optional(),
    amount: z
      .number()
      .nonnegative()
      .optional()
      .describe('FLAT only; rate-based legs derive their total.'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'a three-letter currency code')
      .optional()
      .describe('Defaults to EGP.'),
    fxRateToEgp: z
      .number()
      .positive()
      .optional()
      .describe('Required for a currency other than EGP.'),
  };

  writeTool(
    server,
    ctx,
    'add_shipping_leg',
    {
      title: 'Add a shipping leg',
      description:
        "Record one leg of a cycle's shipment: its route, departure date and cost. An arrival date means everything still on the way on that leg arrived that day: it is recorded as one delivery of all of it. When the goods came in pieces, leave arrivedOn out and record each piece with record_delivery.",
      inputSchema: legShape,
    },
    {
      async preview({ cycleId: id, ...leg }) {
        const { cycle, leg: planned } = await shipping().planLeg(id, leg);
        const native = planned.amount ? formatMoney(planned.amount) : '0.00';
        const arrival = leg.arrivedOn
          ? await arrivalDelivery(id, planned)
          : null;
        const status = arrival?.status ?? planned.status;
        const deliveryLines = arrival
          ? arrival.lines.length > 0
            ? [
                `The arrival on ${leg.arrivedOn} is recorded as one delivery of everything on the way on this leg:`,
                ...arrival.lines.map((l) => `- ${l.product}: ${l.qty}`),
              ]
            : [
                `Nothing is on the way on this leg yet, so the arrival on ${leg.arrivedOn} delivers nothing.`,
              ]
          : [];
        return {
          summary: [
            `Add leg ${planned.sequence} to ${cycle.code}: ${route(planned.origin, planned.destination)}.`,
            `Status ${status}${planned.departedOn ? `, departed ${leg.departedOn}` : ''}.`,
            ...deliveryLines,
            `Cost (${planned.costBasis}): ${native} ${planned.currency}` +
              (planned.currency === 'EGP'
                ? '.'
                : ` × ${planned.fxRateToEgp.toString()} = ${formatMoney(planned.amountEgp)} EGP.`),
          ].join('\n'),
          data: {
            cycle: cycle.code,
            ...planned,
            status,
            amountEgp: planned.amountEgp.toFixed(2),
            delivers: arrival?.lines ?? [],
          },
        };
      },
      // The units the arrival delivers: if the leg before delivered more
      // after the preview, the same arrival date would deliver goods the
      // partner was never shown.
      binds: (preview) => (preview.data as { delivers: unknown }).delivers,
      async commit({ cycleId: id, ...leg }) {
        const { data } = await shipping().createLeg(id, leg, ctx.user.id);
        return {
          summary: `Added leg ${data.sequence} (${route(data.origin, data.destination)}), ${data.status}, ${formatMoney(data.amountEgp)} EGP.`,
          data,
        };
      },
    },
  );

  /**
   * What a new leg's arrival date will deliver: everything on the way on it
   * (§1, 2026-10-10) — for leg 1 what was ordered, for a later leg what the
   * leg before delivered, less losses. Read from `shipmentPosition` with the
   * leg added, the same reading `createLeg` delivers by; nothing written.
   */
  async function arrivalDelivery(
    cycleId: string,
    planned: {
      sequence: number;
      origin: string;
      destination: string;
      departedOn?: Date;
      arrivedOn?: Date;
    },
  ) {
    const loaded = await loadShipment(prisma(), cycleId);
    if (!loaded) throw notFound('cycle');
    const { cycle } = loaded;
    const NEW = 'the-new-leg';
    const legs = [
      ...cycle.shippingLegs,
      {
        id: NEW,
        sequence: planned.sequence,
        departedOn: planned.departedOn ?? null,
      },
    ];
    const lines = cycle.purchaseOrders.flatMap((po) =>
      po.items.map((i) => ({
        id: i.id,
        orderedQty: i.orderedQty,
        productName: i.product.name,
      })),
    );
    const positionWith = (arrival: PositionDeliveryInput[]) =>
      shipmentPosition({
        lines,
        legs,
        deliveries: [
          ...cycle.shippingLegs.flatMap((l) => l.deliveries),
          ...arrival,
        ],
        losses: cycle.shippingLegs.flatMap((l) => l.losses),
        batches: cycle.inventoryBatches,
      }).legs.find((l) => l.legId === NEW)!;

    const onTheWay = positionWith([]).lines.filter((l) => l.onTheWay > 0);
    const after = positionWith(
      onTheWay.length
        ? [
            {
              id: 'the-arrival',
              legId: NEW,
              arrivedOn: planned.arrivedOn!,
              lines: onTheWay.map((l) => ({
                id: `the-arrival-${l.purchaseOrderItemId}`,
                purchaseOrderItemId: l.purchaseOrderItemId,
                qty: l.onTheWay,
              })),
            },
          ]
        : [],
    );

    const names = new Map(lines.map((l) => [l.id, l.productName]));
    return {
      status: after.status,
      lines: onTheWay.map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        product: names.get(l.purchaseOrderItemId)!,
        qty: formatQty(l.onTheWay),
      })),
    };
  }

  // ─── transition_cycle ───────────────────────────────────────────────────
  writeTool(
    server,
    ctx,
    'transition_cycle',
    {
      title: 'Move a cycle to its next status',
      description:
        'Advance a cycle (or cancel it). Leaving PURCHASING confirms and locks its draft purchase orders. Cancelling is final.',
      inputSchema: {
        cycleId,
        fromStatus: z
          .enum(ALL_STATUSES)
          .describe(
            'The status the cycle is in now, as the partner saw it. If it has moved since, nothing is changed.',
          ),
        status: z.enum(ASSISTANT_TARGETS).describe('The status to move to.'),
      },
    },
    {
      async preview({ cycleId: id, fromStatus, status }) {
        const plan = await cycles().planTransition(id, status, {
          expectedFrom: fromStatus,
        });
        const lines = [
          `Move ${plan.cycle.code} from ${plan.from} to ${plan.to}.`,
        ];
        if (plan.ordersToConfirm.length > 0) {
          lines.push(
            `This confirms and locks ${plan.ordersToConfirm.length} purchase order${plan.ordersToConfirm.length === 1 ? '' : 's'} — after this no line can be added to ${plan.ordersToConfirm.length === 1 ? 'it' : 'them'}:`,
            ...plan.ordersToConfirm.map(
              (o) =>
                `- ${o.reference}${o.supplier ? ` (${o.supplier})` : ''}, ${o.lines} line${o.lines === 1 ? '' : 's'}`,
            ),
          );
        } else if (plan.leavingPurchasing) {
          lines.push('There are no draft purchase orders to confirm.');
        }
        if (plan.to === 'CANCELLED') {
          lines.push(
            'Cancelling is final: a cancelled cycle cannot be reopened or moved again, and none of its purchase orders are confirmed.',
          );
        }
        return {
          summary: lines.join('\n'),
          data: {
            cycle: plan.cycle.code,
            from: plan.from,
            to: plan.to,
            ordersToConfirm: plan.ordersToConfirm,
            final: plan.final,
          },
        };
      },
      // The orders it will lock, line counts included: a draft created, or a
      // line added, after the preview would otherwise be locked unseen.
      binds: (preview) =>
        (preview.data as { ordersToConfirm: unknown }).ordersToConfirm,
      async commit({ cycleId: id, fromStatus, status }) {
        const { data } = await cycles().transition(id, status, ctx.user.id, {
          expectedFrom: fromStatus,
        });
        return {
          summary: `${data.code} is now ${data.status}.`,
          data: { id: data.id, code: data.code, status: data.status },
        };
      },
    },
  );

  // ─── record_delivery ────────────────────────────────────────────────────
  writeTool(
    server,
    ctx,
    'record_delivery',
    {
      title: 'Record a delivery on a shipping leg',
      description:
        "Record goods arriving at the end of a shipping leg: the day they arrived and how many of each ordered product came. A shipment's goods leave together but arrive in pieces, weeks apart — record each delivery as it comes, with what actually arrived. A leg can only deliver what is on the way on it: everything ordered for the first leg, and for a later leg what the leg before it delivered (get_cycle shows, per leg and product, what is on the way). Whatever has not come stays on the way; marking goods lost is done in the office app, never here. A delivery on the leg that ends in Egypt is then received into stock with verify_stock.",
      inputSchema: {
        legId: z
          .string()
          .describe('The shipping leg (get_cycle lists each leg with its id).'),
        arrivedOn: day.describe(
          'The day the goods arrived. Not in the future, not before the leg departed.',
        ),
        lines: z
          .array(
            z.object({
              purchaseOrderItemId: z
                .string()
                .describe(
                  'The purchase order line (get_cycle lists them, with what is on the way).',
                ),
              qty: z
                .number()
                .describe(
                  'How many of it arrived. More than zero, at most what is on the way on this leg.',
                ),
            }),
          )
          .describe('One line per product that arrived, each product once.'),
        note: z.string().max(500).optional(),
      },
    },
    {
      async preview(input) {
        const seen = await dryRunDelivery(input);
        const lines = input.lines.map((l) => {
          const after = seen.leg.lines.find(
            (x) => x.purchaseOrderItemId === l.purchaseOrderItemId,
          )!;
          const product =
            seen.position.lines.find(
              (x) => x.purchaseOrderItemId === l.purchaseOrderItemId,
            )?.productName ?? l.purchaseOrderItemId;
          return {
            purchaseOrderItemId: l.purchaseOrderItemId,
            product,
            qty: formatQty(l.qty),
            onTheWayBefore: formatQty(after.onTheWay + Number(l.qty)),
            onTheWayAfter: formatQty(after.onTheWay),
          };
        });
        const where = route(seen.legRow.origin, seen.legRow.destination);
        return {
          summary: [
            `Record a delivery on ${seen.cycle.code}, leg ${seen.leg.sequence} (${where}), arrived ${input.arrivedOn}:`,
            ...lines.map(
              (l) =>
                `- ${l.product}: ${l.qty} arrived; ${l.onTheWayBefore} were on the way, ${l.onTheWayAfter} will still be on the way.`,
            ),
            `Afterwards the leg reads ${seen.leg.status}.`,
            seen.leg.isLast
              ? 'This leg ends in Egypt: once recorded, the delivery can be received into stock with verify_stock.'
              : 'The goods can then travel on the next leg.',
          ].join('\n'),
          data: {
            cycle: seen.cycle.code,
            legId: input.legId,
            leg: seen.leg.sequence,
            route: where,
            arrivedOn: input.arrivedOn,
            lines,
            legStatusAfter: seen.leg.status,
          },
        };
      },
      // What the partner was told would still be on the way. A delivery
      // recorded by someone else in between leaves less than that, so the
      // same quantities would no longer mean what the partner agreed to.
      binds: (preview) =>
        (
          preview.data as {
            lines: {
              purchaseOrderItemId: string;
              qty: string;
              onTheWayAfter: string;
            }[];
          }
        ).lines.map((l) => [l.purchaseOrderItemId, l.qty, l.onTheWayAfter]),
      async commit({ legId, ...body }) {
        const { data } = await deliveries().recordDelivery(
          legId,
          body,
          ctx.user.id,
        );
        return {
          summary: `Recorded the delivery of ${body.arrivedOn}: ${data.lines.length} product${data.lines.length === 1 ? '' : 's'}.`,
          data: {
            deliveryId: data.id,
            legId: data.legId,
            arrivedOn: body.arrivedOn,
            lines: data.lines.map((l) => ({
              deliveryLineId: l.id,
              purchaseOrderItemId: l.purchaseOrderItemId,
              qty: l.qty.toString(),
            })),
          },
        };
      },
    },
  );

  /**
   * The delivery as the deliveries service would record it — every one of its
   * checks, under the cycle's lock — rolled back, and the shipment as it would
   * then stand. See `dry-run.ts`.
   */
  async function dryRunDelivery(input: {
    legId: string;
    arrivedOn: string;
    lines: { purchaseOrderItemId: string; qty: number }[];
    note?: string;
  }) {
    const dry = rollingBack(prisma(), async (tx) => {
      const leg = await tx.shippingLeg.findUniqueOrThrow({
        where: { id: input.legId },
        select: { cycleId: true },
      });
      return loadShipment(tx, leg.cycleId);
    });
    const service = new DeliveriesService(
      dry,
      ctx.resolve(AuditService),
      ctx.resolve(NotificationsService),
      ctx.resolve(CostingService),
    );
    const seen = await previewByRollback<
      Awaited<ReturnType<typeof loadShipment>>
    >(() =>
      service.recordDelivery(
        input.legId,
        { arrivedOn: input.arrivedOn, lines: input.lines, note: input.note },
        ctx.user.id,
      ),
    );
    const { cycle, position } = seen!;
    return {
      cycle,
      position,
      leg: position.legs.find((l) => l.legId === input.legId)!,
      legRow: cycle.shippingLegs.find((l) => l.id === input.legId)!,
    };
  }

  // ─── verify_stock ───────────────────────────────────────────────────────
  writeTool(
    server,
    ctx,
    'verify_stock',
    {
      title: 'Receive a delivery into stock',
      description:
        "Receive one delivery that reached Egypt into sellable stock. Goods arrive in deliveries (record_delivery); each delivery on the leg that ends in Egypt is counted and received on its own, and is sellable at once while the rest of the shipment is still on the way. get_cycle lists the deliveries, each line's id, and how much of each product is waiting to be received. Name the delivery and, per line, how many were counted in; fewer than the delivery brought leaves the rest waiting, to be received in a later call. Each unit is booked at the landed cost per ordered unit (goods plus every leg's shipping, spread over what was ordered), the same whichever delivery brought it. The cycle must have arrived in Egypt; the first receipt moves it on through VERIFICATION to SELLING, and later deliveries are received while it is SELLING. Goods that never came are marked lost in the office app, not here.",
      inputSchema: {
        deliveryId: z
          .string()
          .describe(
            "The delivery on the last leg (get_cycle lists each leg's deliveries with their ids).",
          ),
        items: z.array(
          z.object({
            deliveryLineId: z
              .string()
              .describe('The line of that delivery (get_cycle lists them).'),
            receivedQty: z
              .number()
              .describe(
                'How many were counted in. More than zero, at most what the delivery brought that is still waiting to be received.',
              ),
            landedUnitCostEgp: z
              .number()
              .optional()
              .describe(
                'Leave out to use the computed landed cost. Only for a partner who states a different figure.',
              ),
          }),
        ),
      },
    },
    {
      async preview({ deliveryId, items }) {
        const cycleId = await deliveryCycle(deliveryId);
        const plan = await inventory().planVerification(cycleId, {
          deliveryId,
          items,
        });
        const arrivedOn = plan.lines[0]?.arrivedOn;
        return {
          summary: [
            `Receive the delivery of ${arrivedOn} into stock on ${plan.cycle.code}:`,
            ...plan.lines.map(
              (l) =>
                `- ${l.productName}: ${formatQty(l.receivedQty)} counted in (${formatQty(l.orderedQty)} ordered), landed ${l.landedUnitCostEgp.toFixed(4)} EGP/unit${l.costSource === 'manual' ? ' (entered by hand)' : ''} = ${formatMoney(l.lineCostEgp)} EGP`,
            ),
            `Total booked to the cycle: ${formatMoney(plan.totalEgp)} EGP.`,
            plan.cycle.status === 'SELLING'
              ? `${plan.cycle.code} stays SELLING.`
              : `This is the cycle's first receipt: it moves ${plan.cycle.code} from ${plan.cycle.status} to SELLING.`,
            ...plan.warnings.map((w) => `Warning: ${w}`),
          ].join('\n'),
          data: {
            cycle: plan.cycle.code,
            deliveryId,
            arrivedOn,
            cycleStatusAfter: 'SELLING',
            lines: plan.lines.map((l) => ({
              deliveryLineId: l.deliveryLineId,
              purchaseOrderItemId: l.purchaseOrderItemId,
              product: l.productName,
              orderedQty: l.orderedQty.toString(),
              receivedQty: l.receivedQty.toString(),
              landedUnitCostEgp: l.landedUnitCostEgp.toFixed(4),
              costSource: l.costSource,
              lineCostEgp: l.lineCostEgp.toFixed(2),
            })),
            totalEgp: plan.totalEgp.toFixed(2),
            warnings: plan.warnings,
          },
        };
      },
      // The landed costs shown: a leg's cost corrected, or a loss that moves a
      // line's final rounding, after the preview would otherwise book stock at
      // a figure the partner never saw.
      binds: (preview) => {
        const shown = preview.data as {
          lines: {
            deliveryLineId: string;
            landedUnitCostEgp: string;
            lineCostEgp: string;
          }[];
          totalEgp: string;
        };
        return {
          lines: shown.lines.map((l) => [
            l.deliveryLineId,
            l.landedUnitCostEgp,
            l.lineCostEgp,
          ]),
          totalEgp: shown.totalEgp,
        };
      },
      async commit({ deliveryId, items }) {
        const cycleId = await deliveryCycle(deliveryId);
        const { data } = await inventory().verifyStock(
          cycleId,
          { deliveryId, items },
          ctx.user.id,
        );
        return {
          summary: `Received ${data.length} line${data.length === 1 ? '' : 's'} into stock; they can be sold now.`,
          data: data.map((b) => ({
            batchId: b.id,
            purchaseOrderItemId: b.sourcePoItemId,
            deliveryLineId: b.sourceDeliveryLineId,
          })),
        };
      },
    },
  );

  /** The cycle a delivery belongs to; any other id is "no such delivery". */
  async function deliveryCycle(deliveryId: string): Promise<string> {
    if (!isUuid(deliveryId)) throw notFound('shipmentDelivery');
    const found = await prisma().shipmentDelivery.findUnique({
      where: { id: deliveryId },
      select: { leg: { select: { cycleId: true } } },
    });
    if (!found) throw notFound('shipmentDelivery');
    return found.leg.cycleId;
  }
}
