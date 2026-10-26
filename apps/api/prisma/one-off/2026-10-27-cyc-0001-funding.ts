/**
 * One-off correction, owner 2026-10-27: who really funded CYC-2026-0001.
 *
 * The owner's facts: the cycle's 201,168.99 EGP was funded by Abdallah 55,000,
 * Ahmad Eraiby as a temporary investor 60,000, Mohammed Setta (temporary
 * investor) 20,000, and Shady and Fares the rest equally — 33,084.50 and
 * 33,084.49. Eraiby's 60,000 is part of his loan that stayed in the cycle as
 * his investment: he was repaid 141,168.99 EGP, not 201,168.99. Abdallah's and
 * Setta's money went into repaying him.
 *
 *   DATABASE_URL=…/motorcycle_parts_prodcopy JWT_SECRET=… \
 *     npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-27-cyc-0001-funding.ts [--plan] [--production]
 *
 *   --plan        checks the starting facts, prints the change; writes nothing
 *   --production  required for any database other than the local copy
 *
 * How it is recorded (BUSINESS_LOGIC §18, GUESS 2026-10-27): the 60,000 stayed
 * in at the 15 October repayment, at that repayment's rate, 14.9. So his loan
 * shrinks by 60,000 ÷ 14.9 = 4,026.85 AED, to 9,878.84 AED, and the 15 October
 * repayment is what pays the rest off: 608.38 AED, which at 14.9 is 9,064.86
 * EGP — the service's own "pays it off" figure. (9,064.93, i.e. 69,064.93 −
 * 60,000, cannot be recorded: no two-place AED amount is worth exactly that at
 * 14.9. The 0.07 is 4,026.85 AED being worth 60,000.07 at 14.9.)
 *
 * Every step goes through the app's own services, and each is skipped when
 * already done, so a run that stopped part way is finished by running it again:
 *   1. UsersService.create — TEMP_INVESTOR accounts for Ahmad Eraiby and
 *      Mohammed Setta (placeholder emails, a random password never printed;
 *      investors do not sign in to the office); an existing one is reused;
 *   2. LendersService.reverseRepayment ×3, removeFinancing — the old financing
 *      (13,905.69 AED) and its three repayments, with a reason;
 *   3. LendersService.finance — 9,878.84 AED at 13.9066 on 2026-07-15, same
 *      lender, order and note; then repay ×3 with the original days and rates;
 *   4. CyclesService.updateParticipant — the three partners' contributions,
 *      by hand as the participant form does (no partner account is touched);
 *      CyclesService.addParticipant — the two investors, no fee, no split.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { UsersService } from '../../src/modules/users/users.service';
import { LendersService } from '../../src/modules/lenders/lenders.service';
import { CyclesService } from '../../src/modules/cycles/cycles.service';
import { PartnerAccountsService } from '../../src/modules/partner-accounts/partner-accounts.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { PushService } from '../../src/modules/notifications/push.service';
import {
  owedOn,
  settlingEgp,
  financingAmountEgp,
} from '../../src/common/lender-math';
import {
  profitSplitView,
  profitShareOf,
} from '../../src/modules/settlements/settlement-math';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const CYCLE = 'CYC-2026-0001';
const PO = 'PO-2026-0001';
const LENDER_ID = '865da837-57cc-48e5-b771-f55fc069d9ca';
const OLD_FINANCING_ID = 'b9e381d3-87bf-4689-82a7-32d611c18ae7';
const OLD = { amount: '13905.69', rate: '13.9066', paidOn: '2026-07-15' };
const OLD_REPAYMENTS = [
  { paidOn: '2026-08-15', amountEgp: '64893.22', rate: '14.0000' },
  { paidOn: '2026-09-15', amountEgp: '67210.84', rate: '14.5000' },
  { paidOn: '2026-10-15', amountEgp: '69064.93', rate: '14.9000' },
];
/** 13,905.69 − 60,000 ÷ 14.9 (4,026.85, half up). */
const NEW = { amount: '9878.84', rate: '13.9066', paidOn: '2026-07-15' };
const NEW_REPAYMENTS = [
  { paidOn: '2026-08-15', amountEgp: '64893.22', rate: '14.0000' },
  { paidOn: '2026-09-15', amountEgp: '67210.84', rate: '14.5000' },
  // The pay-off figure the service quotes (608.38 AED × 14.9); checked
  // against `quote` before it is recorded.
  { paidOn: '2026-10-15', amountEgp: '9064.86', rate: '14.9000' },
];
const REPAYMENT_NOTE =
  "Ahmad Eraiby's other 60,000 EGP stayed in the cycle as his investment (owner, 2026-10-27).";
