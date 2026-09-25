import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CycleStatus } from '@prisma/client';
import { z } from 'zod';

import { CYCLE_ROUTES, expectedLegs } from '../../../common/cycle-routes';
import { formatMoney, formatQty } from '../../../common/money';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryService } from '../../inventory/inventory.service';
import { ShippingService } from '../../shipping/shipping.service';
import { writeTool, type AssistantContext } from '../tool-kit';

/**
 * The cycle tools: create_cycle, add_shipping_leg, transition_cycle,
 * verify_stock. Each changes something, so each is a `writeTool`.
 *
 * Every preview comes from the service's own `plan…` method and every commit
 * from the method the office app's controller calls, which starts by running
 * that same plan. Preview and commit therefore cannot disagree about what is
 * allowed, what a leg costs, which orders a transition locks or what a unit of
 * stock lands at — and the assistant is refused whatever the office app is.
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
        "Record one leg of a cycle's shipment: its route, dates and cost. Its status is read from the dates.",
      inputSchema: legShape,
    },
    {
      async preview({ cycleId: id, ...leg }) {
        const { cycle, leg: planned } = await shipping().planLeg(id, leg);
        const native = planned.amount ? formatMoney(planned.amount) : '0.00';
        return {
          summary: [
            `Add leg ${planned.sequence} to ${cycle.code}: ${route(planned.origin, planned.destination)}.`,
            `Status ${planned.status}${planned.departedOn ? `, departed ${leg.departedOn}` : ''}${planned.arrivedOn ? `, arrived ${leg.arrivedOn}` : ''}.`,
            `Cost (${planned.costBasis}): ${native} ${planned.currency}` +
              (planned.currency === 'EGP'
                ? '.'
                : ` × ${planned.fxRateToEgp.toString()} = ${formatMoney(planned.amountEgp)} EGP.`),
          ].join('\n'),
          data: {
            cycle: cycle.code,
            ...planned,
            amountEgp: planned.amountEgp.toFixed(2),
          },
        };
      },
      async commit({ cycleId: id, ...leg }) {
        const { data } = await shipping().createLeg(id, leg, ctx.user.id);
        return {
          summary: `Added leg ${data.sequence} (${route(data.origin, data.destination)}), ${data.status}, ${formatMoney(data.amountEgp)} EGP.`,
          data,
        };
      },
    },
  );

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

  // ─── verify_stock ───────────────────────────────────────────────────────
  writeTool(
    server,
    ctx,
    'verify_stock',
    {
      title: 'Verify stock into inventory',
      description:
        "Book what arrived on a cycle in VERIFICATION into sellable stock, at its landed cost (goods plus the legs' shipping). Each order line can be verified once.",
      inputSchema: {
        cycleId,
        items: z.array(
          z.object({
            purchaseOrderItemId: z
              .string()
              .describe('The purchase order line (get_cycle lists them).'),
            receivedQty: z
              .number()
              .describe(
                'How many arrived. More than zero, at most what was ordered.',
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
      async preview({ cycleId: id, items }) {
        const plan = await inventory().planVerification(id, { items });
        return {
          summary: [
            `Verify stock into ${plan.cycle.code}:`,
            ...plan.lines.map(
              (l) =>
                `- ${l.productName}: ${formatQty(l.receivedQty)} of ${formatQty(l.orderedQty)} ordered, landed ${l.landedUnitCostEgp.toFixed(4)} EGP/unit${l.costSource === 'manual' ? ' (entered by hand)' : ''} = ${formatMoney(l.lineCostEgp)} EGP`,
            ),
            `Total booked to the cycle: ${formatMoney(plan.totalEgp)} EGP.`,
            ...plan.warnings.map((w) => `Warning: ${w}`),
          ].join('\n'),
          data: {
            cycle: plan.cycle.code,
            lines: plan.lines.map((l) => ({
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
      // The landed costs shown: a leg's cost corrected after the preview
      // would otherwise book stock at a figure the partner never saw.
      binds: (preview) => {
        const shown = preview.data as {
          lines: { purchaseOrderItemId: string; landedUnitCostEgp: string }[];
          totalEgp: string;
        };
        return {
          lines: shown.lines.map((l) => [
            l.purchaseOrderItemId,
            l.landedUnitCostEgp,
          ]),
          totalEgp: shown.totalEgp,
        };
      },
      async commit({ cycleId: id, items }) {
        const { data } = await inventory().verifyStock(
          id,
          { items },
          ctx.user.id,
        );
        return {
          summary: `Verified ${data.length} line${data.length === 1 ? '' : 's'} into stock.`,
          data: data.map((b: { id: string; sourcePoItemId: string }) => ({
            batchId: b.id,
            purchaseOrderItemId: b.sourcePoItemId,
          })),
        };
      },
    },
  );
}
