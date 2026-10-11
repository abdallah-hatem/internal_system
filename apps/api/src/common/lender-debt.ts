// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';
import { owedOn } from './lender-math';

/**
 * What a cycle owes friends who paid its suppliers (BUSINESS_LOGIC §18), read
 * once for everyone who asks: the settlement gate, the cycle's "Paid by a
 * friend" panel, the costing's "to fund" figure, cycle profit and the
 * dashboard (CLAUDE.md rule 11).
 *
 * Only standing rows count: a removed financing owes nothing, and a reversed
 * repayment cleared nothing.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

type Db = Pick<Prisma.TransactionClient, 'lenderFinancing' | 'lenderRepayment'>;

export const STANDING_FINANCING = { removedAt: null } as const;
export const STANDING_REPAYMENT = { reversedAt: null } as const;

export interface LenderOwed {
  lenderId: string;
  lender: string;
  currency: string;
  owed: Prisma.Decimal;
}

/** Each friend this cycle still owes, per currency. Nothing owed is left out. */
export async function owedOnCycle(
  db: Pick<Prisma.TransactionClient, 'lenderFinancing'>,
  cycleId: string,
): Promise<LenderOwed[]> {
  const financings = await db.lenderFinancing.findMany({
    where: { cycleId, ...STANDING_FINANCING },
    select: {
      amount: true,
      currency: true,
      lender: { select: { id: true, name: true } },
      repayments: { where: STANDING_REPAYMENT, select: { cleared: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const byKey = new Map<string, LenderOwed>();
  for (const f of financings) {
    const owed = owedOn(f.amount, f.repayments);
    if (owed.lte(0)) continue;
    const key = `${f.lender.id}:${f.currency}`;
    const row = byKey.get(key) ?? {
      lenderId: f.lender.id,
      lender: f.lender.name,
      currency: f.currency,
      owed: D(0),
    };
    row.owed = row.owed.add(owed);
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/** "Ahmed 12,000.00 AED; Sami 500.00 AED" — for a refusal's English and params. */
export function describeOwed(rows: readonly LenderOwed[]): string {
  return rows
    .map((r) => `${r.lender} ${formatMoney(r.owed)} ${r.currency}`)
    .join('; ');
}

/**
 * A cycle cannot settle while it still owes a friend (§18). Its profit is not
 * known until the exchange difference is, and the partners would otherwise
 * split money that still has to go to him.
 *
 * Called beside `assertShipmentAccounted` by both routes into SETTLEMENT: the
 * plain transition and settlement `approve`.
 */
export async function assertLendersRepaid(
  db: Pick<Prisma.TransactionClient, 'lenderFinancing'>,
  cycleId: string,
  cycleCode: string,
) {
  const owed = await owedOnCycle(db, cycleId);
  if (owed.length === 0) return;
  const text = describeOwed(owed);
  throw badRequest(
    'LENDER_DEBT_OUTSTANDING',
    `Cycle ${cycleCode} cannot be settled while it still owes: ${text}. Repay them first.`,
    { cycle: cycleCode, owed: text },
  );
}

/**
 * What friends paid towards this cycle's orders, in pounds at each order's
 * rate. The partners and investors fund the rest (§18, "Split equally").
 */
export async function cycleFinancedEgp(
  db: Pick<Prisma.TransactionClient, 'lenderFinancing'>,
  cycleId: string,
): Promise<Prisma.Decimal> {
  const { _sum } = await db.lenderFinancing.aggregate({
    where: { cycleId, ...STANDING_FINANCING },
    _sum: { amountEgp: true },
  });
  return D(_sum.amountEgp);
}

/**
 * The exchange difference on repayments, in EGP: positive is a cost (the
 * dirham rose since the order), negative a gain (§18).
 *
 * Not a ledger row — the ledger shows the pounds leaving — so settlement,
 * cycle profit and the dashboard each read it here, the same way they read
 * losses through `cycleLossesEgp` (§9). `cycleId` null is every cycle: the
 * dashboard's net profit.
 */
export async function exchangeDifferenceEgp(
  db: Pick<Db, 'lenderRepayment'>,
  cycleId: string | null,
): Promise<Prisma.Decimal> {
  const { _sum } = await db.lenderRepayment.aggregate({
    where: {
      ...STANDING_REPAYMENT,
      financing: {
        ...STANDING_FINANCING,
        ...(cycleId === null ? {} : { cycleId }),
      },
    },
    _sum: { exchangeDiffEgp: true },
  });
  return D(_sum.exchangeDiffEgp);
}
