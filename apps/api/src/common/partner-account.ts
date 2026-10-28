// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';

/**
 * A partner's running account (BUSINESS_LOGIC §8, owner 2026-10-25: "a great
 * idea an account"; "equal thirds, no negative, paid straight to supplier").
 *
 * His balance is what he has put towards the business and not yet had drawn
 * into a cycle or taken out:
 *
 *   + an advance — he paid a supplier for a cycle from his own pocket;
 *   + a settlement payout he left in;
 *   + a business expense he paid from his own pocket (`EXPENSE_PAID`, §9
 *     "Paid by", 2026-10-27) — the business owes it him back;
 *   − a contribution to a cycle, drawn from the account;
 *   − money he took out.
 *
 * One definition (CLAUDE.md §11): the Partners page, the cycle's funding
 * panel, a contribution's check, a withdrawal's check, a reversal's check and
 * a settlement's reversal all read the balance — and its pots, which cycle
 * may draw which part of it (`potsOf`, owner 2026-10-26) — here, never their
 * own sum.
 *
 * What it is NOT (CLAUDE.md §11): none of it is a ledger row. An advance went
 * straight to a supplier, so it is not cash in the business, not income, and
 * not a cost (the goods are costed at receipt as always). The cash event is
 * the contribution — his money entering the cycle — which posts the same
 * `contribution` row an entered contribution always has
 * (`common/contribution-ledger.ts`). So cash on hand, profit and analytics
 * cannot move on an advance, a withdrawal or a payout left in.
 *
 * An expense he paid is the one movement with a ledger row behind it — the
 * expense itself, booked as any expense is, but named as paid by him
 * (`paidByUserId`), which is what keeps it out of cash
 * (`common/cash-position.ts`). The movement is only the credit: the business
 * owes him that much back.
 */

export type MovementKind =
  'ADVANCE' | 'PAYOUT_LEFT_IN' | 'CONTRIBUTION' | 'WITHDRAWAL' | 'EXPENSE_PAID';

/** Which way each kind moves his balance. */
export const MOVEMENT_SIGN: Record<MovementKind, 1 | -1> = {
  ADVANCE: 1,
  PAYOUT_LEFT_IN: 1,
  EXPENSE_PAID: 1,
  CONTRIBUTION: -1,
  WITHDRAWAL: -1,
};

/** A movement that stands: not reversed. */
export const STANDING_MOVEMENT = { reversedAt: null } as const;

/** What one movement does to his balance, signed. */
export function signedEgp(m: {
  kind: string;
  amountEgp: Prisma.Decimal.Value;
}): Prisma.Decimal {
  const sign = MOVEMENT_SIGN[m.kind as MovementKind];
  if (!sign) throw new Error(`Unknown account movement kind ${m.kind}`);
  return new Prisma.Decimal(m.amountEgp).mul(sign);
}

/** The balance over these movements: the standing ones, signed. */
export function balanceOf(
  movements: {
    kind: string;
    amountEgp: Prisma.Decimal.Value;
    reversedAt?: Date | null;
  }[],
): Prisma.Decimal {
  return movements
    .filter((m) => !m.reversedAt)
    .reduce((s, m) => s.add(signedEgp(m)), new Prisma.Decimal(0));
}

type Db = Pick<Prisma.TransactionClient, 'partnerAccountMovement'>;

/**
 * Each partner's balance, from the database. Every partner asked for is in
 * the map, at zero when he has no movement.
 */
export async function accountBalances(
  db: Db,
  partnerUserIds?: string[],
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await db.partnerAccountMovement.groupBy({
    by: ['partnerUserId', 'kind'],
    where: {
      ...STANDING_MOVEMENT,
      ...(partnerUserIds ? { partnerUserId: { in: partnerUserIds } } : {}),
    },
    _sum: { amountEgp: true },
  });
  const out = new Map<string, Prisma.Decimal>(
    (partnerUserIds ?? []).map((id) => [id, new Prisma.Decimal(0)]),
  );
  for (const r of rows) {
    const add = signedEgp({ kind: r.kind, amountEgp: r._sum.amountEgp ?? 0 });
    out.set(
      r.partnerUserId,
      (out.get(r.partnerUserId) ?? new Prisma.Decimal(0)).add(add),
    );
  }
  return out;
}

