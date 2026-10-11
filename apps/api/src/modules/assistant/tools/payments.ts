import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../../../common/api-error';
import { owedBy } from '../../../common/customer-balance';
import { assertDayRange, businessToday } from '../../../common/dates';
import { formatMoney } from '../../../common/money';
import { PAYMENT_METHODS } from '../../../common/walk-in';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PAYMENT_ROLES } from '../../payments/payment-roles';
import { PaymentsService } from '../../payments/payments.service';
import { previewByRollback, rollingBack } from '../dry-run';
import { matchByName } from '../receipt/name-matching';
import { writeTool, type AssistantContext } from '../tool-kit';

/**
 * record_payment (BUSINESS_LOGIC §16, owner 2026-10-11: "the assistant can
 * record a payment").
 *
 * "El-Sayed paid 5,000 cash." The customer is found with the one matcher
 * (`receipt/name-matching.ts`), exactly as record_sale finds one: only an id or
 * the exact name is taken; anything close is a question with candidates and no
 * confirmation token.
 *
 * Every rule of a payment stays in `PaymentsService.create` — the call the
 * office app's Record payment makes. No paying more than is owed, no date in
 * the future, no other shop's order, no unverified shop: the assistant is
 * refused whatever the office app would be. The preview is that same call run
 * against a database that rolls back (`dry-run.ts`), so it shows exactly where
 * the money would go and what the balance would be.
 *
 * Without an order the money goes on the shop's unpaid orders oldest first,
 * through the service's own `applyOldestFirst` — the same definition the
 * office dialog uses (§7).
 *
 * What the preview showed binds: the balance before, each order the money
 * lands on and how much, and the balance after. Another payment or sale for
 * this shop in between is PREVIEW_CHANGED.
 */

const CURRENCY = 'EGP';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const paymentShape = {
  customer: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'The customer (a shop on file) who paid, by name or id. Never a new customer — they are added in the office app.',
    ),
  amount: z
    .number()
    .describe(
      'How much was paid, in EGP. More than zero, at most two decimals.',
    ),
  method: z
    .enum(PAYMENT_METHODS)
    .optional()
    .describe('How it was paid; CASH when unsaid.'),
  receivedOn: z
    .string()
    .trim()
    .regex(DAY, 'YYYY-MM-DD')
    .optional()
    .describe(
      'The day the money was received, YYYY-MM-DD. Today (Cairo) when unsaid. Never a day that has not come yet.',
    ),
  order: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Only when the partner names an order (its number, e.g. SO-2026-0001): the money goes on that order alone. Otherwise leave out — it is applied to the oldest unpaid orders first.',
    ),
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('A receipt, transfer or cheque number, if the partner gave one.'),
};

type PaymentInput = {
  customer: string;
  amount: number;
  method?: (typeof PAYMENT_METHODS)[number];
  receivedOn?: string;
  order?: string;
  reference?: string;
};

export interface PaymentQuestion {
  id: 'CUSTOMER_WHICH' | 'CUSTOMER_UNKNOWN';
  kind: 'CUSTOMER_WHICH' | 'CUSTOMER_UNKNOWN';
  text: string;
  options: { value: string; label: string; score?: number }[];
}

interface CatalogueCustomer {
  id: string;
  name: string;
}

type Plan =
  | { status: 'questions'; questions: PaymentQuestion[] }
  | {
      status: 'ready';
      customer: CatalogueCustomer;
      method: (typeof PAYMENT_METHODS)[number];
      receivedOn: string;
      body: {
        customerId: string;
        amount: number;
        currency: string;
        receivedOn: string;
        method: string;
        reference?: string;
        orderId?: string;
        applyOldestFirst?: boolean;
      };
      order: { id: string; orderNo: string } | null;
    };

