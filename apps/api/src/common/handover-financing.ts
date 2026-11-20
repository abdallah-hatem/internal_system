// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { badRequest } from './api-error';
import { formatMoney } from './money';
import { STANDING_REPAYMENT } from './lender-debt';

/**
 * Freight a partner paid himself for a UAE handover (BUSINESS_LOGIC §18, §9 —
 * owner 2026-11-20: "sometimes one of us pays lets say 4000 AED for a
 * shipment then when we have to split and return him some money the exchange
 * rate changes"). GUESS, the recommended option.
 *
 * He is treated exactly as a friend who paid a supplier (§18): what the
 * business owes him is held in the handover's currency (AED), repaid later in
 * pounds at that day's rate, and the difference from the rate on the handover
 * day is an exchange gain or loss on the cycle, shared by everyone by the
 * split. So it is a lender's payment — a `LenderFinancing` naming the
 * handover instead of an order — on a lender record that is his
 * (`Lender.partnerUserId`), made here the first time and reused after. Every
 * reader of a friend's debt (`common/lender-debt.ts`: what is owed, the
 * settlement gate, the exchange difference and its breakdown, the funding
 * card, Analytics) then counts it with no second definition (rule 11), and
 * repaying him is the lender's own repayment (`LendersService.repay`, the
 * `lender-math` arithmetic).
 *
 * The ledger is a friend's too: money in (`lender_financing`) on the handover
 * day — the freight is booked out with the goods at receipt as every leg's
 * cost is, and this says whose money paid it — and money out on each
 * repayment. No business cash left on the day he paid.
 */

type Db = Prisma.TransactionClient;

/** His lender record: found by his user, made (named as on the Partners page) the first time. */
async function partnerLender(
  tx: Db,
  partner: { id: string; name: string },
  actorId: string,
) {
  const found = await tx.lender.findUnique({
    where: { partnerUserId: partner.id },
  });
  if (found) {
    // A record deleted while nothing was owed comes back: it is still him.
    if (found.deletedAt) {
      return tx.lender.update({
        where: { id: found.id },
        data: { deletedAt: null },
      });
    }
    return found;
  }
  return tx.lender.create({
    data: {
      name: partner.name,
      partnerUserId: partner.id,
      notes: 'A partner: freight he paid himself for handovers.',
      createdBy: actorId,
    },
  });
}

/** Record that `partner` paid this handover's freight: the business owes it to him, in its currency. */
export async function recordPartnerFreightIn(
  tx: Db,
  input: {
    handoverId: string;
    cycleId: string;
    partner: { id: string; name: string };
    currency: string;
    amount: Prisma.Decimal;
    rate: Prisma.Decimal;
    amountEgp: Prisma.Decimal;
    /** The handover day, YYYY-MM-DD. */
    day: string;
    actorId: string;
  },
) {
  const lender = await partnerLender(tx, input.partner, input.actorId);
  const id = randomUUID();
  const paidOn = new Date(`${input.day}T00:00:00Z`);
  const ledger = await tx.financialTransaction.create({
    data: {
      type: 'LENDER_FINANCING',
      category: 'lender_financing',
      direction: 'INFLOW',
      amount: input.amountEgp,
      currency: 'EGP',
      fxRateToEgp: input.rate,
      ...(input.currency !== 'EGP'
        ? { originalAmount: input.amount, originalCurrency: input.currency }
        : {}),
      cycleId: input.cycleId,
      relatedType: 'LENDER_FINANCING',
      relatedId: id,
      reason: `${input.partner.name} paid ${formatMoney(input.amount)} ${input.currency} of freight handed over on ${input.day}`,
      occurredOn: paidOn,
      createdBy: input.actorId,
    },
  });
  return tx.lenderFinancing.create({
    data: {
      id,
      lenderId: lender.id,
      departureId: input.handoverId,
      cycleId: input.cycleId,
      currency: input.currency,
      amount: input.amount,
      fxRateToEgp: input.rate,
      amountEgp: input.amountEgp,
      paidOn,
      createdBy: input.actorId,
      ledgerTransactionId: ledger.id,
    },
  });
}

/**
 * Take back what the business owed him for a handover's freight — the
 * handover undone, its freight or payer corrected. Only while nothing of it
 * was repaid (`FINANCING_HAS_REPAYMENTS`, as removing a friend's payment):
 * reverse those repayments first. The ledger inflow is balanced on its own
 * day and the row is kept, marked removed, as a friend's is (§9).
 */
export async function removePartnerFreightIn(
  tx: Db,
  handoverId: string,
  reason: string,
  actorId: string,
) {
  const f = await tx.lenderFinancing.findFirst({
    where: { departureId: handoverId, removedAt: null },
    include: {
      repayments: { where: STANDING_REPAYMENT, select: { id: true } },
      lender: { select: { name: true } },
    },
  });
  if (!f) return null;
  if (f.repayments.length > 0) {
    throw badRequest(
      'FINANCING_HAS_REPAYMENTS',
      `${f.lender.name} has been repaid on this; reverse those repayments before removing it.`,
      { lender: f.lender.name, repayments: f.repayments.length },
    );
  }
  const balancing = await tx.financialTransaction.create({
    data: {
      type: 'LENDER_FINANCING',
      category: 'lender_financing',
      direction: 'OUTFLOW',
      amount: f.amountEgp,
      currency: 'EGP',
      fxRateToEgp: f.fxRateToEgp,
      cycleId: f.cycleId,
      relatedType: 'LENDER_FINANCING',
      relatedId: f.id,
      reversalOfId: f.ledgerTransactionId,
      reason: `Removed: ${reason}`,
      occurredOn: f.paidOn,
      createdBy: actorId,
    },
  });
  await tx.lenderPlan.updateMany({
    where: { financingId: f.id, status: 'ACTIVE' },
    data: { status: 'CANCELLED', cancelReason: reason },
  });
  return tx.lenderFinancing.update({
    where: { id: f.id },
    data: {
      removedAt: new Date(),
      removedBy: actorId,
      removalReason: reason,
      removalTransactionId: balancing.id,
      // Let go of the handover, which may be deleted next; the reason says
      // which it was.
      departureId: null,
    },
  });
}