/** One partner's balance. */
export async function accountBalance(
  db: Db,
  partnerUserId: string,
): Promise<Prisma.Decimal> {
  return (
    (await accountBalances(db, [partnerUserId])).get(partnerUserId) ??
    new Prisma.Decimal(0)
  );
}

/**
 * Each cycle's funding is its own (owner 2026-10-26: "each cycle has its own
 * funding"; BUSINESS_LOGIC §8). His account is split into pots:
 *
 * - **a cycle's pot** — his standing advances on that cycle, less what his
 *   contributions to that cycle drew from them. Only that cycle can draw it:
 *   an advance paid a supplier for that cycle's goods.
 * - **untied money** — payouts he left in and expenses he paid for the
 *   business, less what he took out, less what
 *   his contributions drew beyond their own cycle's advances. Any cycle can
 *   draw it.
 *
 * A contribution to a cycle draws that cycle's advances first, untied money
 * for the rest (GUESS 2026-10-26). Read from the standing movements as they
 * are now, in any order, so no column records which pot paid: per cycle,
 * min(advances, contributions) came from its pot and the excess from untied
 * money. The pots add up to the balance (`balanceOf`) exactly.
 *
 * Never negative, per pot: a draw on a cycle is at most its pot plus untied
 * money; a withdrawal, and a settlement's reversal taking a payout back, at
 * most untied money; an advance can be reversed only while its cycle's pot
 * still holds it (the contribution it funded comes out first).
 */
export interface Pots {
  /** Money tied to no cycle. Below zero only if records from before 2026-10-26 drew across cycles. */
  untied: Prisma.Decimal;
  /** Each cycle's undrawn advances, by cycle id; only above zero. */
  byCycle: Map<string, Prisma.Decimal>;
  /**
   * What his contributions to each cycle drew from that cycle's own advances
   * — the part of "paid so far" that went into capital (the Funding card,
   * owner 2026-10-26): min(advances, contributions) per cycle, the same split
   * the pots make. Only above zero.
   */
  intoCapital: Map<string, Prisma.Decimal>;
}

/** The pots over these movements: the standing ones. */
export function potsOf(
  movements: {
    kind: string;
    amountEgp: Prisma.Decimal.Value;
    cycleId?: string | null;
    reversedAt?: Date | null;
  }[],
): Pots {
  const zero = new Prisma.Decimal(0);
  let untied = zero;
  const advanced = new Map<string, Prisma.Decimal>();
  const drawn = new Map<string, Prisma.Decimal>();
  const bump = (
    to: Map<string, Prisma.Decimal>,
    key: string,
    v: Prisma.Decimal,
  ) => to.set(key, (to.get(key) ?? zero).add(v));
  for (const m of movements) {
    if (m.reversedAt) continue;
    const amount = new Prisma.Decimal(m.amountEgp);
    // The API writes every advance and contribution with its cycle; a row
    // without one (only ever written by hand) is tied to no cycle, and is
    // read as untied money rather than breaking every page that reads pots.
    switch (m.kind as MovementKind) {
      case 'ADVANCE':
        if (m.cycleId) bump(advanced, m.cycleId, amount);
        else untied = untied.add(amount);
        break;
      case 'CONTRIBUTION':
        if (m.cycleId) bump(drawn, m.cycleId, amount);
        else untied = untied.sub(amount);
        break;
      case 'PAYOUT_LEFT_IN':
        // Its cycleId names the settled cycle it came from; it is tied to none.
        untied = untied.add(amount);
        break;
      case 'EXPENSE_PAID':
        // The business owes it him back: money he may take out or leave in
        // for any cycle, whatever the expense was charged to (GUESS
        // 2026-10-27). Written with no cycle.
        untied = untied.add(amount);
        break;
      case 'WITHDRAWAL':
        untied = untied.sub(amount);
        break;
      default:
        throw new Error(`Unknown account movement kind ${m.kind}`);
    }
  }
  const byCycle = new Map<string, Prisma.Decimal>();
  const intoCapital = new Map<string, Prisma.Decimal>();
  for (const id of new Set([...advanced.keys(), ...drawn.keys()])) {
    const own = advanced.get(id) ?? zero;
    const took = drawn.get(id) ?? zero;
    const left = own.sub(took);
    if (left.gt(0)) byCycle.set(id, left);
    // Drawn beyond this cycle's own advances: that came from untied money.
    else untied = untied.add(left);
    const fromOwn = Prisma.Decimal.min(own, took);
    if (fromOwn.gt(0)) intoCapital.set(id, fromOwn);
  }
  return { untied, byCycle, intoCapital };
}

