import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../../../common/api-error';
import { assertDayRange, businessToday } from '../../../common/dates';
import { inPoundsToday, ratesToday } from '../../../common/lenders-owed';
import { formatMoney } from '../../../common/money';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuditService } from '../../audit/audit.service';
import { CostingService } from '../../costing/costing.service';
import {
  LENDER_READ_ROLES,
  LENDER_WRITE_ROLES,
} from '../../lenders/lender-roles';
import { LendersService } from '../../lenders/lenders.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { previewByRollback, rehearse, rollingBack } from '../dry-run';
import { matchByName } from '../receipt/name-matching';
import {
  readTool,
  writeTool,
  type AssistantContext,
  type ToolOutcome,
} from '../tool-kit';

/**
 * The lender tools (BUSINESS_LOGIC §16 and §18, 2026-10-11): list_lenders,
 * get_lender, record_lender_financing, record_lender_repayment.
 *
 * A friend pays a supplier for us in the order's currency, and we repay him
 * in pounds at the day's rate. Every rule of that lives in `LendersService` —
 * the methods the office app's "Paid by a friend" and "Record repayment"
 * call. These tools find the friend, the order and the rate a
 * partner names on a phone, and hand the rest to those methods, so every
 * guard there applies unchanged: not more than the order, not more than is
 * owed, not dated forward, not on a settled cycle.
 *
 * Previews are the service's own write, rolled back (`dry-run.ts`), so what
 * the partner sees is what the write would do. What the preview showed binds:
 * a repayment or a friend's payment in between is PREVIEW_CHANGED.
 *
 * Roles are the office endpoints' (`lender-roles.ts`, CLAUDE.md §12).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const m2 = (v: Prisma.Decimal.Value) => D(v).toFixed(2);

/** Money to the piastre — "5000" and "5000.00" are one amount. */
function places(value: number, n: number): boolean {
  const f = 10 ** n;
  return Math.abs(Math.round(value * f) - value * f) < 1e-6;
}

/** A preview records no audit and tells nobody (`rehearse`). */
const NO_AUDIT = { log: () => Promise.resolve() } as unknown as AuditService;
const NO_NOTIFY = {} as unknown as NotificationsService;

export interface LenderQuestion {
  id:
    | 'LENDER_WHICH'
    | 'LENDER_NEW'
    | 'LENDER_UNKNOWN'
    | 'FINANCING_WHICH'
    | 'RATE_NEEDED';
  kind: LenderQuestion['id'];
  text: string;
  options: { value: string; label: string; score?: number }[];
}

interface Named {
  id: string;
  name: string;
}

type FoundLender =
  | { status: 'matched'; lender: Named }
  | { status: 'questions'; questions: LenderQuestion[] };

/**
 * Who the partner means, by the one matcher (§16): an id or the exact name is
 * taken; anything close is asked. `allowNew` offers "a new lender" — recording
 * what a friend paid may add him; repaying never does.
 */
export function resolveLender(
  ref: string,
  lenders: readonly Named[],
  allowNew: boolean,
): FoundLender {
  const found = matchByName({ id: ref, name: ref }, lenders, 'customer');
  if (found.status === 'matched') {
    return { status: 'matched', lender: found.match.item };
  }
  const addHim = {
    value: 'new',
    label: `None of these — add "${ref}" as a new lender`,
  };
  if (found.status === 'unknown') {
    return {
      status: 'questions',
      questions: [
        allowNew
          ? {
              id: 'LENDER_NEW',
              kind: 'LENDER_NEW',
              text: `"${ref}" is not a lender on file. Should he be added as a new lender? If yes, call again with newLender: true.`,
              options: [
                { value: 'new', label: `Add "${ref}" as a new lender` },
              ],
            }
          : {
              id: 'LENDER_UNKNOWN',
              kind: 'LENDER_UNKNOWN',
              text: `"${ref}" is not a lender on file. Which friend was it? A friend is added when what he paid for is recorded.`,
              options: [],
            },
      ],
    };
  }
  return {
    status: 'questions',
    questions: [
      {
        id: 'LENDER_WHICH',
        kind: 'LENDER_WHICH',
        text: `"${ref}" is not an exact match for a lender on file. Which one is it?${allowNew ? ' Or is he a new lender (call again with newLender: true)?' : ''}`,
        options: [
          ...found.candidates.map((c) => ({
            value: c.item.id,
            label: c.item.name,
            score: c.score,
          })),
          ...(allowNew ? [addHim] : []),
        ],
      },
    ],
  };
}