const REVERSE_REASON =
  'Corrected: 60,000 EGP of his loan stayed in the cycle as his investment; recorded again on a smaller loan (owner, 2026-10-27)';
const REMOVE_REASON =
  'Corrected: his loan is 60,000 EGP (4,026.85 AED at 14.9) smaller, that part being his investment in the cycle (owner, 2026-10-27)';

const CORE = [
  { key: 'abdallah', contribution: '55000.00' },
  { key: 'shady', contribution: '33084.50' },
  { key: 'fares', contribution: '33084.49' },
] as const;
const OLD_CORE_CONTRIBUTION = '67056.33';
const INVESTORS = [
  {
    name: 'Ahmad Eraiby',
    email: 'eraiby.investor@motoparts.invalid',
    contribution: '60000.00',
  },
  {
    name: 'Mohammed Setta',
    email: 'setta.investor@motoparts.invalid',
    contribution: '20000.00',
  },
] as const;

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const money = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(2);
const rate4 = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(4);
const day = (d: Date) => d.toISOString().slice(0, 10);

type App = INestApplicationContext;

async function state(app: App) {
  const db = app.get(PrismaService);
  const cycle = await db.importCycle.findFirst({
    where: { code: CYCLE },
    select: { id: true, status: true },
  });
  if (!cycle) throw new Error(`${CYCLE} not found.`);
  const po = await db.purchaseOrder.findFirst({
    where: { reference: PO, cycleId: cycle.id },
    select: { id: true },
  });
  if (!po) throw new Error(`${PO} not found on ${CYCLE}.`);
  const settlements = await db.settlement.findMany({
    where: { cycleId: cycle.id, status: { not: 'REVERSED' } },
    select: { status: true },
  });
  const financings = await db.lenderFinancing.findMany({
    where: { cycleId: cycle.id },
    include: {
      lender: { select: { name: true } },
      repayments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
    },
    orderBy: { createdAt: 'asc' },
  });
  const old = financings.find((f) => f.id === OLD_FINANCING_ID) ?? null;
  const standing = financings.filter((f) => f.removedAt === null);
  const person = {
    select: {
      id: true,
      email: true,
      role: true,
      partner: { select: { displayName: true } },
    },
  } as const;
  const participants = await db.cycleParticipant.findMany({
    where: { cycleId: cycle.id },
    include: { partner: person, investor: person },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  // An investor's account: the placeholder email, or a temporary investor
  // already carrying the name (reused rather than made twice).
  const investorUsers = await Promise.all(
    INVESTORS.map(async (inv) => {
      const found = await db.user.findMany({
        where: {
          OR: [
            { email: inv.email },
            {
              role: 'TEMP_INVESTOR',
              partner: {
                displayName: { equals: inv.name, mode: 'insensitive' },
              },
            },
          ],
        },
        select: { id: true, email: true, role: true, status: true },
      });
      return { ...inv, found };
    }),
  );
  return {
    cycle,
    po,
    settlements,
    financings,
    old,
    standing,
    participants,
    investorUsers,
  };
}
type State = Awaited<ReturnType<typeof state>>;

const isNew = (f: State['financings'][number]) =>
  f.removedAt === null &&
  f.lenderId === LENDER_ID &&
  money(f.amount) === NEW.amount &&
  rate4(f.fxRateToEgp) === NEW.rate &&
  day(f.paidOn) === NEW.paidOn;

const coreOf = (s: State, key: string) =>
  s.participants.filter(
    (p) =>
      p.participantType === 'CORE_PARTNER' &&
      (p.partner?.email.toLowerCase().startsWith(`${key}@`) ||
        p.partner?.partner?.displayName.toLowerCase() === key),
  );

function check(s: State) {
  const problems: string[] = [];
  if (s.cycle.status !== 'SELLING')
    problems.push(`the cycle is ${s.cycle.status}, not SELLING`);
  if (s.settlements.length)
    problems.push(
      `settlements stand on it: ${s.settlements.map((x) => x.status).join(', ')}`,
    );
  if (!s.old)
    problems.push(`financing ${OLD_FINANCING_ID} is not on the cycle`);
  else {
    if (s.old.lenderId !== LENDER_ID)
      problems.push(`${OLD_FINANCING_ID} is not Ahmad Eraiby's`);
    if (s.old.purchaseOrderId !== s.po.id)
      problems.push(`${OLD_FINANCING_ID} is not on ${PO}`);
    if (
      money(s.old.amount) !== OLD.amount ||
      rate4(s.old.fxRateToEgp) !== OLD.rate ||
      day(s.old.paidOn) !== OLD.paidOn ||
      s.old.currency !== 'AED'
    )
      problems.push(
        `${OLD_FINANCING_ID} is ${money(s.old.amount)} ${s.old.currency} at ${rate4(s.old.fxRateToEgp)} on ${day(s.old.paidOn)}, not ${OLD.amount} AED at ${OLD.rate} on ${OLD.paidOn}`,
      );
    for (const r of s.old.repayments.filter((x) => x.reversedAt === null)) {
      const known = OLD_REPAYMENTS.find(
        (o) =>
          o.paidOn === day(r.paidOn) &&
          o.amountEgp === money(r.amountEgp) &&
          o.rate === rate4(r.rateToEgp),
      );
      if (!known)
        problems.push(
          `an unexpected standing repayment on the old financing: ${day(r.paidOn)} ${money(r.amountEgp)} @${rate4(r.rateToEgp)}`,
        );
    }
  }
  // No standing financing but the old one and (once made) the new one.
  for (const f of s.standing) {
    if (f.id === OLD_FINANCING_ID || isNew(f)) continue;
    problems.push(
      `an unexpected standing financing: ${f.lender.name} ${money(f.amount)} ${f.currency} at ${rate4(f.fxRateToEgp)} (${f.id})`,
    );
  }
  const news = s.standing.filter(isNew);
  if (news.length > 1) problems.push(`${news.length} new financings stand`);
  if (news.length === 1) {
    if (news[0].purchaseOrderId !== s.po.id)
      problems.push(`the new financing is not on ${PO}`);
    for (const r of news[0].repayments.filter((x) => x.reversedAt === null)) {
      const known = NEW_REPAYMENTS.find(
        (o) =>
          o.paidOn === day(r.paidOn) &&
          o.amountEgp === money(r.amountEgp) &&
          o.rate === rate4(r.rateToEgp),
      );
      if (!known)
        problems.push(
          `an unexpected repayment on the new financing: ${day(r.paidOn)} ${money(r.amountEgp)} @${rate4(r.rateToEgp)}`,
        );
    }
  }
  // Participants: the three partners and, once added, the two investors.
  for (const c of CORE) {
    const rows = coreOf(s, c.key);
    if (rows.length !== 1)
      problems.push(`${rows.length} core participants match "${c.key}", not 1`);
    else {
      const amt = money(rows[0].contributionAmount);
      if (amt !== c.contribution && amt !== OLD_CORE_CONTRIBUTION)
        problems.push(
          `${c.key}'s contribution is ${amt}, neither ${OLD_CORE_CONTRIBUTION} nor ${c.contribution}`,
        );
    }
  }
  const cores = s.participants.filter(
    (p) => p.participantType === 'CORE_PARTNER',
  );
  if (cores.length !== 3)
    problems.push(`${cores.length} core participants, not 3`);
  for (const p of s.participants) {
    if (p.customProfitPct !== null)
      problems.push(`a custom split is set (${p.id})`);
    if (p.participantType === 'TEMP_INVESTOR') {
      const ours = s.investorUsers.some((i) =>
        i.found.some((u) => u.id === p.investorUserId),
      );
      if (!ours)
        problems.push(
          `an unexpected investor on the cycle: ${p.investor?.email ?? p.investorUserId}`,
        );
      else if (p.investorFeePct !== null && !D(p.investorFeePct).isZero())
        problems.push(`investor ${p.investor?.email} has a fee`);
    }
  }
  for (const i of s.investorUsers) {
    if (i.found.length > 1)
      problems.push(
        `${i.found.length} accounts match ${i.name}: ${i.found.map((u) => u.email).join(', ')}`,
      );
    const u = i.found[0];
    if (u && (u.role !== 'TEMP_INVESTOR' || u.status !== 'ACTIVE'))
      problems.push(`${i.name}'s account ${u.email} is ${u.role} ${u.status}`);
    const rows = s.participants.filter((p) => u && p.investorUserId === u.id);
    if (
      rows.length === 1 &&
      money(rows[0].contributionAmount) !== i.contribution
    )
      problems.push(
        `${i.name} is on the cycle with ${money(rows[0].contributionAmount)}, not ${i.contribution}`,
      );
  }
  return problems;
}

function progress(s: State) {
  const news = s.standing.filter(isNew);
  const fresh = news[0] ?? null;
  const freshDays = new Set(
    (fresh?.repayments ?? [])
      .filter((r) => r.reversedAt === null)
      .map((r) => day(r.paidOn)),
  );
  return {
    users: s.investorUsers.map((i) => i.found[0] ?? null),
    oldStandingRepayments: (s.old?.repayments ?? []).filter(
      (r) => r.reversedAt === null,
    ),
    oldRemoved: !!s.old?.removedAt,
    fresh,
    repaymentsToMake: NEW_REPAYMENTS.filter((r) => !freshDays.has(r.paidOn)),
    coreToSet: CORE.map((c) => ({ ...c, row: coreOf(s, c.key)[0] })).filter(
      (c) => money(c.row.contributionAmount) !== c.contribution,
    ),
    investorsToAdd: s.investorUsers.filter(
      (i) =>
        !i.found[0] ||
        !s.participants.some((p) => p.investorUserId === i.found[0].id),
    ),
  };
}

async function figures(app: App, s: State) {
  const db = app.get(PrismaService);
  const fins = await db.lenderFinancing.findMany({
    where: { cycleId: s.cycle.id, removedAt: null },
    include: {
      repayments: { where: { reversedAt: null }, orderBy: { paidOn: 'asc' } },
    },
  });
  const funding = (
    await app.get(PartnerAccountsService).cycleFunding(s.cycle.id)
  ).data;
  const participants = await db.cycleParticipant.findMany({
    where: { cycleId: s.cycle.id },
    include: {
      partner: { select: { partner: { select: { displayName: true } } } },
      investor: { select: { partner: { select: { displayName: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const input = participants.map((p) => ({
    id: p.id,
    type: p.participantType,
    contribution: D(p.contributionAmount),
    customProfitPct: p.customProfitPct === null ? null : D(p.customProfitPct),
    investorFeePct: p.investorFeePct === null ? null : D(p.investorFeePct),
  }));
  const split = profitSplitView(input);
  const of100k = profitShareOf(input, D(100000));
  return {
    fins,
    funding,
    participants: participants.map((p, i) => ({
      name:
        p.partner?.partner?.displayName ??
        p.investor?.partner?.displayName ??
        '?',
      type: p.participantType,
      contribution: money(p.contributionAmount),
      pct: split.pcts[i],
      of100k: of100k ? money(of100k[i]) : null,
    })),
    basis: split.basis,
  };
}

function print(label: string, f: Awaited<ReturnType<typeof figures>>) {
  console.log(`\n── ${label} ──`);
  for (const x of f.fins) {
    console.log(
      `  financing ${x.id}: ${money(x.amount)} ${x.currency} at ${rate4(x.fxRateToEgp)} on ${day(x.paidOn)} = ${money(x.amountEgp)} EGP`,
    );
    for (const r of x.repayments)
      console.log(
        `    repaid ${day(r.paidOn)} ${money(r.amountEgp).padStart(10)} EGP @${rate4(r.rateToEgp)}  cleared ${money(r.cleared)}  at order rate ${money(r.clearedAtOrderRateEgp)}  exchange ${money(r.exchangeDiffEgp)}`,
      );
    console.log(
      `    owed ${money(owedOn(x.amount, x.repayments))} ${x.currency}`,
    );
  }
  const fr = f.funding.friends;
  console.log(
    `  friends: financed ${fr?.financedEgp ?? '-'}, repaid ${fr?.repaidEgp ?? '-'}, exchange difference ${fr?.exchangeDifferenceEgp ?? '-'} EGP`,
  );
  if (fr?.exchangeSplit)
    console.log(
      `  exchange difference by participant: ${fr.exchangeSplit.map((e) => `${e.name} ${e.amountEgp}`).join(', ')}`,
    );
  console.log(
    `  profit split (${f.basis}) — name, type, contribution, %, of a 100,000 profit:`,
  );
  for (const p of f.participants)
    console.log(
      `    ${p.name.padEnd(16)} ${p.type.padEnd(13)} ${p.contribution.padStart(10)}  ${String(p.pct).padStart(6)}%  ${p.of100k ?? '-'}`,
    );
  const fc = f.funding;
  console.log(
    `  Funding card: put in ${fc.putIn.totalEgp}; to fund ${fc.toFundEgp}; investors ${fc.investorsEgp}; partners contributed ${fc.partnersContributedEgp}; still to contribute ${fc.stillToContributeEgp}`,
  );
  console.log(
    `  Funding card shares: basis ${fc.shares.basis} of ${fc.shares.ofEgp}, partners' part ${fc.shares.partnersEgp}, still ${fc.shares.stillEgp}`,
  );
  console.log(
    `  Funding card partners: ${f.funding.partners.map((p) => `${p.name} share ${p.shareEgp} still ${p.stillToGiveEgp}`).join('; ')}`,
  );
}

async function run(app: App, argv: string[]) {
  const s = await state(app);
  const problems = check(s);
  if (problems.length)
    throw new Error(
      `Starting facts do not match:\n  - ${problems.join('\n  - ')}`,
    );
  const p = progress(s);
  const done =
    p.users.every(Boolean) &&
    p.oldStandingRepayments.length === 0 &&
    p.oldRemoved &&
    !!p.fresh &&
    p.repaymentsToMake.length === 0 &&
    p.coreToSet.length === 0 &&
    p.investorsToAdd.length === 0;
  if (done) {
    console.log(
      `Already applied: ${CYCLE} is funded 55,000 / 60,000 / 20,000 / 33,084.50 / 33,084.49 and Ahmad Eraiby's loan is ${NEW.amount} AED, repaid. Nothing to do.`,
    );
    print('Now', await figures(app, s));
    return;
  }

  // What the 15 October repayment must be to pay the smaller loan off, by the
  // service's own arithmetic (owed × rate, half up).
  const owedBeforeLast = owedOn(
    NEW.amount,
    NEW_REPAYMENTS.slice(0, 2).map((r) => ({
      cleared: D(r.amountEgp)
        .div(D(r.rate))
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN),
    })),
  );
  const payoff = settlingEgp(owedBeforeLast, NEW_REPAYMENTS[2].rate);
  if (money(payoff) !== NEW_REPAYMENTS[2].amountEgp)
    throw new Error(
      `The pay-off at 14.9 is ${money(payoff)}, not ${NEW_REPAYMENTS[2].amountEgp}; look before going on.`,
    );

  console.log(`\nPlan for ${CYCLE} (${s.cycle.status}):`);
  INVESTORS.forEach((inv, i) =>
    console.log(
      p.users[i]
        ? `1. ${inv.name}'s account — exists (${p.users[i].email})`
        : `1. create TEMP_INVESTOR "${inv.name}" <${inv.email}>, random password (not printed)`,
    ),
  );
  console.log(
    p.oldStandingRepayments.length
      ? `2. reverse ${p.oldStandingRepayments.length} repayments on ${OLD_FINANCING_ID} (${p.oldStandingRepayments.map((r) => `${day(r.paidOn)} ${money(r.amountEgp)}`).join(', ')}): "${REVERSE_REASON}"`
      : '2. old repayments — already reversed',
  );
  console.log(
    p.oldRemoved
      ? '3. old financing — already removed'
      : `3. remove financing ${OLD_FINANCING_ID} (${OLD.amount} AED): "${REMOVE_REASON}"`,
  );
  console.log(
    p.fresh
      ? `4. new financing — exists (${p.fresh.id})`
      : `4. finance ${NEW.amount} AED at ${NEW.rate} on ${NEW.paidOn} (= ${money(financingAmountEgp(NEW.amount, NEW.rate))} EGP), ${PO}, same lender and note`,
  );
  console.log(
    p.repaymentsToMake.length
      ? `5. repay ${p.repaymentsToMake.map((r) => `${r.paidOn} ${r.amountEgp} @${r.rate}`).join('; ')}`
      : '5. new repayments — all recorded',
  );
  console.log(
    p.coreToSet.length
      ? `6. contributions: ${p.coreToSet.map((c) => `${c.key} ${money(c.row.contributionAmount)} → ${c.contribution}`).join('; ')}`
      : "6. partners' contributions — already set",
  );
  console.log(
    p.investorsToAdd.length
      ? `7. add TEMP_INVESTOR participants: ${p.investorsToAdd.map((i) => `${i.name} ${i.contribution}`).join('; ')} (no fee, no custom split)`
      : '7. investors — already on the cycle',
  );
  console.log(
    `   (the 15 Oct repayment is ${NEW_REPAYMENTS[2].amountEgp}, the pay-off of ${money(owedBeforeLast)} AED at 14.9; 69,064.93 − 60,000 = 9,064.93 cannot be a pay-off at 14.9)`,
  );
  if (argv.includes('--plan')) {
    print('Now', await figures(app, s));
    console.log('\n--plan: nothing written.');
    return;
  }

  // A correction of the past reaches nobody's phone.
  const notifications = app.get(NotificationsService);
  notifications.create = () => Promise.resolve(undefined as never);
  notifications.createForMultipleUsers = () =>
    Promise.resolve(undefined as never);
  app.get(PushService).sendToUsers = () => Promise.resolve(undefined as never);

  const db = app.get(PrismaService);
  const actor = await db.user.findFirst({
    where: {
      role: 'CORE_PARTNER',
      status: 'ACTIVE',
      email: { startsWith: 'abdallah@' },
    },
    select: { id: true, email: true },
  });
  if (!actor)
    throw new Error(
      'No active core partner abdallah@… to record the correction as.',
    );
  console.log(`\nRecording as ${actor.email}.`);

  const before = await figures(app, s);
  const users = app.get(UsersService);
  const lenders = app.get(LendersService);
  const cycles = app.get(CyclesService);

  const investorIds: string[] = [];
  for (const [i, inv] of INVESTORS.entries()) {
    const existing = p.users[i];
    if (existing) {
      investorIds.push(existing.id);
      continue;
    }
    // Letters and digits, well past the rule; nobody signs in with it.
    const password = `${randomBytes(24).toString('base64url')}a1`;
    const made = await users.create({
      email: inv.email,
      password,
      role: 'TEMP_INVESTOR',
      displayName: inv.name,
    });
    investorIds.push(made.data.id);
    console.log(`  + ${inv.name} <${inv.email}> TEMP_INVESTOR`);
  }
  for (const r of p.oldStandingRepayments) {
    await lenders.reverseRepayment(r.id, REVERSE_REASON, actor.id);
    console.log(`  - reversed ${day(r.paidOn)} ${money(r.amountEgp)}`);
  }
  if (!p.oldRemoved) {
    await lenders.removeFinancing(OLD_FINANCING_ID, REMOVE_REASON, actor.id);
    console.log(`  - removed ${OLD_FINANCING_ID}`);
  }
  let freshId = p.fresh?.id;
  if (!freshId) {
    const made = await lenders.finance(
      s.po.id,
      {
        lenderId: LENDER_ID,
        amount: Number(NEW.amount),
        currency: 'AED',
        fxRateToEgp: Number(NEW.rate),
        paidOn: NEW.paidOn,
        note:
          (s.old?.note ? `${s.old.note} ` : '') +
          'Less 4,026.85 AED (60,000 EGP at 14.9), which stayed in the cycle as his investment (owner, 2026-10-27).',
      },
      actor.id,
    );
    freshId = made.data.id;
    console.log(`  + financed ${NEW.amount} AED (${freshId})`);
  }
  for (const r of p.repaymentsToMake) {
    if (r === NEW_REPAYMENTS[2]) {
      const q = await lenders.quote(freshId, r.rate);
      if (q.data.settlingEgp !== r.amountEgp)
        throw new Error(
          `The service quotes ${q.data.settlingEgp} to pay off at ${r.rate}, not ${r.amountEgp}. Stopped before the last repayment.`,
        );
    }
    await lenders.repay(
      freshId,
      {
        amountEgp: Number(r.amountEgp),
        rateToEgp: Number(r.rate),
        paidOn: r.paidOn,
        ...(r === NEW_REPAYMENTS[2] ? { note: REPAYMENT_NOTE } : {}),
      },
      actor.id,
    );
    console.log(`  + repaid ${r.paidOn} ${r.amountEgp} @${r.rate}`);
  }
  for (const c of p.coreToSet) {
    await cycles.updateParticipant(
      c.row.id,
      { contributionAmount: Number(c.contribution) },
      actor.id,
    );
    console.log(
      `  ~ ${c.key} ${money(c.row.contributionAmount)} → ${c.contribution}`,
    );
  }
  for (const inv of p.investorsToAdd) {
    const userId = investorIds[INVESTORS.findIndex((x) => x.name === inv.name)];
    await cycles.addParticipant(
      s.cycle.id,
      {
        participantType: 'TEMP_INVESTOR',
        investorUserId: userId,
        contributionAmount: Number(inv.contribution),
      },
      actor.id,
    );
    console.log(`  + ${inv.name} TEMP_INVESTOR ${inv.contribution}`);
  }

  const after = await figures(app, await state(app));
  print('Before', before);
  print('After', after);
  console.log('\nDone. Run scripts/check-data.sh against this database next.');
}

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  console.log(
    `${CYCLE} funding → ${target.db} on ${target.host}${target.production ? ' (PRODUCTION)' : ''}${argv.includes('--plan') ? ', plan only' : ''}`,
  );
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.searchParams.has('connection_limit'))
    url.searchParams.set('connection_limit', '1');
  if (!url.searchParams.has('pool_timeout'))
    url.searchParams.set('pool_timeout', '20');
  process.env.DATABASE_URL = url.toString();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const db = app.get(PrismaService);
    const original = db.$transaction.bind(db) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    (db as unknown as { $transaction: unknown }).$transaction = (
      arg: unknown,
      opts?: object,
    ) =>
      typeof arg === 'function'
        ? original(arg, { maxWait: 30_000, timeout: 120_000, ...opts })
        : original(arg, opts);
    await run(app, argv);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\nFAILED:', err instanceof Error ? err.message : err);
    if (err && typeof err === 'object' && 'response' in err)
      console.error(JSON.stringify(err.response));
    process.exitCode = 1;
  });
}