/** His pots added up: his whole balance. */
export function potsTotal(pots: Pots): Prisma.Decimal {
  return [...pots.byCycle.values()].reduce((s, v) => s.add(v), pots.untied);
}

/** Untied money that can be drawn or taken: never below zero. */
export function untiedAvailable(pots: Pots): Prisma.Decimal {
  return Prisma.Decimal.max(pots.untied, 0);
}

/** What `cycleId` can draw from his account: its own pot, and untied money. */
export function availableTo(pots: Pots, cycleId: string): Prisma.Decimal {
  return (pots.byCycle.get(cycleId) ?? new Prisma.Decimal(0)).add(
    untiedAvailable(pots),
  );
}

/**
 * Each partner's pots, from the database. Every partner asked for is in the
 * map, with empty pots when he has no movement.
 */
export async function accountPots(
  db: Db,
  partnerUserIds: string[],
): Promise<Map<string, Pots>> {
  const rows = await db.partnerAccountMovement.groupBy({
    by: ['partnerUserId', 'kind', 'cycleId'],
    where: { ...STANDING_MOVEMENT, partnerUserId: { in: partnerUserIds } },
    _sum: { amountEgp: true },
  });
  return new Map(
    partnerUserIds.map((id) => [
      id,
      potsOf(
        rows
          .filter((r) => r.partnerUserId === id)
          .map((r) => ({
            kind: r.kind,
            cycleId: r.cycleId,
            amountEgp: r._sum.amountEgp ?? 0,
          })),
      ),
    ]),
  );
}

/** One partner's pots. */
export async function accountPotsOf(
  db: Db,
  partnerUserId: string,
): Promise<Pots> {
  return (await accountPots(db, [partnerUserId])).get(partnerUserId)!;
}

/**
 * Refuse drawing `amount` into a cycle beyond what that cycle can draw: its
 * own advances and untied money (owner 2026-10-26). When money advanced for
 * other cycles is what would have covered it, the refusal says so
 * (`ACCOUNT_MONEY_FOR_OTHER_CYCLE`); with nothing elsewhere it is the plain
 * `ACCOUNT_BALANCE_TOO_LOW`.
 */
export function assertCycleCovers(args: {
  pots: Pots;
  cycleId: string;
  cycleCode: string;
  amount: Prisma.Decimal;
  partner: string;
}) {
  const available = availableTo(args.pots, args.cycleId);
  if (args.amount.lte(available)) return;
  const elsewhere = potsTotal(args.pots).sub(available);
  if (elsewhere.lte(0)) {
    assertCovers({
      balance: available,
      amount: args.amount,
      partner: args.partner,
    });
  }
  const short = args.amount.sub(available);
  throw badRequest(
    'ACCOUNT_MONEY_FOR_OTHER_CYCLE',
    `${args.partner} has ${formatMoney(available)} EGP that ${args.cycleCode} can draw; ` +
      `the other ${formatMoney(elsewhere)} EGP in his account was paid for other cycles and funds only those. ` +
      `Record a payment of ${formatMoney(short)} EGP for ${args.cycleCode} first.`,
    {
      partner: args.partner,
      cycle: args.cycleCode,
      available: formatMoney(available),
      elsewhere: formatMoney(elsewhere),
      amount: formatMoney(args.amount),
      short: formatMoney(short),
    },
  );
}