function questionsSummary(what: string, questions: LenderQuestion[]) {
  return {
    needsAnswers: true,
    summary: [
      `This ${what} cannot be previewed yet:`,
      ...questions.map(
        (q) =>
          `- ${q.text}${q.options.length ? ` Options: ${q.options.map((o) => o.label).join('; ')}.` : ''}`,
      ),
    ].join('\n'),
    data: { questions },
  } satisfies ToolOutcome;
}

/** The facts with the headline, for clients that ignore structured content. */
function answer(headline: string, data: unknown): ToolOutcome {
  return { summary: `${headline}\n${JSON.stringify(data)}`, data };
}

// ─── Shapes ──────────────────────────────────────────────────────────────

const lenderField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe(
    "The friend, by name or id — as the partner said it, e.g. 'Mahmoud'.",
  );

const dayField = (what: string) =>
  z
    .string()
    .trim()
    .regex(DAY, 'YYYY-MM-DD')
    .optional()
    .describe(
      `${what}, YYYY-MM-DD. Today (Cairo) when unsaid. Never a day that has not come yet.`,
    );

const financingShape = {
  lender: lenderField,
  newLender: z
    .boolean()
    .optional()
    .describe(
      'Only after the partner agreed that this friend is new and should be added. Never on your own.',
    ),
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe("A new friend's phone, if the partner gave one."),
  order: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'The purchase order he paid for, by its reference (e.g. PO-2026-0004) or id.',
    ),
  amount: z
    .number()
    .describe(
      'How much he paid, in the currency he paid in (e.g. 30000 for 30,000 AED). More than zero, at most two decimals.',
    ),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'an ISO 4217 code, such as AED')
    .optional()
    .describe(
      "The currency he paid in, as the partner said it — it need not be the order's (an order priced in CNY paid in AED). EGP or any currency on the exchange-rate page. Leave out when unsaid: the order's currency.",
    ),
  fxRateToEgp: z
    .number()
    .optional()
    .describe(
      "EGP per unit of his currency on the day he paid. Use the partner's figure when he gives one. Left out: the order's own rate when he paid in the order's currency, otherwise today's rate from the exchange-rate page — the preview says which. At most four decimals.",
    ),
  paidOn: dayField('The day he paid the supplier'),
  note: z.string().trim().max(500).optional(),
};

const repaymentShape = {
  lender: lenderField,
  amountEgp: z
    .number()
    .optional()
    .describe(
      'Pounds paid to him, e.g. 50000. Give this or payOff, not both. At most two decimals.',
    ),
  payOff: z
    .boolean()
    .optional()
    .describe(
      '"Pay him off": the exact pounds that settle what is still owed at the rate used. Give this or amountEgp.',
    ),
  rateToEgp: z
    .number()
    .optional()
    .describe(
      "EGP per unit of his currency that day. Leave out to use today's rate from the exchange-rate page — the preview says so; use the partner's figure if he gives one. At most four decimals.",
    ),
  order: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Only when he is owed on more than one order: which purchase order (its reference) this repayment is for.',
    ),
  paidOn: dayField('The day he was paid'),
  note: z.string().trim().max(500).optional(),
};

type FinancingInput = {
  lender: string;
  newLender?: boolean;
  phone?: string;
  order: string;
  amount: number;
  currency?: string;
  fxRateToEgp?: number;
  paidOn?: string;
  note?: string;
};

type RepaymentInput = {
  lender: string;
  amountEgp?: number;
  payOff?: boolean;
  rateToEgp?: number;
  order?: string;
  paidOn?: string;
  note?: string;
};

type View = Awaited<ReturnType<LendersService['findOne']>>['data'];
type FinancingView = View['financings'][number];

// ─── The tools ───────────────────────────────────────────────────────────

