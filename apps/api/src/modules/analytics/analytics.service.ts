import { Injectable } from '@nestjs/common';
import { stockValueEgp } from '../../common/stock-value';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type CycleStatus } from '@prisma/client';
import {
  COST_RECOVERY_CATEGORIES,
  NOT_OPERATING_EXPENSE,
  OTHER_INCOME_CATEGORIES,
  isCostRecoveryCategory,
  isLenderCategory,
  netOperatingExpenseEgp,
  netOtherIncomeEgp,
  netRecoveredEgp,
  operatingExpenseEgp,
  otherIncomeEgp,
  recoveredEgp,
  TRANSFER_CATEGORY,
  transferNetEgp,
} from '../../common/ledger-categories';
import { cashPosition } from '../../common/cash-position';
import {
  standingEntriesWhere,
  undoneEntryIds,
} from '../../common/undone-entries';
import { CLOSED_CYCLE_STATUSES } from '../../common/manual-ledger-categories';
import {
  cycleWriteOffsEgp,
  samplesWrittenOffWhere,
  shipmentLossWhere,
} from '../../common/cycle-losses';
import { cycleUnitsAtShops } from '../../common/samples-out';
import { SAMPLES_WRITTEN_OFF_CATEGORY } from '../../common/samples';
import {
  exchangeDifferenceEgp,
  exchangeDifferenceWhere,
} from '../../common/lender-debt';
import {
  bucketIndexOf,
  granularityOf,
  periodBuckets,
  type Granularity,
} from '../../common/period-buckets';
import { owedToLenders } from '../../common/lenders-owed';
import { countLowStock } from '../../common/low-stock';
import {
  businessMonthBuckets,
  businessMonthOf,
} from '../../common/month-buckets';
import {
  assertDayRange,
  businessDay,
  businessToday,
  calendarRange,
  instantRange,
} from '../../common/dates';
import { badRequest } from '../../common/api-error';
import { cyclesVisibleTo, type ScopeViewer } from '../../common/investor-scope';
// Realised sales and units sold are defined once, beside the product page's
// Units sold card that reads them too (CLAUDE.md §11).
import {
  netUnitsSold,
  REALISED_SALE_STATUSES,
  SOLD_LINE_WHERE,
  unitsFigure,
} from '../../common/units-sold';

/** A cycle still running: anything but closed or cancelled (CLOSED_CYCLE_STATUSES). */
export const ACTIVE_CYCLE_WHERE = {
  status: { notIn: [...CLOSED_CYCLE_STATUSES] as CycleStatus[] },
} satisfies Prisma.ImportCycleWhereInput;

/**
 * Units on the shelf: each batch's remaining quantity, summed — the same
 * "stock on hand" the low-stock rule counts (§3). The dashboard's Units in
 * stock and the Products and Inventory tabs' card read it.
 */
function unitsOnShelf(batches: { remainingQty: Prisma.Decimal.Value }[]) {
  return Number(
    batches
      .reduce((sum, b) => sum.add(b.remainingQty), new Prisma.Decimal(0))
      .toDecimalPlaces(2),
  );
}

/** How the top products are ranked. */
export const TOP_PRODUCTS_BY = ['revenue', 'units'] as const;
export type TopProductsBy = (typeof TOP_PRODUCTS_BY)[number];

/** A run of Cairo days, both ends included, either left open (YYYY-MM-DD). */
export interface DayPeriod {
  from?: string;
  to?: string;
}

/** What `profitFigures` answers, in EGP, unrounded. */
export interface ProfitFigures {
  revenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  /** Operating expenses, goods lost on the way included (§2, §9). */
  operatingExpenses: Prisma.Decimal;
  /** The part of operatingExpenses that is goods lost on the way. */
  losses: Prisma.Decimal;
  /**
   * The part of operatingExpenses that is samples the shops kept or lost
   * (§4, samples at shops, 2026-10-18), on the day they were written off.
   */
  samplesWrittenOff: Prisma.Decimal;
  recovered: Prisma.Decimal;
  otherIncome: Prisma.Decimal;
  exchangeDiff: Prisma.Decimal;
  netProfit: Prisma.Decimal;
}

/** The lines of profit a part adds to (`figuresOf`). */
export type ProfitLine =
  | 'revenue'
  | 'cogs'
  | 'operating'
  | 'losses'
  | 'samples'
  | 'recovered'
  | 'otherIncome'
  | 'exchangeDiff';

/**
 * One signed piece of a profit figure: a sale's total, a return's refund
 * (negative revenue), a ledger row as an expense, a loss… with the Cairo day
 * it belongs to, or no day when the database summed a whole source.
 */
export interface ProfitPart {
  line: ProfitLine;
  day: string | null;
  amount: Prisma.Decimal;
  /** A ledger row's category (expenses by category). */
  category?: string;
}

type LedgerRowLike = {
  direction: string;
  category: string;
  amount: Prisma.Decimal.Value;
  reversalOfId?: string | null;
};

/** A date column's day: Postgres hands it back as UTC midnight of the day. */
const dateColumnDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Profit from its parts — the one formula (§9): revenue less cost of goods,
 * less expenses (goods lost and samples written off included), plus money
 * recovered and other income, less the exchange difference. Every step is a
 * sum, so the figures of a period's buckets add up to the period's.
 */
export function figuresOf(parts: readonly ProfitPart[]): ProfitFigures {
  const zero = () => new Prisma.Decimal(0);
  const sum: Record<ProfitLine, Prisma.Decimal> = {
    revenue: zero(),
    cogs: zero(),
    operating: zero(),
    losses: zero(),
    samples: zero(),
    recovered: zero(),
    otherIncome: zero(),
    exchangeDiff: zero(),
  };
  for (const p of parts) sum[p.line] = sum[p.line].add(p.amount);
  const operatingExpenses = sum.operating.add(sum.losses).add(sum.samples);
  return {
    revenue: sum.revenue,
    cogs: sum.cogs,
    operatingExpenses,
    losses: sum.losses,
    samplesWrittenOff: sum.samples,
    recovered: sum.recovered,
    otherIncome: sum.otherIncome,
    exchangeDiff: sum.exchangeDiff,
    netProfit: sum.revenue
      .sub(sum.cogs)
      .sub(operatingExpenses)
      .add(sum.recovered)
      .add(sum.otherIncome)
      .sub(sum.exchangeDiff),
  };
}

