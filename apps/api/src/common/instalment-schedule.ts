// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';

/**
 * Where a schedule of instalments stands, given what has been paid against it
 * (BUSINESS_LOGIC §7, and §18 for a friend's loan).
 *
 * Progress is cumulative, not instalment by instalment: what matters on any
 * day is whether at least what was promised by then has been paid. Money is
 * applied to the earliest instalments first and a surplus flows forward, so a
 * payer who is late on one and early on the next is square. Due today is not
 * overdue until tomorrow.
 *
 * One definition for a shop's plan and a lender's plan (CLAUDE.md rule 11): two
 * copies would disagree about who is late the first time one changed. Pure —
 * the caller says what "today" is, as a calendar day.
 */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export type InstalmentState = 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';

export interface ScheduledInstalment {
  id: string;
  sequence: number;
  dueOn: Date;
  amount: Prisma.Decimal.Value;
}

/** A date column's calendar day. Stored as `date`, read back at UTC midnight. */
export function dayOf(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function evaluateSchedule<T extends ScheduledInstalment>(
  instalments: readonly T[],
  paidToDate: Prisma.Decimal.Value,
  today: string,
) {
  const paidIn = D(paidToDate);
  let cumulativeDue = D(0);
  let applied = D(0);
  let overdue = D(0);

  const lines = instalments.map((i) => {
    const amount = D(i.amount);
    cumulativeDue = cumulativeDue.add(amount);

    const remainingPayment = Prisma.Decimal.max(paidIn.sub(applied), D(0));
    const coveredHere = Prisma.Decimal.min(remainingPayment, amount);
    applied = applied.add(coveredHere);

    const outstanding = amount.sub(coveredHere);
    const due = dayOf(i.dueOn);

    let state: InstalmentState;
    if (outstanding.lte(0)) state = 'PAID';
    else if (due < today) state = 'OVERDUE';
    else if (due === today) state = 'DUE';
    else state = 'UPCOMING';

    if (state === 'OVERDUE') overdue = overdue.add(outstanding);

    return {
      instalment: i,
      amount: money(amount),
      paid: money(coveredHere),
      outstanding: money(outstanding),
      state,
    };
  });

  const total = cumulativeDue;
  const nextDue =
    lines.find((l) => l.state === 'DUE' || l.state === 'UPCOMING') ?? null;

  return {
    lines,
    total: money(total),
    paid: money(Prisma.Decimal.min(paidIn, total)),
    remaining: money(Prisma.Decimal.max(total.sub(paidIn), D(0))),
    overdue: money(overdue),
    isOverdue: overdue.gt(0),
    nextDue,
  };
}
