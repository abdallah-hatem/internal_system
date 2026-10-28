// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a profit in EGP must not become a float
import { Prisma } from '@prisma/client';
import type { ProfitPart } from './analytics.service';

/**
 * What made one bar of Analytics' profit and loss (owner 2026-10-28: "clicking
 * on a day or a month should open a popup or show me the details of loss";
 * BUSINESS_LOGIC §9 "What made a bar").
 *
 * Not a second reading of the books: the rows are the very parts
 * `profitParts` reads for the chart, grouped by the record each came from
 * (CLAUDE.md §11). Every part lands in exactly one row and every row in
 * exactly one section, so the sections add up to the bar's figures by
 * construction — a part the grouping did not know would throw, never vanish.
 */

/** The popup's lists, in the order it shows them. */
export const BREAKDOWN_SECTIONS = [
  'orders',
  'expenses',
  'exchange',
  'other',
] as const;
export type BreakdownSection = (typeof BREAKDOWN_SECTIONS)[number];

/** The longest run of days one breakdown covers: a month, the widest bar. */
export const BREAKDOWN_MAX_DAYS = 31;
/** Rows per page of a section when the caller does not say (GUESS). */
export const BREAKDOWN_PAGE_SIZE = 25;

const zero = () => new Prisma.Decimal(0);

/** A return or a price cut on the order, inside the period. */
export interface OrderEvent {
  kind: 'return' | 'priceCut';
  id: string;
  day: string;
  /** What it took off revenue: negative. */
  revenueEgp: Prisma.Decimal;
  /** What it took off cost of goods (a return's cost put back): negative or zero. */
  cogsEgp: Prisma.Decimal;
}

/** One order's revenue and cost of goods inside the period. */
export interface OrderRow {
  orderId: string;
  /** The first day the order touched the period. */
  day: string;
  /** Sold in the period: the order's total, when its sale day is inside. */
  saleEgp: Prisma.Decimal;
  /** Returns in the period: negative. */
  returnsEgp: Prisma.Decimal;
  /** Prices lowered in the period: negative. */
  priceCutsEgp: Prisma.Decimal;
  /** saleEgp + returnsEgp + priceCutsEgp. */
  revenueEgp: Prisma.Decimal;
  /** Cost of what it sold, less the cost its returns put back. */
  cogsEgp: Prisma.Decimal;
  /** revenueEgp − cogsEgp. */
  grossEgp: Prisma.Decimal;
  events: OrderEvent[];
}

/** One expense: a ledger row, goods lost on the way, or an order's samples written off. */
export interface ExpenseRow {
  kind: 'ledger' | 'loss' | 'samples';
  /** The ledger row, the loss, or the samples order. */
  id: string;
  day: string;
  category: string | null;
  amountEgp: Prisma.Decimal;
}

/** One repayment to a friend at a moved rate: a cost when positive. */
export interface ExchangeRow {
  id: string;
  day: string;
  amountEgp: Prisma.Decimal;
}

/** Money recovered or other income: raises net profit. */
export interface OtherRow {
  line: 'recovered' | 'otherIncome';
  id: string;
  day: string;
  category: string | null;
  amountEgp: Prisma.Decimal;
}

export interface Breakdown {
  orders: OrderRow[];
  expenses: ExpenseRow[];
  exchange: ExchangeRow[];
  other: OtherRow[];
}

const byIdThenDay = <T extends { day: string; id: string }>(a: T, b: T) =>
  a.day.localeCompare(b.day) || a.id.localeCompare(b.id);

/**
 * The parts of a period, grouped. Each list is in a fixed order that ends on
 * an id, so pages never overlap: orders by gross profit, worst first (a loss
 * is what the popup is for, GUESS); expenses, exchange and other by amount,
 * largest first.
 */
