// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';
import {
  accountPotsOf,
  lockAccounts,
  untiedAvailable,
} from './partner-account';

/**
 * "Paid by" on an expense (BUSINESS_LOGIC §9, owner 2026-10-26, built
 * 2026-10-27). Fuel for a delivery, paid from a partner's own pocket:
 *
 * - **the same expense** — its ledger row is written as any manual expense is,
 *   so it is an operating expense, a cycle's cost when charged to one, or a
 *   running cost shared from payouts, exactly as if the business had paid;
 * - **no business cash** — the row names him (`paidByUserId`), and
 *   `CASH_ROWS_WHERE` (`common/cash-position.ts`) leaves such rows out of
 *   cash in, cash out and cash on hand;
 * - **his account is credited** with it — an `EXPENSE_PAID` movement pointing
 *   at the row (`expenseEntryId`, one per row): untied money the business owes
 *   him back, which he takes out or leaves in for a contribution.
 *
 * Reversing the expense reverses the credit in the same transaction, and
 * never when his account no longer holds it (`EXPENSE_CREDIT_ALREADY_TAKEN`).
 */

type Db = Prisma.TransactionClient;

/** The payer is not a core partner: an investor, the office, nobody. */
export function payerNotPartner() {
  return badRequest(
    'LEDGER_PAYER_NOT_PARTNER',
    'An expense can be paid by the business or by one of the core partners; that is neither.',
  );
}

/**
 * The payer: an active core partner with a partner record. Anyone else — an
 * investor, the office's support login, an id that is nobody, a partner who
 * has left — is refused, coded; never a foreign key failing as a 500.
 */
export async function expensePayer(
  db: Pick<Db, 'user'>,
  userId: string,
): Promise<{ id: string; name: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      email: true,
      partner: { select: { displayName: true, active: true } },
    },
  });
  if (!user || user.role !== 'CORE_PARTNER' || !user.partner) {
    throw payerNotPartner();
  }
  const name = user.partner.displayName ?? user.email;
  if (user.status !== 'ACTIVE' || !user.partner.active) {
    throw badRequest(
      'LEDGER_PAYER_INACTIVE',
      `${name} is no longer an active partner; an expense cannot be recorded as paid by him.`,
      { partner: name },
    );
  }
  return { id: user.id, name };
}

/** Credit his account with the expense he paid: the business owes it back. */
export async function creditExpensePaid(
  tx: Db,
  entry: {
    id: string;
    amount: Prisma.Decimal;
    originalAmount: Prisma.Decimal | null;
    originalCurrency: string | null;
    fxRateToEgp: Prisma.Decimal | null;
    occurredOn: Date | null;
    category: string;
    reason: string | null;
  },
  payerId: string,
  actorId: string,
) {
  await lockAccounts(tx, [payerId]);
  return tx.partnerAccountMovement.create({
    data: {
      partnerUserId: payerId,
      kind: 'EXPENSE_PAID',
      amountEgp: entry.amount,
      amount: entry.originalAmount ?? entry.amount,
      currency: entry.originalCurrency ?? 'EGP',
      fxRateToEgp: entry.fxRateToEgp ?? 1,
      occurredOn: entry.occurredOn ?? new Date(),
      expenseEntryId: entry.id,
      note: entry.reason,
      createdBy: actorId,
    },
  });
}

/**
 * Take the credit back out as the expense is reversed. His account must
 * still hold it as untied money: if he has already taken it out, or drawn it
 * into a cycle, the expense cannot be undone until that is (GUESS
 * 2026-10-27; an account never goes negative, owner 2026-10-25). Returns
 * false when the expense carries no standing credit to undo.
 */
export async function undoExpenseCredit(
  tx: Db,
  entryId: string,
  reason: string,
  actorId: string,
): Promise<{ partnerUserId: string; amountEgp: Prisma.Decimal } | null> {
  const credit = await tx.partnerAccountMovement.findUnique({
    where: { expenseEntryId: entryId },
    select: { id: true, partnerUserId: true },
  });
  if (!credit) return null;
  await lockAccounts(tx, [credit.partnerUserId]);
  // Read again under the lock: a second reversal racing this one waits here
  // and then finds the credit already undone.
  const m = await tx.partnerAccountMovement.findUniqueOrThrow({
    where: { id: credit.id },
    include: {
      partner: {
        select: { email: true, partner: { select: { displayName: true } } },
      },
    },
  });
  if (m.reversedAt) {
    throw badRequest(
      'ENTRY_ALREADY_REVERSED',
      `This entry was already reversed on ${m.reversedAt
        .toISOString()
        .slice(0, 10)}. Reversing again would double-count the correction.`,
      { date: m.reversedAt.toISOString().slice(0, 10) },
    );
  }
  const available = untiedAvailable(await accountPotsOf(tx, m.partnerUserId));
  if (m.amountEgp.gt(available)) {
    const partner = m.partner.partner?.displayName ?? m.partner.email;
    throw badRequest(
      'EXPENSE_CREDIT_ALREADY_TAKEN',
      `${partner}'s account was credited ${formatMoney(m.amountEgp)} EGP for this expense, ` +
        `but now holds ${formatMoney(available)} EGP he can take out — he has already withdrawn it ` +
        'or drawn it into a cycle. Reverse that first, then this expense.',
      {
        partner,
        amount: formatMoney(m.amountEgp),
        available: formatMoney(available),
      },
    );
  }
  await tx.partnerAccountMovement.update({
    where: { id: m.id },
    data: {
      reversedAt: new Date(),
      reversedBy: actorId,
      reversalReason: reason.trim(),
    },
  });
  return { partnerUserId: m.partnerUserId, amountEgp: m.amountEgp };
}