export function registerLenderTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const prisma = () => ctx.resolve(PrismaService);
  const lenders = () => ctx.resolve(LendersService);

  /** The office endpoints' roles (CLAUDE.md §12), not a list of its own. */
  function assertRole(roles: readonly string[]) {
    if (!roles.includes(ctx.user.role)) {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Your role does not allow this action.',
        { role: ctx.user.role },
      );
    }
  }

  async function allLenders(): Promise<Named[]> {
    const rows = await prisma().lender.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return rows;
  }

  /** One friend's financing, as get_lender and the repayment show it. */
  function financingFacts(f: FinancingView) {
    return {
      financingId: f.id,
      order: f.purchaseOrder.reference,
      cycle: f.cycle.code,
      cycleStatus: f.cycle.status,
      currency: f.currency,
      paid: f.amount,
      paidOn: f.paidOn,
      rateToEgp: f.fxRateToEgp,
      paidEgp: f.amountEgp,
      repaid: f.repaid,
      owed: f.owed,
      poundsPaid: f.paidEgp,
      exchangeDifferenceEgp: f.exchangeDiffEgp,
      removed: f.removedAt !== null,
      repayments: f.repayments.map((r) => ({
        paidOn: r.paidOn,
        poundsPaid: r.amountEgp,
        rateToEgp: r.rateToEgp,
        cleared: r.cleared,
        exchangeDifferenceEgp: r.exchangeDiffEgp,
        reversed: r.reversedAt !== null,
      })),
      plan: f.plan
        ? {
            agreedOn: f.plan.agreedOn,
            total: f.plan.total,
            paid: f.plan.paid,
            remaining: f.plan.remaining,
            overdue: f.plan.overdue,
            instalments: f.plan.instalments.map((i) => ({
              dueOn: i.dueOn,
              amount: i.amount,
              outstanding: i.outstanding,
              state: i.state,
            })),
          }
        : null,
    };
  }

  function overdueOf(f: FinancingView) {
    return (f.plan?.instalments ?? [])
      .filter((i) => i.state === 'OVERDUE')
      .map((i) => ({
        order: f.purchaseOrder.reference,
        currency: f.currency,
        dueOn: i.dueOn,
        amount: i.amount,
        outstanding: i.outstanding,
      }));
  }

  // ── list_lenders ──────────────────────────────────────────────────────

  readTool(
    server,
    'list_lenders',
    {
      title: 'List friends we owe',
      description:
        'Friends (lenders) who paid a supplier for us and are still owed. Per friend: what we owe him in each currency (his money is owed in the currency he paid, e.g. AED), the same in pounds at today\'s rate from the exchange-rate page (null when that currency has no rate), and any repayment-plan instalments that are overdue. Use it for "who do we owe", "how much do we owe Mahmoud", "is any friend late".',
      inputSchema: {
        overdueOnly: z
          .boolean()
          .optional()
          .describe('Only friends with an overdue instalment.'),
      },
    },
    async ({ overdueOnly }) => {
      assertRole(LENDER_READ_ROLES);
      const service = lenders();
      const { data: all } = await service.list();
      const rows = [];
      for (const l of all) {
        if (l.owed.length === 0 && !l.overdue) continue;
        if (overdueOnly && !l.overdue) continue;
        const { data: one } = await service.findOne(l.id);
        const owed = await inPoundsToday(prisma(), l.owed);
        rows.push({
          lenderId: l.id,
          name: l.name,
          phone: l.phone,
          owed: owed.lines,
          owedEgpToday: owed.missingRate ? null : owed.totalEgp,
          missingRate: owed.missingRate,
          overdueInstalments: one.financings
            .filter((f) => f.removedAt === null)
            .flatMap(overdueOf),
        });
      }
      const late = rows.filter((r) => r.overdueInstalments.length > 0).length;
      return answer(
        rows.length === 0
          ? overdueOnly
            ? 'No friend has an overdue instalment.'
            : 'We owe no friend anything.'
          : `${rows.length} friend(s) are owed money${late ? `; ${late} with an overdue instalment` : ''}. Pounds are at today's rate.`,
        rows,
      );
    },
  );

  // ── get_lender ────────────────────────────────────────────────────────

  readTool(
    server,
    'get_lender',
    {
      title: 'Get a friend we owe',
      description:
        "One friend (lender) by name or id: every order he paid for (which order, which cycle, how much, in which currency and at the rate on the day he paid), every repayment (pounds, the rate that day, what it cleared in his currency, the exchange difference, whether it was reversed), his repayment plan, and what is still owed — in his currency and in pounds at today's rate. When the name is close to more than one friend, or not exact, returns the candidates instead; ask the partner which one.",
      inputSchema: { lender: lenderField },
    },
    async ({ lender }) => {
      assertRole(LENDER_READ_ROLES);
      const found = resolveLender(lender, await allLenders(), false);
      if (found.status === 'questions') {
        const q = found.questions[0];
        if (q.id === 'LENDER_UNKNOWN') throw notFound('lender');
        const candidates = q.options.map((o) => ({
          id: o.value,
          name: o.label,
        }));
        return answer(
          `"${lender}" is not an exact match. Ask the partner which friend, then call get_lender with his id.`,
          { candidates },
        );
      }
      const { data: v } = await lenders().findOne(found.lender.id);
      const owed = await inPoundsToday(prisma(), v.owed);
      const data = {
        lenderId: v.id,
        name: v.name,
        phone: v.phone,
        owed: owed.lines,
        owedEgpToday: owed.missingRate ? null : owed.totalEgp,
        missingRate: owed.missingRate,
        financings: v.financings.map(financingFacts),
      };
      const said = owed.lines.length
        ? owed.lines
            .map(
              (l) =>
                `${formatMoney(l.owed)} ${l.currency}` +
                (l.owedEgp ? ` (${formatMoney(l.owedEgp)} EGP today)` : ''),
            )
            .join(', ')
        : 'nothing';
      return answer(`We owe ${v.name} ${said}.`, data);
    },
  );

  // ── record_lender_financing ───────────────────────────────────────────

  type FinancingPlan =
    | { status: 'questions'; questions: LenderQuestion[] }
    | {
        status: 'ready';
        lender: { id: string | null; name: string };
        order: {
          id: string;
          reference: string;
          currency: string;
          cycleId: string;
        };
        /** Where the rate came from, said in the preview. */
        rateFrom: 'given' | 'order' | 'today' | 'base' | 'none';
        body: {
          amount: number;
          paidOn: string;
          currency?: string;
          fxRateToEgp?: number;
          note?: string;
        };
      };

  async function planFinancing(input: FinancingInput): Promise<FinancingPlan> {
    assertRole(LENDER_WRITE_ROLES);
    if (!(input.amount > 0)) {
      throw badRequest(
        'AMOUNT_NOT_POSITIVE',
        'The amount must be greater than zero.',
      );
    }
    if (!places(input.amount, 2)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'An amount is money: at most two decimals.',
        { fields: 'amount' },
      );
    }
    if (input.paidOn) assertDayRange(input.paidOn);

    const ref = input.order.trim();
    const order = await prisma().purchaseOrder.findFirst({
      where: {
        OR: [
          { reference: { equals: ref, mode: 'insensitive' } },
          ...(/^[0-9a-f-]{36}$/i.test(ref) ? [{ id: ref }] : []),
        ],
      },
      select: { id: true, reference: true, currency: true, cycleId: true },
    });
    if (!order) throw notFound('purchaseOrder');

    // His currency and that day's rate (§18, 2026-10-16), the office form's
    // way: a rate said is used; unsaid, the order's own rate for the order's
    // currency, otherwise today's on the exchange-rate page — which the
    // preview names, so the partner can give the day's figure instead. A
    // currency with no rate on file is left to the service to refuse.
    const currency = input.currency ?? order.currency;
    let rate: number | undefined = input.fxRateToEgp;
    let rateFrom: 'given' | 'order' | 'today' | 'base' | 'none' = 'given';
    if (rate === undefined) {
      if (currency === 'EGP') rateFrom = 'base';
      else if (currency === order.currency) rateFrom = 'order';
      else {
        const today = (await ratesToday(prisma(), [currency])).get(currency);
        if (today) {
          rate = Number(today.toFixed(4));
          rateFrom = 'today';
        } else rateFrom = 'none';
      }
    }

    const found = resolveLender(input.lender, await allLenders(), true);
    let lender: { id: string | null; name: string };
    if (found.status === 'matched') {
      lender = found.lender;
    } else if (input.newLender) {
      lender = { id: null, name: input.lender.trim() };
    } else {
      return found;
    }

    return {
      status: 'ready',
      lender,
      order,
      rateFrom,
      body: {
        amount: input.amount,
        paidOn: input.paidOn ?? businessToday(),
        ...(input.currency ? { currency } : {}),
        ...(rate !== undefined ? { fxRateToEgp: rate } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    };
  }

  /** The order's financing after this one, and what partners are asked for. */
  async function financingOutcome(
    db: PrismaService,
    service: LendersService,
    p: Extract<FinancingPlan, { status: 'ready' }>,
    lenderId: string,
  ) {
    const costing = new CostingService(db);
    const before = await costing.fundingFor(p.order.cycleId);
    // The cap is the cycle's cost still unpaid by friends (§18, 2026-10-16):
    // what it was before this payment, as the office form shows it.
    const { data: room } = await service.forOrder(p.order.id);
    const { data: made } = await service.finance(
      p.order.id,
      { lenderId, ...p.body },
      actor,
    );
    const after = await costing.fundingFor(p.order.cycleId);
    const { data: onOrder } = await service.forOrder(p.order.id);
    return {
      financingId: made.id,
      cycle: made.cycle.code,
      amount: made.amount,
      currency: made.currency,
      rateToEgp: made.fxRateToEgp,
      rateFrom: p.rateFrom,
      amountEgp: made.amountEgp,
      paidOn: made.paidOn,
      orderCurrency: onOrder.currency,
      orderTotal: onOrder.orderTotal,
      orderTotalEgp: onOrder.orderTotalEgp,
      orderFinancedEgp: onOrder.financedEgp,
      cycleCostEgp: room.cycleCostEgp,
      cycleGoodsEgp: room.cycleGoodsEgp,
      cycleShippingEgp: room.cycleShippingEgp,
      cycleExpensesEgp: room.cycleExpensesEgp,
      cycleFinancedBeforeEgp: room.cycleFinancedEgp,
      availableBeforeEgp: room.availableEgp,
      partnersFundBeforeEgp: before.toFund.toFixed(2),
      partnersFundAfterEgp: after.toFund.toFixed(2),
    };
  }

  type FinancingSeen = Awaited<ReturnType<typeof financingOutcome>>;

  /** How the preview names where the rate came from. */
  const RATE_FROM: Record<FinancingSeen['rateFrom'], string> = {
    given: ' (the rate given)',
    order:
      " (the order's own rate; give the rate on the day he paid if it differed)",
    today:
      " (today's rate on the exchange-rate page; give the rate on the day he paid if it differed)",
    base: '',
    none: '',
  };

  function describeFinancing(
    p: Extract<FinancingPlan, { status: 'ready' }>,
    seen: FinancingSeen,
  ) {
    return [
      `${p.lender.name} paid ${formatMoney(seen.amount)} ${seen.currency} of ${p.order.reference} (cycle ${seen.cycle}) on ${seen.paidOn}` +
        ` — ${formatMoney(seen.amountEgp)} EGP at ${seen.rateToEgp} EGP per ${seen.currency}${RATE_FROM[seen.rateFrom]}.`,
      ...(p.lender.id === null
        ? [
            `${p.lender.name} is not on file yet: he will be added as a new lender.`,
          ]
        : []),
      `Cycle ${seen.cycle} cost ${formatMoney(seen.cycleCostEgp)} EGP (goods ${formatMoney(seen.cycleGoodsEgp)}, shipping ${formatMoney(seen.cycleShippingEgp)}, expenses charged to it ${formatMoney(seen.cycleExpensesEgp)}); friends had already paid ${formatMoney(seen.cycleFinancedBeforeEgp)} EGP of it, so ${formatMoney(seen.availableBeforeEgp)} EGP was available.`,
      `Friends will have paid ${formatMoney(seen.orderFinancedEgp)} EGP through ${p.order.reference}, whose goods are ${formatMoney(seen.orderTotal)} ${seen.orderCurrency} (${formatMoney(seen.orderTotalEgp)} EGP at its rate).`,
      `We owe him ${formatMoney(seen.amount)} ${seen.currency}, repaid in pounds at each day's rate.`,
      `Partners fund ${formatMoney(seen.partnersFundBeforeEgp)} EGP of the cycle before this, ${formatMoney(seen.partnersFundAfterEgp)} EGP after.`,
    ].join('\n');
  }

  function financingData(
    p: Extract<FinancingPlan, { status: 'ready' }>,
    seen: FinancingSeen,
  ) {
    return {
      lender: {
        id: p.lender.id,
        name: p.lender.name,
        isNew: p.lender.id === null,
      },
      order: p.order.reference,
      ...seen,
    };
  }

  writeTool(
    server,
    ctx,
    'record_lender_financing',
    {
      title: 'Record what a friend paid a supplier',
      description:
        'A friend (lender) paid all or part of a purchase order for us — "Mahmoud paid 30,000 AED for PO-2026-0004". The amount is in the currency he paid in — not necessarily the order\'s — at the rate on the day he paid, and we then owe him that amount in that currency, repaid in pounds later. ' +
        'It is recorded against the order he paid, but it may cover more than the order\'s goods: the cycle\'s shipping legs and the expenses charged to the cycle in the ledger (a card or bank fee, customs) too — "he paid 8,302.60 AED by card: goods, shipping to the UAE and the card fee". Record the fee as a ledger expense on the cycle first, so the cycle\'s cost includes it. ' +
        'The friend is matched by exact name or id; a close or unknown name comes back as a question with nothing to confirm — a new friend is added only with newLender: true after the partner agreed. ' +
        'Refused when it is more than is left of the cycle\'s cost — goods, shipping and expenses charged to it, less what friends already paid (compared in pounds) — the currency has no rate on the exchange-rate page, the day is in the future, he already paid for that order, or the cycle is being settled, closed or cancelled. ' +
        'The preview shows the cycle\'s cost, what friends already paid of it, what is available, and what the partners will still have to fund afterwards. Call without a confirmationToken to preview.',
      inputSchema: financingShape,
    },
    {
      async preview(input) {
        const p = await planFinancing(input);
        if (p.status === 'questions') {
          return questionsSummary("friend's payment", p.questions);
        }
        const seen = await rehearse(prisma(), async (db) => {
          const lenderId =
            p.lender.id ??
            (
              await db.lender.create({
                data: {
                  name: p.lender.name,
                  phone: input.phone || null,
                  createdBy: actor,
                },
              })
            ).id;
          return financingOutcome(
            db,
            new LendersService(db, NO_AUDIT, NO_NOTIFY),
            p,
            lenderId,
          );
        });
        return {
          summary: describeFinancing(p, seen),
          data: financingData(p, seen),
        };
      },
      // What was agreed to: who, which order, how much and on which day, and
      // what it left the partners to fund. Another friend's payment, a new
      // line or a lender of that name appearing in between changes it.
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as ReturnType<typeof financingData>;
        return {
          lender: d.lender.id ?? `new:${d.lender.name}`,
          order: d.order,
          amount: d.amount,
          currency: d.currency,
          rate: d.rateToEgp,
          paidOn: d.paidOn,
          orderFinancedEgp: d.orderFinancedEgp,
          partnersFundAfterEgp: d.partnersFundAfterEgp,
        };
      },
      async commit(input) {
        const p = await planFinancing(input);
        // Unreachable after a bound preview, which already refused this.
        if (p.status === 'questions') {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        const service = lenders();
        const lenderId =
          p.lender.id ??
          (
            await service.create(
              { name: p.lender.name, phone: input.phone },
              actor,
            )
          ).data.id;
        const seen = await financingOutcome(prisma(), service, p, lenderId);
        const data = financingData(p, seen);
        return {
          summary: `Recorded. ${describeFinancing(p, seen)}`,
          data: { ...data, lender: { ...data.lender, id: lenderId } },
        };
      },
    },
  );

  // ── record_lender_repayment ───────────────────────────────────────────

  type RepaymentPlan =
    | { status: 'questions'; questions: LenderQuestion[] }
    | {
        status: 'ready';
        lender: Named;
        financing: FinancingView;
        rate: string;
        rateFrom: 'given' | 'today';
        body: {
          amountEgp: number;
          rateToEgp: number;
          paidOn: string;
          note?: string;
        };
        payOff: boolean;
      };

  async function planRepayment(input: RepaymentInput): Promise<RepaymentPlan> {
    assertRole(LENDER_WRITE_ROLES);
    if ((input.amountEgp === undefined) === (input.payOff !== true)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Give the pounds paid (amountEgp) or payOff, one of the two.',
        { fields: 'amountEgp, payOff' },
      );
    }
    if (input.amountEgp !== undefined && !places(input.amountEgp, 2)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'An amount is money: at most two decimals.',
        { fields: 'amountEgp' },
      );
    }
    if (input.rateToEgp !== undefined && !places(input.rateToEgp, 4)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'A rate has at most four decimals.',
        { fields: 'rateToEgp' },
      );
    }
    if (input.paidOn) assertDayRange(input.paidOn);

    const found = resolveLender(input.lender, await allLenders(), false);
    if (found.status === 'questions') return found;
    const lender = found.lender;
    const service = lenders();
    const { data: v } = await service.findOne(lender.id);
    const open = v.financings.filter(
      (f) => f.removedAt === null && D(f.owed).gt(0),
    );

    let financing: FinancingView | undefined;
    if (input.order) {
      const ref = input.order.trim().toLowerCase();
      financing = v.financings.find(
        (f) =>
          f.removedAt === null &&
          (f.id === input.order ||
            f.purchaseOrder.reference.toLowerCase() === ref),
      );
      if (!financing) throw notFound('lenderFinancing');
    } else if (open.length === 0) {
      throw badRequest(
        'LENDER_NOT_OWED',
        `${lender.name} is owed nothing, so there is nothing to repay.`,
        { lender: lender.name },
      );
    } else if (open.length > 1) {
      return {
        status: 'questions',
        questions: [
          {
            id: 'FINANCING_WHICH',
            kind: 'FINANCING_WHICH',
            text: `${lender.name} is owed on ${open.length} orders. Which one is this repayment for?`,
            options: open.map((f) => ({
              value: f.purchaseOrder.reference,
              label: `${f.purchaseOrder.reference} (cycle ${f.cycle.code}): ${formatMoney(f.owed)} ${f.currency} owed`,
            })),
          },
        ],
      };
    } else {
      financing = open[0];
    }

    const questions: LenderQuestion[] = [];

    let rate: string | null = null;
    let rateFrom: 'given' | 'today' = 'given';
    if (input.rateToEgp !== undefined) {
      rate = String(input.rateToEgp);
    } else {
      const today = (await ratesToday(prisma(), [financing.currency])).get(
        financing.currency,
      );
      if (today) {
        rate = today.toFixed(4);
        rateFrom = 'today';
      } else {
        questions.push({
          id: 'RATE_NEEDED',
          kind: 'RATE_NEEDED',
          text: `There is no rate for ${financing.currency} on the exchange-rate page. At what rate (EGP per ${financing.currency}) was he paid?`,
          options: [],
        });
      }
    }

    if (questions.length || rate === null) {
      return { status: 'questions', questions };
    }

    // "Pay him off": the service's own settling figure at this rate (§18).
    const amountEgp =
      input.payOff === true
        ? Number((await service.quote(financing.id, rate)).data.settlingEgp)
        : input.amountEgp!;

    return {
      status: 'ready',
      lender,
      financing,
      rate,
      rateFrom,
      payOff: input.payOff === true,
      body: {
        amountEgp,
        rateToEgp: Number(rate),
        paidOn: input.paidOn ?? businessToday(),
        ...(input.note ? { note: input.note } : {}),
      },
    };
  }

  interface RepaymentSeen {
    cleared: string;
    owedBefore: string;
    owedAfter: string;
    exchangeDiffEgp: string;
    clearedAtOrderRateEgp: string;
  }

  /** What the newest standing repayment on this financing did. */
  async function repaymentOutcome(
    db: Pick<PrismaService, 'lenderFinancing'>,
    financingId: string,
    before: Set<string>,
    owedBefore: string,
  ): Promise<RepaymentSeen> {
    const f = await db.lenderFinancing.findUniqueOrThrow({
      where: { id: financingId },
      include: { repayments: { where: { reversedAt: null } } },
    });
    const made = f.repayments.find((r) => !before.has(r.id));
    if (!made) throw new Error('repayment not found after it was made');
    const owed = f.repayments.reduce((s, r) => s.sub(r.cleared), D(f.amount));
    return {
      cleared: m2(made.cleared),
      owedBefore,
      owedAfter: m2(owed),
      exchangeDiffEgp: m2(made.exchangeDiffEgp),
      clearedAtOrderRateEgp: m2(made.clearedAtOrderRateEgp),
    };
  }

  function describeRepayment(
    p: Extract<RepaymentPlan, { status: 'ready' }>,
    seen: RepaymentSeen,
  ) {
    const f = p.financing;
    const diff = D(seen.exchangeDiffEgp);
    return [
      `Repay ${p.lender.name} ${formatMoney(p.body.amountEgp)} EGP on ${p.body.paidOn}` +
        (p.payOff ? ' — the exact figure that pays him off.' : '.'),
      p.rateFrom === 'today'
        ? `Rate ${p.rate} EGP per ${f.currency}: today's rate on the exchange-rate page. If he was paid at another rate, give it and preview again.`
        : `Rate ${p.rate} EGP per ${f.currency}, as given.`,
      `Clears ${formatMoney(seen.cleared)} ${f.currency} of ${f.purchaseOrder.reference} (cycle ${f.cycle.code}).`,
      `Still owed: ${formatMoney(seen.owedBefore)} ${f.currency} before, ${formatMoney(seen.owedAfter)} ${f.currency} after.`,
      diff.isZero()
        ? 'No exchange difference: the same as the rate he paid at.'
        : `Exchange difference: ${diff.gt(0) ? '' : '-'}${formatMoney(diff.abs())} EGP — ${diff.gt(0) ? 'a cost to the cycle (his currency rose since he paid)' : 'a gain to the cycle (his currency fell since he paid)'}.`,
    ].join('\n');
  }

  function repaymentData(
    p: Extract<RepaymentPlan, { status: 'ready' }>,
    seen: RepaymentSeen,
  ) {
    return {
      lender: { id: p.lender.id, name: p.lender.name },
      financingId: p.financing.id,
      order: p.financing.purchaseOrder.reference,
      cycle: p.financing.cycle.code,
      currency: p.financing.currency,
      amountEgp: m2(p.body.amountEgp),
      rateToEgp: D(p.rate).toFixed(4),
      rateFrom: p.rateFrom,
      payOff: p.payOff,
      paidOn: p.body.paidOn,
      ...seen,
    };
  }

  writeTool(
    server,
    ctx,
    'record_lender_repayment',
    {
      title: 'Record a repayment to a friend',
      description:
        'We paid a friend (lender) back in pounds — "paid Mahmoud 50,000 pounds today", or "pay him off". It clears pounds ÷ that day\'s rate of what we owe him in his currency. ' +
        "The rate defaults to today's rate on the exchange-rate page (the preview says so); use the partner's rate when he gives one. payOff uses the exact pounds that settle the debt at that rate. " +
        'The friend is matched by exact name or id; a close or unknown name, or which order when he is owed on several, comes back as a question with nothing to confirm. ' +
        'Refused when it is more than is owed, dated in the future or before he paid, or nothing is owed (a cycle settles only once its friends are repaid). ' +
        'The preview shows what it clears, what is still owed after and the exchange difference. Call without a confirmationToken to preview.',
      inputSchema: repaymentShape,
    },
    {
      async preview(input) {
        const p = await planRepayment(input);
        if (p.status === 'questions') {
          return questionsSummary('repayment', p.questions);
        }
        const before = new Set(
          p.financing.repayments
            .filter((r) => r.reversedAt === null)
            .map((r) => r.id),
        );
        const dry = rollingBack(prisma(), (tx) =>
          repaymentOutcome(tx, p.financing.id, before, p.financing.owed),
        );
        const service = new LendersService(dry, NO_AUDIT, NO_NOTIFY);
        const seen = await previewByRollback<RepaymentSeen>(() =>
          service.repay(p.financing.id, p.body, actor),
        );
        return {
          summary: describeRepayment(p, seen),
          data: repaymentData(p, seen),
        };
      },
      // What was agreed to: whom, which order, the pounds, the rate and the
      // day, and what it cleared and left owed. A repayment
      // in between changes the last two and is refused.
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as ReturnType<typeof repaymentData>;
        return {
          financingId: d.financingId,
          amountEgp: d.amountEgp,
          rateToEgp: d.rateToEgp,
          paidOn: d.paidOn,
          cleared: d.cleared,
          owedBefore: d.owedBefore,
          owedAfter: d.owedAfter,
        };
      },
      async commit(input) {
        const p = await planRepayment(input);
        if (p.status === 'questions') {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        const before = new Set(
          p.financing.repayments
            .filter((r) => r.reversedAt === null)
            .map((r) => r.id),
        );
        await lenders().repay(p.financing.id, p.body, actor);
        const seen = await repaymentOutcome(
          prisma(),
          p.financing.id,
          before,
          p.financing.owed,
        );
        return {
          summary: `Recorded. ${describeRepayment(p, seen)}`,
          data: repaymentData(p, seen),
        };
      },
    },
  );
}