/**
 * Refuse taking `amount` of untied money — a withdrawal, or a settlement's
 * reversal taking a payout left in back out — beyond what is untied. An
 * advance paid a supplier for a cycle; it is not money to take out
 * (`ACCOUNT_MONEY_TIED_TO_CYCLES`, GUESS 2026-10-26).
 */
export function assertUntiedCovers(args: {
  pots: Pots;
  amount: Prisma.Decimal;
  partner: string;
}) {
  const available = untiedAvailable(args.pots);
  if (args.amount.lte(available)) return;
  const tied = potsTotal(args.pots).sub(available);
  if (tied.lte(0)) {
    assertCovers({
      balance: available,
      amount: args.amount,
      partner: args.partner,
    });
  }
  throw badRequest(
    'ACCOUNT_MONEY_TIED_TO_CYCLES',
    `${args.partner}'s account holds ${formatMoney(available)} EGP tied to no cycle; ` +
      `the other ${formatMoney(tied)} EGP was paid for cycles and funds only them. ` +
      `${formatMoney(args.amount)} EGP cannot be taken from it.`,
    {
      partner: args.partner,
      available: formatMoney(available),
      tied: formatMoney(tied),
      amount: formatMoney(args.amount),
    },
  );
}

/**
 * Hold these partners' accounts until the transaction ends, in one order so
 * two writers never wait on each other crosswise. Two withdrawals of 600
 * against 1,000 sent at once would otherwise both read 1,000 and both pass.
 */
export async function lockAccounts(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  partnerUserIds: string[],
) {
  for (const id of [...new Set(partnerUserIds)].sort()) {
    await db.$queryRaw`SELECT id FROM partners WHERE user_id = ${id}::uuid FOR UPDATE`;
  }
}

/**
 * Refuse taking `amount` from an account holding `balance`: an account never
 * goes negative (owner 2026-10-25). The partner pays the rest in as an advance
 * first.
 */
export function assertCovers(args: {
  balance: Prisma.Decimal;
  amount: Prisma.Decimal;
  partner: string;
}) {
  if (args.amount.lte(args.balance)) return;
  throw badRequest(
    'ACCOUNT_BALANCE_TOO_LOW',
    `${args.partner}'s account holds ${formatMoney(args.balance)} EGP; ` +
      `${formatMoney(args.amount)} EGP cannot be taken from it. ` +
      `Record an advance of ${formatMoney(args.amount.sub(args.balance))} EGP first.`,
    {
      partner: args.partner,
      balance: formatMoney(args.balance),
      amount: formatMoney(args.amount),
      short: formatMoney(args.amount.sub(args.balance)),
    },
  );
}

/**
 * Equal shares of `total` among `count` partners, to the piastre: each share
 * rounded down, the last one taking the residual, so the shares re-sum to the
 * total exactly (CLAUDE.md §10) — thirds of 1,000.00 are 333.33, 333.33,
 * 333.34. The same rule as the cycle page's Split equally
 * (`apps/web/src/lib/funding-split.ts`). Refuses a total of zero or less, or
 * no partner to share it: rounding never decides who gets the money.
 */
export function equalShares(
  total: Prisma.Decimal.Value,
  count: number,
): Prisma.Decimal[] {
  const cents = new Prisma.Decimal(total).mul(100);
  if (count <= 0 || !cents.isInteger() || cents.lte(0)) {
    throw new Error(`Cannot split ${String(total)} among ${count}`);
  }
  const each = cents.divToInt(count);
  return Array.from({ length: count }, (_, i) =>
    (i === count - 1 ? cents.sub(each.mul(count - 1)) : each).div(100),
  );
}

