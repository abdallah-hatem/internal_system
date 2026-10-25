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
 *   − a contribution to a cycle, drawn from the account;
 *   − money he took out.
 *
 * One definition (CLAUDE.md §11): the Partners page, the cycle's funding
 * panel, a contribution's check, a withdrawal's check, a reversal's check and
 * a settlement's reversal all read the balance here, never their own sum.
 *
 * What it is NOT (CLAUDE.md §11): none of it is a ledger row. An advance went
 * straight to a supplier, so it is not cash in the business, not income, and
 * not a cost (the goods are costed at receipt as always). The cash event is
 * the contribution — his money entering the cycle — which posts the same
 * `contribution` row an entered contribution always has
 * (`common/contribution-ledger.ts`). So cash on hand, profit and analytics
 * cannot move on an advance, a withdrawal or a payout left in.
 */

export type MovementKind =
  'ADVANCE' | 'PAYOUT_LEFT_IN' | 'CONTRIBUTION' | 'WITHDRAWAL';

/** Which way each kind moves his balance. */
export const MOVEMENT_SIGN: Record<MovementKind, 1 | -1> = {
  ADVANCE: 1,
  PAYOUT_LEFT_IN: 1,
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