export function breakdownOf(parts: readonly ProfitPart[]): Breakdown {
  const orders = new Map<string, OrderRow>();
  const order = (orderId: string, day: string) => {
    let row = orders.get(orderId);
    if (!row) {
      row = {
        orderId,
        day,
        saleEgp: zero(),
        returnsEgp: zero(),
        priceCutsEgp: zero(),
        revenueEgp: zero(),
        cogsEgp: zero(),
        grossEgp: zero(),
        events: [],
      };
      orders.set(orderId, row);
    }
    if (day < row.day) row.day = day;
    return row;
  };
  const events = new Map<string, OrderEvent>();
  const samples = new Map<string, ExpenseRow>();
  const expenses: ExpenseRow[] = [];
  const exchange: ExchangeRow[] = [];
  const other: OtherRow[] = [];

  for (const p of parts) {
    const s = p.source;
    if (!s || p.day === null) {
      throw new Error(`A ${p.line} part has no record to show it by.`);
    }
    const day = p.day;
    if (p.line === 'revenue' || p.line === 'cogs') {
      if (s.kind !== 'sale' && s.kind !== 'return' && s.kind !== 'priceCut') {
        throw new Error(`A ${p.line} part from a ${s.kind}.`);
      }
      const row = order(s.orderId, day);
      if (p.line === 'cogs') row.cogsEgp = row.cogsEgp.add(p.amount);
      else if (s.kind === 'sale') row.saleEgp = row.saleEgp.add(p.amount);
      else if (s.kind === 'return')
        row.returnsEgp = row.returnsEgp.add(p.amount);
      else row.priceCutsEgp = row.priceCutsEgp.add(p.amount);
      if (s.kind !== 'sale') {
        let e = events.get(s.id);
        if (!e) {
          e = {
            kind: s.kind,
            id: s.id,
            day,
            revenueEgp: zero(),
            cogsEgp: zero(),
          };
          events.set(s.id, e);
          row.events.push(e);
        }
        if (p.line === 'cogs') e.cogsEgp = e.cogsEgp.add(p.amount);
        else e.revenueEgp = e.revenueEgp.add(p.amount);
      }
      continue;
    }
    if (p.line === 'operating' && s.kind === 'ledger') {
      expenses.push({
        kind: 'ledger',
        id: s.id,
        day,
        category: p.category ?? null,
        amountEgp: p.amount,
      });
    } else if (p.line === 'losses' && s.kind === 'loss') {
      expenses.push({
        kind: 'loss',
        id: s.id,
        day,
        category: null,
        amountEgp: p.amount,
      });
    } else if (p.line === 'samples' && s.kind === 'samples') {
      // One row per samples order: its allocations are one write-off.
      const row = samples.get(s.orderId);
      if (row) row.amountEgp = row.amountEgp.add(p.amount);
      else {
        const fresh: ExpenseRow = {
          kind: 'samples',
          id: s.orderId,
          day,
          category: null,
          amountEgp: p.amount,
        };
        samples.set(s.orderId, fresh);
        expenses.push(fresh);
      }
    } else if (p.line === 'exchangeDiff' && s.kind === 'repayment') {
      exchange.push({ id: s.id, day, amountEgp: p.amount });
    } else if (
      (p.line === 'recovered' || p.line === 'otherIncome') &&
      s.kind === 'ledger'
    ) {
      other.push({
        line: p.line,
        id: s.id,
        day,
        category: p.category ?? null,
        amountEgp: p.amount,
      });
    } else {
      throw new Error(`A ${p.line} part from a ${s.kind}.`);
    }
  }

  const orderRows = [...orders.values()].map((r) => {
    const revenueEgp = r.saleEgp.add(r.returnsEgp).add(r.priceCutsEgp);
    r.events.sort(byIdThenDay);
    return { ...r, revenueEgp, grossEgp: revenueEgp.sub(r.cogsEgp) };
  });
  orderRows.sort(
    (a, b) =>
      a.grossEgp.cmp(b.grossEgp) ||
      a.day.localeCompare(b.day) ||
      a.orderId.localeCompare(b.orderId),
  );
  const largestFirst = <T extends { amountEgp: Prisma.Decimal }>(
    a: T & { day: string; id: string },
    b: T & { day: string; id: string },
  ) => b.amountEgp.cmp(a.amountEgp) || byIdThenDay(a, b);
  return {
    orders: orderRows,
    expenses: expenses.sort(largestFirst),
    exchange: exchange.sort(largestFirst),
    other: other.sort(largestFirst),
  };
}

/** A section's own totals, from all its rows (not the page shown). */
export function sectionTotals(b: Breakdown) {
  const sum = <T>(rows: T[], f: (r: T) => Prisma.Decimal) =>
    rows.reduce((s, r) => s.add(f(r)), zero());
  return {
    orders: {
      saleEgp: sum(b.orders, (r) => r.saleEgp),
      returnsEgp: sum(b.orders, (r) => r.returnsEgp),
      priceCutsEgp: sum(b.orders, (r) => r.priceCutsEgp),
      revenueEgp: sum(b.orders, (r) => r.revenueEgp),
      cogsEgp: sum(b.orders, (r) => r.cogsEgp),
      grossEgp: sum(b.orders, (r) => r.grossEgp),
    },
    expenses: { amountEgp: sum(b.expenses, (r) => r.amountEgp) },
    exchange: { amountEgp: sum(b.exchange, (r) => r.amountEgp) },
    other: {
      recoveredEgp: sum(
        b.other.filter((r) => r.line === 'recovered'),
        (r) => r.amountEgp,
      ),
      otherIncomeEgp: sum(
        b.other.filter((r) => r.line === 'otherIncome'),
        (r) => r.amountEgp,
      ),
    },
  };
}