/**
 * The Funding card's contributions (owner 2026-10-26, from the sample): each
 * core partner's share, what this cycle can draw for him, and whether that
 * covers what he still has to put in.
 *
 * **The partners' part** is what funds the cycle less investors' money —
 * theirs is their own (§8). What funds the cycle (GUESS 2026-10-26): the
 * funding target in pounds when one is set and it is not below the cost to
 * fund; otherwise the cost to fund (`CostingService.fundingFor`, the figure
 * Split equally divides).
 *
 * On a cycle a friend paid, once the partners have repaid him anything
 * (DECIDED 2026-10-26, owner: "it shows we paid 64,460.76, while its
 * 67,056.33"), the cost to fund is replaced by what was put in, in pounds:
 * **what was repaid him, or everything contributed to the cycle when that is
 * more** (`REPAID` / `PUT_IN`, DECIDED 2026-10-27 — owner: "Each partner's
 * share of the cycle? something looks off"). Repaid alone was wrong as soon
 * as part of his loan stayed in as an investment: CYC-2026-0001's 60,000 of
 * Ahmad Eraiby's was never part of the 141,168.92 repaid, yet came off it
 * again as investors' money — 61,168.92 for partners who put in 121,168.99.
 * Every contribution is capital the settlement hands back, so together they
 * are the money funding the cycle; the repaid figure stays the floor while
 * contributions are still being entered. A target still wins when it is set
 * and not below that figure (GUESS).
 *
 * **Each share** (DECIDED 2026-10-27): when every core partner's contribution
 * is entered (above zero) and together they make up the partners' part to the
 * piastre, each share is what he contributed — **as agreed** (`agreed`), so
 * 55,000 / 33,084.50 / 33,084.49 reads as covered, not as one over and two
 * short of an equal third. Otherwise equal shares are the suggestion
 * (`equalShares`, the last partner taking the odd piastre); nothing to split
 * gives every share zero rather than letting rounding pick (CLAUDE.md §10).
 *
 * What a partner still has to give is his share less what he has already
 * contributed, never below zero; `cover` is what the cycle can draw for him
 * less that — covered, with that much left over, at zero or more; short by
 * its size below zero.
 */
/** What the Funding card's partners' part is of. */
export type ShareBasis = 'TARGET' | 'COST_TO_FUND' | 'REPAID' | 'PUT_IN';

export function contributionShares(args: {
  targetEgp: Prisma.Decimal.Value | null;
  toFundEgp: Prisma.Decimal.Value;
  /** What the partners repaid friends on this cycle, in pounds; above zero replaces the cost to fund. */
  repaidEgp?: Prisma.Decimal.Value;
  investorsEgp: Prisma.Decimal.Value;
  partners: {
    availableEgp: Prisma.Decimal.Value;
    contributionEgp: Prisma.Decimal.Value;
  }[];
}): {
  basis: ShareBasis;
  ofEgp: Prisma.Decimal;
  partnersEgp: Prisma.Decimal;
  /** Each share is that partner's own contribution: all entered, and they make up the partners' part. */
  agreed: boolean;
  lines: {
    share: Prisma.Decimal;
    stillToGive: Prisma.Decimal;
    cover: Prisma.Decimal;
  }[];
} {
  const zero = new Prisma.Decimal(0);
  const investors = new Prisma.Decimal(args.investorsEgp);
  const partnersIn = args.partners.reduce(
    (s, p) => s.add(Prisma.Decimal.max(p.contributionEgp, 0)),
    zero,
  );
  const repaid = new Prisma.Decimal(args.repaidEgp ?? 0);
  const byRepaid = repaid.gt(0);
  // Everything put into the cycle: every participant's contribution.
  const putIn = partnersIn.add(Prisma.Decimal.max(investors, 0));
  const byPutIn = byRepaid && putIn.gt(repaid);
  const toFund = byPutIn
    ? putIn
    : byRepaid
      ? repaid
      : new Prisma.Decimal(args.toFundEgp);
  const target =
    args.targetEgp === null ? null : new Prisma.Decimal(args.targetEgp);
  const byTarget = target !== null && target.gt(0) && target.gte(toFund);
  const ofEgp = byTarget ? target : toFund;
  const partnersEgp = Prisma.Decimal.max(
    ofEgp.sub(investors).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN),
    0,
  );
  const agreed =
    partnersEgp.gt(0) &&
    args.partners.length > 0 &&
    args.partners.every((p) => new Prisma.Decimal(p.contributionEgp).gt(0)) &&
    partnersIn.toDecimalPlaces(2).equals(partnersEgp);
  const shares = agreed
    ? args.partners.map((p) => new Prisma.Decimal(p.contributionEgp))
    : partnersEgp.gt(0) && args.partners.length > 0
      ? equalShares(partnersEgp, args.partners.length)
      : args.partners.map(() => zero);
  return {
    basis: byTarget
      ? 'TARGET'
      : byPutIn
        ? 'PUT_IN'
        : byRepaid
          ? 'REPAID'
          : 'COST_TO_FUND',
    ofEgp,
    partnersEgp,
    agreed,
    lines: args.partners.map((p, i) => {
      const share = shares[i];
      const stillToGive = Prisma.Decimal.max(share.sub(p.contributionEgp), 0);
      return {
        share,
        stillToGive,
        cover: new Prisma.Decimal(p.availableEgp).sub(stillToGive),
      };
    }),
  };
}