/**
 * Goods lost on the way, as a line among Analytics' expenses by category: an
 * expense with no ledger row (§2, §9), so not a ledger category — the web
 * names it itself.
 */
export const LOSSES_CATEGORY = 'goods_lost';

/**
 * A ledger row's day, as a filter: the day the money moved (`occurredOn`), or
 * for a row with none — written before the column, or by a flow — the Cairo
 * day it was entered. The same reading running costs use (§8, §9).
 */
export function ledgerDayWhere(
  period?: DayPeriod,
): Prisma.FinancialTransactionWhereInput {
  const onDays = period ? calendarRange(period.from, period.to) : undefined;
  if (!period || !onDays) return {};
  return {
    OR: [
      { occurredOn: onDays },
      { occurredOn: null, createdAt: instantRange(period.from, period.to) },
    ],
  };
}

/**
 * The ledger rows the Expenses line sums for one direction: money out in any
 * category that is not capitalised, recovered, income or a sale, and the
 * reversals of those coming back in (§9, L6). One definition for the total
 * and for the split by category, so the split always adds up to the total.
 */
export function expenseWhere(
  direction: 'INFLOW' | 'OUTFLOW',
  period?: DayPeriod,
): Prisma.FinancialTransactionWhereInput {
  return {
    direction,
    category: { notIn: [...NOT_OPERATING_EXPENSE] },
    ...(direction === 'INFLOW' ? { reversalOfId: { not: null } } : {}),
    ...ledgerDayWhere(period),
  };
}

/**
 * "This month" as Analytics' profit and loss reads it (web `periodParams`
 * 'month': the 1st to the month's last day, capped by the API at today): the
 * Cairo calendar month `now` falls in, from its 1st to today. The dashboard's
 * This month group asks `profitFigures` for exactly these days, so its figures
 * are P&L's This month to the piastre (owner 2026-10-23, rule 11).
 */