/** A payment's money, to the cent — "5000" and "5000.00" are one amount. */
function cents(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/**
 * Reads the input against the customers on file and settles who paid.
 * Pure: the catalogue is handed in. The order, when named, is looked up by
 * the caller among that customer's own orders.
 */
export function resolvePayer(
  input: PaymentInput,
  customers: CatalogueCustomer[],
):
  | { status: 'matched'; customer: CatalogueCustomer }
  | {
      status: 'questions';
      questions: PaymentQuestion[];
    } {
  const found = matchByName(
    { id: input.customer, name: input.customer },
    customers,
    'customer',
  );
  if (found.status === 'matched') {
    return { status: 'matched', customer: found.match.item };
  }
  if (found.status === 'unknown') {
    return {
      status: 'questions',
      questions: [
        {
          id: 'CUSTOMER_UNKNOWN',
          kind: 'CUSTOMER_UNKNOWN',
          text: `"${input.customer}" is not a customer on file. Which customer paid? New customers are added in the office app, not here.`,
          options: [],
        },
      ],
    };
  }
  return {
    status: 'questions',
    questions: [
      {
        id: 'CUSTOMER_WHICH',
        kind: 'CUSTOMER_WHICH',
        text: `"${input.customer}" is not an exact match for a customer on file. Which customer paid?`,
        options: found.candidates.map((c) => ({
          value: c.item.id,
          label: c.item.name,
          score: c.score,
        })),
      },
    ],
  };
}

/** Where the money landed, as a dry run or the real write left it. */
interface Landed {
  paymentId: string;
  allocations: { orderNo: string; amount: string; owesAfter: string }[];
  unapplied: string;
  balanceAfter: string;
}

export function registerPaymentTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const prisma = () => ctx.resolve(PrismaService);
  const audit = () => ctx.resolve(AuditService);

  /** The office endpoint's roles (CLAUDE.md §12), not a list of its own. */
  function assertAllowed() {
    if (!(PAYMENT_ROLES as readonly string[]).includes(ctx.user.role)) {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Your role does not allow this action.',
        { role: ctx.user.role },
      );
    }
  }

  async function customers(): Promise<CatalogueCustomer[]> {
    // The walk-in record never owes (§4), so it is never named as a payer.
    const rows = await prisma().customer.findMany({
      where: { isWalkIn: false },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((c) => ({ id: c.id, name: c.displayName }));
  }

  async function plan(input: PaymentInput): Promise<Plan> {
    assertAllowed();
    if (!cents(input.amount)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'A payment is money: at most two decimals.',
        { fields: 'amount' },
      );
    }
    if (input.receivedOn) assertDayRange(input.receivedOn);

    const payer = resolvePayer(input, await customers());
    if (payer.status === 'questions') return payer;

    let order: { id: string; orderNo: string } | null = null;
    if (input.order) {
      const named = input.order.trim();
      // This shop's own orders only: another shop's order is not one it can
      // pay on, so it is "not found" here as it is on the office form.
      const own = await prisma().saleOrder.findMany({
        where: { customerId: payer.customer.id },
        select: { id: true, orderNo: true },
      });
      order =
        own.find(
          (o) =>
            o.id === named || o.orderNo.toLowerCase() === named.toLowerCase(),
        ) ?? null;
      if (!order) throw notFound('saleOrder');
    }

    const receivedOn = input.receivedOn ?? businessToday();
    const method = input.method ?? 'CASH';
    return {
      status: 'ready',
      customer: payer.customer,
      method,
      receivedOn,
      order,
      body: {
        customerId: payer.customer.id,
        amount: input.amount,
        currency: CURRENCY,
        receivedOn,
        method,
        ...(input.reference ? { reference: input.reference } : {}),
        ...(order ? { orderId: order.id } : { applyOldestFirst: true }),
      },
    };
  }

  /** What a payment left behind: its allocations and the shop's balance. */
  async function landed(
    db: Pick<PrismaService, 'payment' | 'saleOrder'>,
    customerId: string,
    paymentId?: string,
  ): Promise<Landed> {
    const payment = await db.payment.findFirstOrThrow({
      where: paymentId ? { id: paymentId } : { customerId, createdBy: actor },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        amount: true,
        allocations: {
          select: {
            amount: true,
            saleOrder: {
              select: { orderNo: true, outstanding: true, createdAt: true },
            },
          },
        },
      },
    });
    const allocations = payment.allocations
      .slice()
      .sort((a, b) => +a.saleOrder.createdAt - +b.saleOrder.createdAt)
      .map((a) => ({
        orderNo: a.saleOrder.orderNo,
        amount: Number(a.amount).toFixed(2),
        owesAfter: Number(a.saleOrder.outstanding).toFixed(2),
      }));
    const applied = allocations.reduce((s, a) => s + Number(a.amount), 0);
    return {
      paymentId: payment.id,
      allocations,
      unapplied: (Number(payment.amount) - applied).toFixed(2),
      balanceAfter: await owedBy(db, customerId),
    };
  }

  /** The payment as the payments service would make it, rolled back. */
  async function dryRun(body: Extract<Plan, { status: 'ready' }>['body']) {
    const dry = rollingBack(prisma(), (tx) =>
      // Inside the rolled-back transaction, the newest payment this partner
      // made for this shop is the one just written: `now()` is the
      // transaction's start, after every payment already committed.
      landed(tx, body.customerId),
    );
    const service = new PaymentsService(dry, audit());
    return previewByRollback<Landed>(() => service.create(body, actor));
  }

  function describe(
    p: Extract<Plan, { status: 'ready' }>,
    before: string,
    seen: Landed,
  ): string {
    return [
      `Payment from ${p.customer.name}: ${formatMoney(p.body.amount)} ${CURRENCY} by ${p.method}, received ${p.receivedOn}.`,
      p.order
        ? `On order ${p.order.orderNo}, as named:`
        : 'Applied to the oldest unpaid orders first:',
      ...seen.allocations.map(
        (a) =>
          `- ${a.orderNo}: ${formatMoney(a.amount)} ${CURRENCY}` +
          (Number(a.owesAfter) > 0
            ? `, still owes ${formatMoney(a.owesAfter)} after`
            : ', paid in full'),
      ),
      ...(Number(seen.unapplied) > 0
        ? [`${formatMoney(seen.unapplied)} ${CURRENCY} on no order.`]
        : []),
      `Balance: ${formatMoney(before)} ${CURRENCY} before, ${formatMoney(seen.balanceAfter)} ${CURRENCY} after.`,
    ].join('\n');
  }

  async function preview(input: PaymentInput) {
    const p = await plan(input);
    if (p.status === 'questions') {
      return {
        needsAnswers: true,
        summary: [
          'This payment cannot be previewed yet:',
          ...p.questions.map(
            (q) =>
              `- ${q.text}${q.options.length ? ` Options: ${q.options.map((o) => o.label).join('; ')}.` : ''}`,
          ),
        ].join('\n'),
        data: { questions: p.questions },
      };
    }
    const before = await owedBy(prisma(), p.customer.id);
    const seen = await dryRun(p.body);
    return {
      summary: describe(p, before, seen),
      data: {
        customer: { id: p.customer.id, name: p.customer.name },
        amount: Number(p.body.amount).toFixed(2),
        currency: CURRENCY,
        method: p.method,
        receivedOn: p.receivedOn,
        order: p.order?.orderNo ?? null,
        balanceBefore: before,
        allocations: seen.allocations,
        unapplied: seen.unapplied,
        balanceAfter: seen.balanceAfter,
      },
    };
  }

  writeTool(
    server,
    ctx,
    'record_payment',
    {
      title: 'Record a payment',
      description:
        'Records money a customer (a shop on file) paid. Applied to the oldest unpaid orders first, or to one order when the partner names it. ' +
        'The customer is matched by exact name or id only: a close name comes back as a question with candidates and nothing to confirm. ' +
        'Refused when it is more than the shop owes (or the named order owes), dated in the future, or the shop is unverified. ' +
        'The preview shows where the money goes and the balance before and after. Call without a confirmationToken to preview.',
      inputSchema: paymentShape,
    },
    {
      preview,
      // What was agreed to: who, how much, when, where it lands and the
      // balance it was shown against. A sale or payment in between changes
      // the last two and is refused.
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as {
          customer: { id: string };
          amount: string;
          method: string;
          receivedOn: string;
          balanceBefore: string;
          allocations: { orderNo: string; amount: string }[];
          balanceAfter: string;
        };
        return {
          customer: d.customer.id,
          amount: d.amount,
          method: d.method,
          receivedOn: d.receivedOn,
          balanceBefore: d.balanceBefore,
          allocations: d.allocations.map((a) => [a.orderNo, a.amount]),
          balanceAfter: d.balanceAfter,
        };
      },
      async commit(input) {
        const p = await plan(input);
        // Unreachable after a bound preview, which already refused this.
        if (p.status === 'questions') {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        const before = await owedBy(prisma(), p.customer.id);
        const { data } = (await ctx
          .resolve(PaymentsService)
          .create(p.body, actor)) as { data: { id: string } };
        const after = await landed(prisma(), p.customer.id, data.id);
        return {
          summary: `Recorded. ${describe(p, before, after)}`,
          data: {
            paymentId: data.id,
            customer: { id: p.customer.id, name: p.customer.name },
            amount: Number(p.body.amount).toFixed(2),
            currency: CURRENCY,
            method: p.method,
            receivedOn: p.receivedOn,
            allocations: after.allocations,
            unapplied: after.unapplied,
            balanceAfter: after.balanceAfter,
          },
        };
      },
    },
  );
}