/**
 * What one partner has put into a cycle so far (DECIDED 2026-10-26, owner:
 * "a bit confusing, seeing funding zero, while each one of us clearly paid
 * 67,056.33 to ahmad"): his contribution on it, plus his advances on it not
 * yet drawn into a contribution. A drawn advance is inside the contribution
 * already and is never counted twice — `undrawnAdvancesEgp` is the cycle's
 * pot (`potsOf`), which is advances less what contributions drew.
 *
 * The contribution splits into what was drawn from his account
 * (`fromAccountEgp`, his CONTRIBUTION movements on the cycle) and what was
 * entered directly (`enteredEgp`: the rest — Enter amounts, Split equally;
 * on a cycle a friend paid, his share of repaying the friend). A contribution
 * lowered by hand below what the account gave reads entered 0, drawn the
 * whole contribution — never a negative part.
 */
export function putInSoFar(args: {
  contributionEgp: Prisma.Decimal.Value;
  fromAccountEgp: Prisma.Decimal.Value;
  undrawnAdvancesEgp: Prisma.Decimal.Value;
}): {
  totalEgp: Prisma.Decimal;
  enteredEgp: Prisma.Decimal;
  fromAccountEgp: Prisma.Decimal;
  undrawnAdvancesEgp: Prisma.Decimal;
} {
  const zero = new Prisma.Decimal(0);
  const contribution = Prisma.Decimal.max(args.contributionEgp, zero);
  const fromAccount = Prisma.Decimal.min(
    Prisma.Decimal.max(args.fromAccountEgp, zero),
    contribution,
  );
  const undrawn = Prisma.Decimal.max(args.undrawnAdvancesEgp, zero);
  return {
    totalEgp: contribution.add(undrawn),
    enteredEgp: contribution.sub(fromAccount),
    fromAccountEgp: fromAccount,
    undrawnAdvancesEgp: undrawn,
  };
}

/**
 * What a funding target's progress reads in the target's own currency
 * ("1,600 of 2,000 USD funded so far"). An advance paid in the target's
 * currency counts at its face amount; one in another currency counts its
 * pounds at the target's rate. GUESS (2026-10-25), see BUSINESS_LOGIC §8.
 */
export function inTargetCurrency(
  advance: {
    currency: string;
    amount: Prisma.Decimal.Value;
    amountEgp: Prisma.Decimal.Value;
  },
  target: { currency: string; rate: Prisma.Decimal.Value },
): Prisma.Decimal {
  if (advance.currency === target.currency) {
    return new Prisma.Decimal(advance.amount);
  }
  return new Prisma.Decimal(advance.amountEgp)
    .div(target.rate)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