export function thisMonthPeriod(now = new Date()): Required<DayPeriod> {
  const today = businessToday(now);
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** A day from a query string: '' or absent is none; anything else is checked by assertDayRange. */
function dayParam(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    const shown = JSON.stringify(value) ?? typeof value;
    throw badRequest('BAD_DATE', `${shown} is not a date written YYYY-MM-DD.`, {
      value: shown,
    });
  }
  return value;
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Revenue, cost of goods sold, expenses and net profit — the one
   * computation behind the dashboard's figures and Analytics' profit and loss
   * (CLAUDE.md rule 11, owner 2026-10-18). With no period it is the
   * dashboard's all-time reading, query for query; with one, every figure is
   * cut to its own day (BUSINESS_LOGIC §9, "Profit and loss"). Which day each
   * kind of record belongs to is `profitParts`'s, below.
   *
   * Never a second formula: a period that needs a figure the dashboard does
   * not count is a change here, read by both.
   */
  async profitFigures(period?: DayPeriod): Promise<ProfitFigures> {
    return figuresOf(await this.profitParts(period, false));
  }

  /**
   * What every profit figure is made of, as signed parts (`figuresOf` adds
   * them up). Each part is put on its own Cairo day:
   *
   * - a sale, and the cost of what it sold, on the sale's day (`orderedAt`);
   * - a return, and the cost it reversed, on the day it came back
   *   (`returnedOn`), as Revenue by month read it;
   * - a ledger row on the day the money moved (`occurredOn`, else the Cairo
   *   day it was entered);
   * - goods lost on the day they were marked lost; samples written off on the
   *   day the write-off was recorded;
   * - an exchange difference on the day of the repayment (`paidOn`).
   *
   * `itemised` false is the dashboard's reading: the database sums each
   * source, one part per source with no day. True reads the very same rows —
   * the same filters, the same per-row rules (`operatingExpenseEgp` and its
   * siblings) — one part per row with its day, so Analytics can cut a period
   * into days, weeks or months in memory and the buckets add up to the totals
   * by construction (owner 2026-10-18, "Option A"). Either way it is thirteen
   * queries, however many buckets: asking `profitFigures` once per bucket
   * cost twelve per bucket, 372 for a month drawn by day.
   */
  private async profitParts(
    period: DayPeriod | undefined,
    itemised: boolean,
  ): Promise<ProfitPart[]> {
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const parts: ProfitPart[] = [];
    const add = (
      line: ProfitLine,
      day: string | null,
      amount: unknown,
      category?: string,
    ) => parts.push({ line, day, amount: D(amount), category });

    const REALISED = REALISED_SALE_STATUSES;
    const instants = period ? instantRange(period.from, period.to) : undefined;
    const days = period ? calendarRange(period.from, period.to) : undefined;

    const saleWhere = {
      status: { in: [...REALISED] },
      ...(instants ? { orderedAt: instants } : {}),
    } satisfies Prisma.SaleOrderWhereInput;
    if (itemised) {
      for (const o of await this.prisma.saleOrder.findMany({
        where: saleWhere,
        select: { orderedAt: true, total: true },
      })) {
        add('revenue', businessDay(o.orderedAt), o.total);
      }
    } else {
      const { _sum } = await this.prisma.saleOrder.aggregate({
        where: saleWhere,
        _sum: { total: true },
      });
      add('revenue', null, _sum.total);
    }

    // Less what came back. Netting returns off cycle profitability but not
    // here left the dashboard and the cycle comparison disagreeing about the
    // same sales. Damaged goods reverse no cost, so cogsReversedEgp is zero
    // for those and their cost correctly stays spent.
    const returnWhere = {
      saleOrder: { status: { in: [...REALISED] } },
      ...(days ? { returnedOn: days } : {}),
    } satisfies Prisma.SaleReturnWhereInput;
    if (itemised) {
      for (const r of await this.prisma.saleReturn.findMany({
        where: returnWhere,
        select: { returnedOn: true, refundEgp: true, cogsReversedEgp: true },
      })) {
        const day = dateColumnDay(r.returnedOn);
        add('revenue', day, D(r.refundEgp).neg());
        add('cogs', day, D(r.cogsReversedEgp).neg());
      }
    } else {
      const { _sum } = await this.prisma.saleReturn.aggregate({
        where: returnWhere,
        _sum: { refundEgp: true, cogsReversedEgp: true },
      });
      add('revenue', null, D(_sum.refundEgp).neg());
      add('cogs', null, D(_sum.cogsReversedEgp).neg());
    }

    // Less prices lowered after the sale (§4, 2026-10-22), on the day they
    // were lowered — a report already looked at does not change. No cost moves.
    const adjustmentWhere = {
      saleOrder: { status: { in: [...REALISED] } },
      ...(days ? { adjustedOn: days } : {}),
    } satisfies Prisma.SalePriceAdjustmentWhereInput;
    if (itemised) {
      for (const a of await this.prisma.salePriceAdjustment.findMany({
        where: adjustmentWhere,
        select: { adjustedOn: true, amountEgp: true },
      })) {
        add('revenue', dateColumnDay(a.adjustedOn), D(a.amountEgp).neg());
      }
    } else {
      const { _sum } = await this.prisma.salePriceAdjustment.aggregate({
        where: adjustmentWhere,
        _sum: { amountEgp: true },
      });
      add('revenue', null, D(_sum.amountEgp).neg());
    }

    // Cost of the units actually sold, taken from the batch allocation made at
    // the time of sale, so historical costs are never re-priced.
    const cogsWhere = {
      saleItem: { saleOrder: saleWhere },
    } satisfies Prisma.SaleItemAllocationWhereInput;
    if (itemised) {
      for (const a of await this.prisma.saleItemAllocation.findMany({
        where: cogsWhere,
        select: {
          cogsEgp: true,
          saleItem: { select: { saleOrder: { select: { orderedAt: true } } } },
        },
      })) {
        add('cogs', businessDay(a.saleItem.saleOrder.orderedAt), a.cogsEgp);
      }
    } else {
      const { _sum } = await this.prisma.saleItemAllocation.aggregate({
        where: cogsWhere,
        _sum: { cogsEgp: true },
      });
      add('cogs', null, _sum.cogsEgp);
    }

    // The ledger, through the one signed reading per row that settlement
    // uses too (L6, rule 11). Summed, the database's total stands in for the
    // rows, carrying what the reading needs to know about them.
    //
    // An entry undone and its undo are left out of every line, whichever
    // periods they fall in — the rule cash in and cash out already applied
    // (`common/undone-entries.ts`, owner 2026-10-26). Netting them instead
    // put a July fee undone in October at −3,338.82 in October's Expenses
    // while July kept it. Over all time the pair nets to zero, so the
    // dashboard's all-time figures read the same either way.
    const standing = standingEntriesWhere(await undoneEntryIds(this.prisma));
    const ledger = async (
      line: ProfitLine,
      within: Prisma.FinancialTransactionWhereInput,
      read: (t: LedgerRowLike) => Prisma.Decimal,
      summedAs: Omit<LedgerRowLike, 'amount'>,
    ) => {
      const where = { ...within, ...standing };
      if (itemised) {
        for (const t of await this.prisma.financialTransaction.findMany({
          where,
          select: {
            direction: true,
            category: true,
            amount: true,
            reversalOfId: true,
            occurredOn: true,
            createdAt: true,
          },
        })) {
          const day = t.occurredOn
            ? dateColumnDay(t.occurredOn)
            : businessDay(t.createdAt);
          add(line, day, read(t), t.category);
        }
      } else {
        const { _sum } = await this.prisma.financialTransaction.aggregate({
          where,
          _sum: { amount: true },
        });
        add(line, null, read({ ...summedAs, amount: D(_sum.amount) }));
      }
    };

    // Buying stock is not an expense -- it converts cash into inventory, and
    // becomes a cost only when the goods sell. Goods and shipping are already
    // capitalised into batch landed cost, so only other outflows are expenses.
    // Settlement payouts distribute profit already earned; counting them as
    // expenses would subtract the same money twice. Recoveries, and an undone
    // refund's OUTFLOW, are netted in `recovered` below rather than charged as
    // an expense (B5b); other income in `otherIncome` (L6). Read as the
    // outflows and the reversals' inflows: until L6 a reversed expense stayed
    // in Expenses for good.
    await ledger(
      'operating',
      expenseWhere('OUTFLOW', period),
      operatingExpenseEgp,
      { direction: 'OUTFLOW', category: '', reversalOfId: null },
    );
    await ledger(
      'operating',
      expenseWhere('INFLOW', period),
      operatingExpenseEgp,
      { direction: 'INFLOW', category: '', reversalOfId: 'reversal' },
    );

    // Other income (L6): raises net profit, is not Revenue, and is shown on
    // its own like recoveries — net of any undone.
    for (const direction of ['INFLOW', 'OUTFLOW'] as const) {
      await ledger(
        'otherIncome',
        {
          direction,
          category: { in: [...OTHER_INCOME_CATEGORIES] },
          ...ledgerDayWhere(period),
        },
        otherIncomeEgp,
        { direction, category: OTHER_INCOME_CATEGORIES[0] },
      );
    }

    // Money recovered (supplier and loss refunds) raises net profit, as it
    // does in settlement and the cycle profitability (§6, rule 11). Shown on
    // its own rather than netted into Expenses, which would read negative on
    // a refund-heavy month. Net of undone refunds (B5b).
    for (const direction of ['INFLOW', 'OUTFLOW'] as const) {
      await ledger(
        'recovered',
        {
          direction,
          category: { in: [...COST_RECOVERY_CATEGORIES] },
          ...ledgerDayWhere(period),
        },
        recoveredEgp,
        { direction, category: COST_RECOVERY_CATEGORIES[0] },
      );
    }

    // Goods lost on the way and samples written off are expenses with no
    // ledger row (§2, §4, §9): the same figures settlement subtracts, through
    // the one definition (common/cycle-losses.ts, rule 11).
    if (itemised) {
      for (const l of await this.prisma.shipmentLoss.findMany({
        where: shipmentLossWhere(null, instants),
        select: { createdAt: true, costEgp: true },
      })) {
        add('losses', businessDay(l.createdAt), l.costEgp);
      }
      for (const a of await this.prisma.saleItemAllocation.findMany({
        where: samplesWrittenOffWhere(null, instants),
        select: {
          cogsEgp: true,
          saleItem: {
            select: {
              saleOrder: {
                select: { samplesDecidedAt: true, orderedAt: true },
              },
            },
          },
        },
      })) {
        // Every write-off records its moment; an order without one (none
        // should exist) falls on the day it was ordered rather than nowhere.
        const o = a.saleItem.saleOrder;
        add(
          'samples',
          businessDay(o.samplesDecidedAt ?? o.orderedAt),
          a.cogsEgp,
        );
      }
    } else {
      const writeOffs = await cycleWriteOffsEgp(this.prisma, null, instants);
      add('losses', null, writeOffs.lostOnTheWay);
      add('samples', null, writeOffs.samplesWrittenOff);
    }

    // Repaying friends at a moved rate (§18): a cost or a gain of the cycles,
    // not an operating expense — shown on its own, and taken off net profit
    // through the one definition settlement reads (rule 11).
    if (itemised) {
      for (const r of await this.prisma.lenderRepayment.findMany({
        where: exchangeDifferenceWhere(null, days),
        select: { paidOn: true, exchangeDiffEgp: true },
      })) {
        add('exchangeDiff', dateColumnDay(r.paidOn), r.exchangeDiffEgp);
      }
    } else {
      add(
        'exchangeDiff',
        null,
        await exchangeDifferenceEgp(this.prisma, null, days),
      );
    }

    return parts;
  }

  /**
   * Analytics' profit and loss for a run of days (owner 2026-10-18: "a proper
   * place to see total net profit, with time, and with expenses and sales as
   * summary, not details"). Every total is the dashboard's own computation
   * for the period (`profitParts` → `figuresOf`); the expenses by category
   * split the same parts the Expenses line sums, and each bucket of the chart
   * is the same parts that fall on its days — so the categories add up to
   * Expenses and the buckets to every total, to the piastre.
   *
   * The buckets are days, Saturday–Friday weeks or months by the length of
   * the period (`common/period-buckets.ts`), every one present, quiet ones as
   * zeros.
   *
   * `from` and `to` are Cairo days, both included, either left out. Left out
   * altogether it is all time: the totals are then the dashboard's exactly,
   * and the buckets run from the first day anything was recorded. A `to`
   * after today is today (the days after hold nothing yet); a `from` after
   * today, a reversed range or a malformed day is refused, never answered
   * with zeros that look like a quiet period.
   */
  async getProfitAndLoss(fromIn?: unknown, toIn?: unknown, now = new Date()) {
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));
    const pctOf = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
      whole.gt(0) ? Number(part.div(whole).mul(100).toDecimalPlaces(1)) : null;
    const from = dayParam(fromIn);
    const toAsked = dayParam(toIn);
    assertDayRange(from, toAsked);
    const today = businessToday(now);
    if (from && from > today) {
      throw badRequest(
        'PERIOD_NOT_STARTED',
        `The period starts on ${from}, which has not come yet.`,
        { from },
      );
    }
    const to = !toAsked || toAsked > today ? today : toAsked;
    const allTime = !from && !toAsked;

    // All time is the dashboard's reading itself, with no date at all — a
    // row dated forward (check-data 25) still counts there, so it does here.
    const period: DayPeriod | undefined = allTime ? undefined : { from, to };
    const parts = await this.profitParts(period, true);
    const figures = figuresOf(parts);

    // Where the buckets start: the period's first day, or for all time (and
    // an open start) the first day anything was recorded. They end on `to`,
    // or — all time only — on a row dated after today, so that row's bucket
    // exists and the buckets still add up to the totals that count it.
    const recorded = parts
      .map((p) => p.day)
      .filter((d): d is string => d !== null)
      .sort();
    const start = from ?? recorded[0] ?? null;
    const last = recorded[recorded.length - 1];
    const end = last && last > to ? last : to;
    const granularity: Granularity = start
      ? granularityOf(start, end)
      : 'month';
    const buckets = start ? periodBuckets(start, end, granularity) : [];
    const inBucket = buckets.map(() => [] as ProfitPart[]);
    for (const p of parts) {
      const i = p.day === null ? -1 : bucketIndexOf(buckets, p.day);
      if (i < 0) {
        // Every part was read with the period's own filters, so it lies in
        // it; one outside would mean a filter and a day reading disagree.
        throw new Error(
          `A ${p.line} figure on ${p.day} is outside ${start}…${end}.`,
        );
      }
      inBucket[i].push(p);
    }

    // Each category's net expense: its outflows less the reversals of them,
    // through the same signed reading as the Expenses line.
    const byCategory = new Map<string, Prisma.Decimal>();
    for (const p of parts) {
      if (p.line !== 'operating') continue;
      const c = p.category ?? '';
      byCategory.set(
        c,
        (byCategory.get(c) ?? new Prisma.Decimal(0)).add(p.amount),
      );
    }
    // Goods lost on the way are in Expenses with no ledger row (§2, §9).
    if (!figures.losses.isZero()) {
      byCategory.set(LOSSES_CATEGORY, figures.losses);
    }
    // Samples written off: its own line, "Samples written off" (§4).
    if (!figures.samplesWrittenOff.isZero()) {
      byCategory.set(SAMPLES_WRITTEN_OFF_CATEGORY, figures.samplesWrittenOff);
    }
    const expensesByCategory = [...byCategory.entries()]
      .filter(([, amount]) => !amount.isZero())
      .map(([category, amount]) => ({ category, amountEgp: money(amount) }))
      .sort(
        (a, b) =>
          b.amountEgp - a.amountEgp || a.category.localeCompare(b.category),
      );

    const grossProfit = figures.revenue.sub(figures.cogs);
    // Money out of the ledger in the period — the dashboard's Cash paid out
    // (BRD 11), moved here when it left the dashboard (owner 2026-10-23). Not
    // a cost: buying stock is in it. The one reading of which rows are cash
    // (common/cash-position.ts), cut to the period's ledger days.
    const { cashOut } = await cashPosition(this.prisma, ledgerDayWhere(period));
    return {
      data: {
        /** The days covered, resolved: null for all time's open start. */
        from: start,
        to,
        allTime,
        salesEgp: money(figures.revenue),
        cogsEgp: money(figures.cogs),
        grossProfitEgp: money(grossProfit),
        /** Gross profit as a share of sales; null when nothing was sold. */
        grossProfitPctOfSales: pctOf(grossProfit, figures.revenue),
        expensesEgp: money(figures.operatingExpenses),
        recoveredEgp: money(figures.recovered),
        otherIncomeEgp: money(figures.otherIncome),
        exchangeDifferenceEgp: money(figures.exchangeDiff),
        netProfitEgp: money(figures.netProfit),
        /** Net profit as a share of sales; null when nothing was sold. */
        netProfitPctOfSales: pctOf(figures.netProfit, figures.revenue),
        /** Money paid out of the ledger in the period: not a cost (BRD 11). */
        cashOutEgp: money(cashOut),
        expensesByCategory,
        /** How the chart's buckets are cut: day, week (Sat–Fri) or month. */
        granularity,
        buckets: buckets.map((b, i) => {
          const f = figuresOf(inBucket[i]);
          return {
            ...b,
            salesEgp: money(f.revenue),
            grossProfitEgp: money(f.revenue.sub(f.cogs)),
            expensesEgp: money(f.operatingExpenses),
            netProfitEgp: money(f.netProfit),
          };
        }),
      },
    };
  }

  /**
   * What customers paid: payments not undone, on the day each was received
   * (`receivedOn`, a Cairo calendar day). No period is all time. One reading
   * for the dashboard's all-time Collected and its This month (rule 11).
   */
  private async collectedEgp(period?: DayPeriod): Promise<Prisma.Decimal> {
    const days = period ? calendarRange(period.from, period.to) : undefined;
    const { _sum } = await this.prisma.payment.aggregate({
      where: { status: 'RECORDED', ...(days ? { receivedOn: days } : {}) },
      _sum: { amount: true },
    });
    return new Prisma.Decimal(_sum?.amount ?? 0);
  }

  async getDashboardKPIs(now = new Date()) {
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    // Revenue, COGS, expenses and net profit: the one computation Analytics'
    // profit and loss reads too, here for all time (rule 11).
    const {
      revenue,
      cogs,
      operatingExpenses,
      recovered,
      otherIncome,
      exchangeDiff,
      netProfit,
    } = await this.profitFigures();

    // Cash actually paid out, reported separately from accounting profit
    // (BRD 11). Read with cash in and cash on hand below, through the one
    // definition of which ledger rows are cash: leftover stock moved between
    // cycles (§8, L5) moves none (common/cash-position.ts, rule 11).
    const cash = await cashPosition(this.prisma);
    const cashOut = cash.cashOut;

    const totalRevenue = money(revenue);
    const totalCogs = money(cogs);
    const totalExpenses = money(operatingExpenses);
    const totalCashOut = money(cashOut);

    // Active cycles: neither closed nor cancelled — through the one definition
    // of a finished cycle (rule 11). This read 'CLOSED' alone, so a cancelled
    // cycle stayed "active" on the dashboard for good (owner, 2026-10-17).
    const activeCycles = await this.prisma.importCycle.count({
      where: ACTIVE_CYCLE_WHERE,
    });

    // Inventory value: sum of remainingQty * landedUnitCostEgp from InventoryBatch
    const inventoryBatches = await this.prisma.inventoryBatch.findMany({
      select: { remainingQty: true, landedUnitCostEgp: true },
    });
    // One definition with a product page's Stock value (CLAUDE.md §11).
    const inventoryValue = stockValueEgp(inventoryBatches);
    // Units on the shelf across every product (§3) — one definition with the
    // Products and Inventory tabs' card (`stockCounts`).
    const unitsInStock = unitsOnShelf(inventoryBatches);

    // Receivables: sum of outstanding > 0 from confirmed sales orders
    const receivableOrders = await this.prisma.saleOrder.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PARTIALLY_PAID'] },
        outstanding: { gt: 0 },
      },
      select: { outstanding: true },
    });
    const receivables = receivableOrders.reduce(
      (sum, o) => sum + Number(o.outstanding),
      0,
    );

    // Low stock: the one rule (common/low-stock.ts, BUSINESS_LOGIC §3).
    const lowStockAlerts = await countLowStock(this.prisma);

    // Total customers
    // Money actually in hand, as opposed to money earned.
    //
    // Revenue above is what has been sold; this is what has been collected for
    // it. The two differ by the receivables below, and keeping them apart is
    // the whole point: a good month of selling and an empty till look
    // identical if only one number is shown.
    const collected = money(await this.collectedEgp());

    // This calendar month in Cairo, as Analytics' profit and loss reads its
    // This month — the same days through the same computation (owner
    // 2026-10-23, rule 11), so the two net profits agree to the piastre.
    const monthDays = thisMonthPeriod(now);
    const monthFigures = await this.profitFigures(monthDays);
    const month = {
      from: monthDays.from,
      to: monthDays.to,
      revenue: money(monthFigures.revenue),
      collected: money(await this.collectedEgp(monthDays)),
      expenses: money(monthFigures.operatingExpenses),
      netProfit: money(monthFigures.netProfit),
    };

    const totalCustomers = await this.customerCount();
    const totalProducts = await this.productCount();

    /**
     * Money actually in hand: everything in, less everything out.
     *
     * This could not be computed honestly until contributions were recorded.
     * The ledger held the purchase going out and nothing for the partners'
     * capital coming in, so netting it gave −62,325 on a cycle that had been
     * settled in full and owed nobody anything — a figure worse than no figure,
     * which is why none was shown.
     *
     * Both directions in one pass rather than two aggregates: a category added
     * on one side and forgotten on the other is exactly how the number drifted
     * last time.
     */
    const { cashIn, cashOnHand } = cash;

    return {
      data: {
        totalRevenue,
        totalCogs,
        totalExpenses,
        /** Supplier and loss refunds, added back in netProfit (§6). */
        totalRecoveredEgp: money(recovered),
        /** Other income recorded by hand, added in netProfit; not Revenue (§9, L6). */
        totalOtherIncomeEgp: money(otherIncome),
        /** Repaying friends at a moved rate, taken off netProfit (§18). */
        exchangeDifferenceEgp: money(exchangeDiff),
        /** What friends are still owed, per currency and in pounds today (§18). */
        owedToLenders: await owedToLenders(this.prisma),
        totalCashOut,
        totalCashIn: money(cashIn),
        cashOnHand: money(cashOnHand),
        collected,
        netProfit: money(netProfit),
        activeCycles,
        inventoryValue,
        unitsInStock,
        receivables,
        lowStockAlerts,
        totalCustomers,
        totalProducts,
        /**
         * This calendar month in Cairo, from its 1st to today — Analytics'
         * profit and loss This month, figure for figure (owner 2026-10-23).
         */
        month,
      },
    };
  }

  async getRevenueByMonth(months: number = 12) {
    // See `monthBuckets` for why this is not a loop that walks a date forward.
    // In short: `setMonth` is local time, the keys are UTC, and a date carrying
    // a day-of-month cannot be stepped by months — together they dropped the
    // current month from the chart on 24 days of 2026.
    const now = new Date();
    // `months` buckets ending with the current one, so 12 means this month and
    // the eleven before it — not thirteen. Months are Cairo's (§4,
    // 2026-10-16): a sale belongs to the month of its own day there.
    const { keys, since } = businessMonthBuckets(now, months);

    const orders = await this.prisma.saleOrder.findMany({
      where: {
        // Was CONFIRMED/PAID only, so a partially paid order was missing here
        // while the dashboard counted it — the two totals disagreed.
        status: { in: [...REALISED_SALE_STATUSES] },
        orderedAt: { gte: since },
      },
      select: { orderedAt: true, total: true },
      orderBy: { orderedAt: 'asc' },
    });

    // Group by month
    const revenueByMonth: Record<string, number> = {};
    for (const order of orders) {
      const monthKey = businessMonthOf(order.orderedAt); // YYYY-MM, Cairo
      revenueByMonth[monthKey] =
        (revenueByMonth[monthKey] || 0) + Number(order.total);
    }

    // Returns reduce the month they came back in, not the month of the sale:
    // a past month that has already been reported should not change.
    const returns = await this.prisma.saleReturn.findMany({
      where: {
        returnedOn: { gte: since },
        saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
      },
      select: { returnedOn: true, refundEgp: true },
    });

    for (const ret of returns) {
      const monthKey = ret.returnedOn.toISOString().slice(0, 7);
      revenueByMonth[monthKey] =
        (revenueByMonth[monthKey] || 0) - Number(ret.refundEgp);
    }

    // A price lowered after the sale reduces the month it was lowered in (§4).
    const adjustments = await this.prisma.salePriceAdjustment.findMany({
      where: {
        adjustedOn: { gte: since },
        saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
      },
      select: { adjustedOn: true, amountEgp: true },
    });
    for (const a of adjustments) {
      const monthKey = a.adjustedOn.toISOString().slice(0, 7);
      revenueByMonth[monthKey] =
        (revenueByMonth[monthKey] || 0) - Number(a.amountEgp);
    }

    // Every bucket, including the current month, and zero for the quiet ones.
    const result = keys.map((key) => ({
      month: key,
      revenue: revenueByMonth[key] || 0,
    }));

    return { data: result };
  }

  /**
   * The best sellers, net of returns. `by` picks the ranking: what each brought
   * in (the default, and what the Analytics table and the dashboard showed
   * first), or how many units went out (owner 2026-10-18: "a chart for the top
   * 5 sold products, as in qty not revenue"). Ties fall to the other measure,
   * then the name, so the order never depends on the database's.
   */
  async getTopProducts(limit: number = 10, by: TopProductsBy = 'revenue') {
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        nameAr: true,
        sku: true,
        saleItems: {
          // Without this filter every draft counts, including abandoned ones,
          // which is how a product showed three million units sold.
          where: SOLD_LINE_WHERE,
          select: {
            quantity: true,
            lineTotal: true,
            allocations: { select: { cogsEgp: true } },
            returnItems: {
              select: { qty: true, unitPrice: true, cogsReversedEgp: true },
            },
            priceAdjustments: { select: { amountEgp: true } },
          },
        },
      },
    });

    const ranked = products
      .map((p) => {
        // Sales less what came back: a product with heavy returns is not a
        // top seller, and counting the gross figure would say it was.
        const units = netUnitsSold(p.saleItems);
        // Less prices lowered after the sale (§4, 2026-10-22).
        const revenue = p.saleItems.reduce(
          (sum, i) =>
            i.priceAdjustments.reduce(
              (s2, a) => s2.sub(D(a.amountEgp)),
              i.returnItems.reduce(
                (s2, r) => s2.sub(D(r.unitPrice).mul(D(r.qty))),
                sum.add(D(i.lineTotal)),
              ),
            ),
          D(0),
        );
        const cogs = p.saleItems.reduce(
          (sum, i) =>
            i.returnItems.reduce(
              (s2, r) => s2.sub(D(r.cogsReversedEgp)),
              i.allocations.reduce((s2, a) => s2.add(D(a.cogsEgp)), sum),
            ),
          D(0),
        );
        const profit = revenue.sub(cogs);

        return {
          productId: p.id,
          name: p.name,
          nameAr: p.nameAr,
          sku: p.sku,
          totalQuantitySold: unitsFigure(units),
          revenueEgp: money(revenue),
          cogsEgp: money(cogs),
          profitEgp: money(profit),
          // Margin is meaningless without revenue to divide by.
          marginPct: revenue.gt(0)
            ? Number(profit.div(revenue).mul(100).toDecimalPlaces(1))
            : null,
        };
      })
      .sort((a, b) =>
        by === 'units'
          ? b.totalQuantitySold - a.totalQuantitySold ||
            b.revenueEgp - a.revenueEgp ||
            a.name.localeCompare(b.name)
          : b.revenueEgp - a.revenueEgp ||
            b.totalQuantitySold - a.totalQuantitySold ||
            a.name.localeCompare(b.name),
      )
      .slice(0, limit);

    return { data: ranked };
  }

  /**
   * The two stand-out sales for the Sales tab's summary (owner 2026-10-18:
   * "the order with the most revenue and the largest order"): the one that
   * brought in the most, and the one that sent out the most units. Realised
   * sales only, net of returns — revenue is the order's total less its
   * refunds, as the dashboard and revenue-by-month count it, and units are
   * the lines' quantities less what came back, as the top products count
   * them. A sale with nothing left after returns is not a candidate. Ties
   * fall to the other measure, then the order number, so the answer never
   * depends on the database's order. Null when nothing has sold.
   */
  /** Products for sale: the active ones (the dashboard's and the Products tab's count). */
  private productCount() {
    return this.prisma.product.count({ where: { status: 'ACTIVE' } });
  }

  /** The shops the business has: the walk-in record is not one of them (§4). */
  private customerCount() {
    return this.prisma.customer.count({ where: { isWalkIn: false } });
  }

  /**
   * The Products and Inventory tabs' cards (owner 2026-10-22): how many
   * products there are and how many units are on the shelf — the dashboard's
   * own figures, from the same definitions.
   */
  async getStockSummary() {
    const batches = await this.prisma.inventoryBatch.findMany({
      select: { remainingQty: true },
    });
    return {
      data: {
        totalProducts: await this.productCount(),
        unitsInStock: unitsOnShelf(batches),
      },
    };
  }

  /**
   * The Customers tab's cards (owner 2026-10-22): how many customers there
   * are, and the one who has paid the most — every payment standing (a
   * reversed one no longer paid anything), all time. Walk-in buyers share one
   * record that is not a customer, so it never takes the card. A tie falls to
   * the name, so the card never depends on the database's order.
   */
  async getCustomerSummary() {
    const paid = await this.prisma.payment.groupBy({
      by: ['customerId'],
      where: { status: 'RECORDED', customer: { isWalkIn: false } },
      _sum: { amount: true },
    });
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: paid.map((p) => p.customerId) } },
      select: { id: true, displayName: true },
    });
    const ranked = paid
      .map((p) => ({
        customer: customers.find((c) => c.id === p.customerId),
        paidEgp: Number(
          new Prisma.Decimal(p._sum.amount ?? 0).toDecimalPlaces(2),
        ),
      }))
      .filter((p) => p.customer && p.paidEgp > 0)
      .sort(
        (a, b) =>
          b.paidEgp - a.paidEgp ||
          a.customer!.displayName.localeCompare(b.customer!.displayName),
      );
    const top = ranked[0];
    return {
      data: {
        totalCustomers: await this.customerCount(),
        topPayer: top
          ? {
              customerId: top.customer!.id,
              displayName: top.customer!.displayName,
              paidEgp: top.paidEgp,
            }
          : null,
      },
    };
  }

  /**
   * The Payments tab's card (owner 2026-10-22): the largest payment standing
   * (not reversed), and who paid it. A tie falls to the earlier one.
   */
  async getPaymentSummary() {
    const largest = await this.prisma.payment.findFirst({
      where: { status: 'RECORDED' },
      orderBy: [
        { amount: 'desc' },
        { receivedOn: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        amount: true,
        currency: true,
        receivedOn: true,
        reference: true,
        method: true,
        customer: { select: { id: true, displayName: true, isWalkIn: true } },
      },
    });
    return {
      data: {
        largest: largest
          ? {
              paymentId: largest.id,
              amount: Number(
                new Prisma.Decimal(largest.amount).toDecimalPlaces(2),
              ),
              currency: largest.currency,
              receivedOn: largest.receivedOn.toISOString().slice(0, 10),
              reference: largest.reference,
              method: largest.method,
              customer: largest.customer,
            }
          : null,
      },
    };
  }

  async getTopOrders() {
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

    const orders = await this.prisma.saleOrder.findMany({
      where: { status: { in: [...REALISED_SALE_STATUSES] } },
      select: {
        id: true,
        orderNo: true,
        orderedAt: true,
        total: true,
        customer: { select: { id: true, displayName: true, isWalkIn: true } },
        returns: { select: { refundEgp: true } },
        priceAdjustments: { select: { amountEgp: true } },
        items: {
          select: {
            productId: true,
            quantity: true,
            returnItems: { select: { qty: true } },
          },
        },
      },
    });

    const candidates = orders
      .map((o) => {
        // Less refunds and prices lowered after the sale (§4, 2026-10-22).
        const revenue = o.priceAdjustments.reduce(
          (sum, a) => sum.sub(D(a.amountEgp)),
          o.returns.reduce((sum, r) => sum.sub(D(r.refundEgp)), D(o.total)),
        );
        const units = o.items.reduce(
          (sum, i) =>
            i.returnItems.reduce(
              (s2, r) => s2.sub(D(r.qty)),
              sum.add(D(i.quantity)),
            ),
          D(0),
        );
        return {
          orderId: o.id,
          orderNo: o.orderNo,
          orderedAt: o.orderedAt,
          customer: o.customer,
          revenueEgp: Number(revenue.toDecimalPlaces(2)),
          units: Number(units.toDecimalPlaces(3)),
          lines: o.items.length,
          // Kinds of product on it (owner 2026-10-22: "products instead" of lines).
          products: new Set(o.items.map((i) => i.productId)).size,
        };
      })
      .filter((o) => o.revenueEgp > 0 && o.units > 0);

    type Candidate = (typeof candidates)[number];
    const best = (cmp: (a: Candidate, b: Candidate) => number) =>
      candidates.reduce<Candidate | null>(
        (top, o) => (top === null || cmp(o, top) < 0 ? o : top),
        null,
      );
    const byOrderNo = (a: Candidate, b: Candidate) =>
      a.orderNo.localeCompare(b.orderNo);

    return {
      data: {
        mostRevenue: best(
          (a, b) =>
            b.revenueEgp - a.revenueEgp || b.units - a.units || byOrderNo(a, b),
        ),
        mostUnits: best(
          (a, b) =>
            b.units - a.units || b.revenueEgp - a.revenueEgp || byOrderNo(a, b),
        ),
      },
    };
  }

  /**
   * Per-cycle economics, for comparing cycles against each other (BRD 11).
   *
   * Revenue and cost are attributed through batch allocations, not through the
   * cycle's own financial transactions: a sale draws stock by FIFO and can span
   * batches from several cycles, so its revenue is deliberately recorded
   * without a cycleId. Reading INFLOW transactions per cycle therefore reported
   * zero revenue for every cycle, including closed ones.
   *
   * Every cycle that has bought something is included. Restricting this to
   * CLOSED cycles made the comparison permanently empty, which defeats the
   * purpose of comparing cycles while they are still running.
   */
  async getCycleProfitability(viewer: ScopeViewer = 'internal') {
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const cycles = await this.prisma.importCycle.findMany({
      where: scope === null ? undefined : { id: { in: [...scope] } },
      select: {
        id: true,
        code: true,
        status: true,
        originType: true,
        financialTransactions: {
          select: {
            amount: true,
            direction: true,
            category: true,
            reversalOfId: true,
          },
        },
        inventoryBatches: {
          select: {
            receivedQty: true,
            remainingQty: true,
            landedUnitCostEgp: true,
            saleItemAllocations: {
              where: {
                saleItem: {
                  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
                },
              },
              select: {
                qty: true,
                cogsEgp: true,
                saleItem: { select: { quantity: true, lineTotal: true } },
              },
            },
            // Goods returned out of this batch, netted off below.
            //
            // Same status filter as the allocations above. A fully returned
            // order leaves the realised set, so its revenue is already absent
            // — netting its return as well subtracted the same money twice and
            // put cycle revenue 3,000 below the dashboard.
            returnItems: {
              where: {
                saleItem: {
                  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
                },
              },
              select: { qty: true, unitPrice: true, cogsReversedEgp: true },
            },
            // This batch's share of prices lowered after the sale (§4).
            priceAdjustmentItems: {
              where: {
                adjustment: {
                  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
                },
              },
              select: { amountEgp: true },
            },
          },
        },
      },
      orderBy: { code: 'asc' },
    });

    // Goods lost on the way, per cycle: the figure settlement subtracts,
    // read through the one definition (§2, §9; rule 11).
    const withStock = cycles.filter((c) => c.inventoryBatches.length > 0);
    const lossesByCycle = new Map<string, Prisma.Decimal>();
    // Units out at shops as samples are unsold stock (§4, samples at shops).
    const atShopsByCycle = new Map<
      string,
      { units: Prisma.Decimal; value: Prisma.Decimal }
    >();
    const exchangeByCycle = new Map<string, Prisma.Decimal>();
    for (const c of withStock) {
      lossesByCycle.set(
        c.id,
        (await cycleWriteOffsEgp(this.prisma, c.id)).total,
      );
      atShopsByCycle.set(c.id, await cycleUnitsAtShops(this.prisma, c.id));
      // Repaying friends at a moved rate (§18), as settlement reads it.
      exchangeByCycle.set(c.id, await exchangeDifferenceEgp(this.prisma, c.id));
    }

    const result = withStock.map((cycle) => {
      let revenue = D(0);
      let cogs = D(0);
      let unitsSold = D(0);
      let unsoldValue = D(0);
      let unitsRemaining = D(0);

      for (const batch of cycle.inventoryBatches) {
        unitsRemaining = unitsRemaining.add(D(batch.remainingQty));
        unsoldValue = unsoldValue.add(
          D(batch.remainingQty).mul(D(batch.landedUnitCostEgp)),
        );

        // A return reverses the sale it came from: fewer units sold, less
        // revenue, and the cost back — except for damaged goods, whose
        // cogsReversedEgp is zero because they never returned to stock.
        for (const ret of batch.returnItems) {
          const qty = D(ret.qty);
          unitsSold = unitsSold.sub(qty);
          revenue = revenue.sub(D(ret.unitPrice).mul(qty));
          cogs = cogs.sub(D(ret.cogsReversedEgp));
        }

        for (const adj of batch.priceAdjustmentItems) {
          revenue = revenue.sub(D(adj.amountEgp));
        }

        for (const alloc of batch.saleItemAllocations) {
          const qty = D(alloc.qty);
          unitsSold = unitsSold.add(qty);
          cogs = cogs.add(D(alloc.cogsEgp));

          // Price per unit from the line it was sold on, so a line discount
          // is reflected and a part-allocated line is only counted pro rata.
          const lineQty = D(alloc.saleItem.quantity);
          if (lineQty.gt(0)) {
            revenue = revenue.add(
              D(alloc.saleItem.lineTotal).div(lineQty).mul(qty),
            );
          }
        }
      }

      // What the cycle consumed in cash: goods, shipping and fees, less
      // anything a supplier gave back.
      // A refund recovers cost, so it improves the cycle's result even though
      // it changes no batch cost. Supplier refunds and loss refunds alike,
      // net of any undone (B5b), through the one signed reading settlement
      // uses (rule 11). Counting only the inflows kept an undone refund here.
      const supplierRefunds = netRecoveredEgp(cycle.financialTransactions);
      const investment = cycle.financialTransactions
        .filter(
          (t) =>
            t.direction === 'OUTFLOW' &&
            !isCostRecoveryCategory(t.category) &&
            // A friend's loan moving is not what the goods cost: the goods are
            // in `purchase` already, and repaying him would count them twice.
            // What the loan really cost is the exchange difference (§18).
            !isLenderCategory(t.category) &&
            // Leftovers moved between cycles (§8, L5): netted, signed, below.
            t.category !== TRANSFER_CATEGORY,
        )
        .reduce((sum, t) => sum.add(D(t.amount)), D(0))
        // Stock taken on from another cycle is part of what this cycle cost;
        // stock handed on is cost recovered. Signed, so both cycles agree.
        .add(transferNetEgp(cycle.financialTransactions))
        .sub(supplierRefunds)
        .add(exchangeByCycle.get(cycle.id) ?? D(0));

      const atShops = atShopsByCycle.get(cycle.id);
      if (atShops) {
        unitsRemaining = unitsRemaining.add(atShops.units);
        unsoldValue = unsoldValue.add(atShops.value);
      }

      const losses = lossesByCycle.get(cycle.id) ?? D(0);
      const exchangeDiff = exchangeByCycle.get(cycle.id) ?? D(0);
      // Expenses charged to the cycle and other income credited to it, read
      // as settlement reads them (L6, rule 11). This figure used to leave
      // them out, so a cycle's page and its settlement disagreed by exactly
      // the cycle's expenses.
      const expenses = netOperatingExpenseEgp(cycle.financialTransactions);
      const otherIncome = netOtherIncomeEgp(cycle.financialTransactions);
      const profit = revenue
        .sub(cogs)
        .add(supplierRefunds)
        .sub(losses)
        .sub(exchangeDiff)
        .sub(expenses)
        .add(otherIncome);

      return {
        // So a row can link to its cycle (an investor's dashboard, R1).
        cycleId: cycle.id,
        cycleCode: cycle.code,
        status: cycle.status,
        originType: cycle.originType,
        investment: money(investment),
        supplierRefundsEgp: money(supplierRefunds),
        /** Goods lost on the way and samples written off, already taken off profit (§2, §4). */
        lossesEgp: money(losses),
        /** Expenses charged to the cycle, already taken off profit (§9, L6). */
        expensesEgp: money(expenses),
        /** Other income credited to the cycle, already in profit (§9, L6). */
        otherIncomeEgp: money(otherIncome),
        /** Repaying friends at a moved rate, already taken off profit (§18). */
        exchangeDifferenceEgp: money(exchangeDiff),
        totalCost: money(cogs),
        totalRevenue: money(revenue),
        profit: money(profit),
        // Return on the cost of goods actually sold; meaningless with no sales.
        roiPct: cogs.gt(0)
          ? Number(profit.div(cogs).mul(100).toDecimalPlaces(1))
          : null,
        unitsSold: Number(unitsSold.toDecimalPlaces(3)),
        unitsRemaining: Number(unitsRemaining.toDecimalPlaces(3)),
        unsoldValueEgp: money(unsoldValue),
      };
    });

    return { data: result };
  }
}
