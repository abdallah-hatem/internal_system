import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PartnerAccountsService } from '../partner-accounts/partner-accounts.service';
import { cashPosition } from '../../common/cash-position';
import { loadRunningCosts } from '../../common/running-costs';
import { businessToday } from '../../common/dates';
import { LedgerService } from './ledger.service';

/**
 * "Paid by" on an expense (BUSINESS_LOGIC §9, owner 2026-10-26, built
 * 2026-10-27), against a real Postgres: the account locks, the all-or-nothing
 * row and credit, and the cash reading are only honest there.
 *
 * Fuel for a delivery paid from a partner's own pocket is the same expense —
 * a cycle's cost, or a running cost shared from payouts — but no business
 * cash leaves, and his running account is credited with it.
 *
 * Built as the business builds it (CLAUDE.md §4): a cycle with an order, a
 * leg, a departure, a delivery, a checked-in receipt and a confirmed sale.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest expense-paid-by.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

suite('"Paid by" on an expense (Postgres)', () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let accounts: PartnerAccountsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let analytics: AnalyticsService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
      create: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    const cycles = new CyclesService(db, audit, notifications);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
    sales = new SalesService(db, audit, new PaymentsService(db, audit), {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    analytics = new AnalyticsService(db);
    accounts = new PartnerAccountsService(db, audit, costing);
    ledger = new LedgerService(db, audit);
    actor = (await partner('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());

  // ─── Fixtures ───────────────────────────────────────────────────────

  /** A core partner: an active CORE_PARTNER login with a partner record. */
  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `paidby-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** Three partners on a fresh cycle (contributions 0), the cycle in `status`. */
  async function cycleWithPartners(status: string = 'PURCHASING') {
    const tag = randomUUID().slice(0, 8);
    const people = [
      await partner('Abdallah'),
      await partner('Shady'),
      await partner('Fares'),
    ];
    const cycle = await prisma.importCycle.create({
      data: {
        code: `PAIDBY-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: status as never,
      },
    });
    const joined = Date.now() - 60_000;
    for (const [i, p] of people.entries()) {
      await prisma.cycleParticipant.create({
        data: {
          cycleId: cycle.id,
          participantType: 'CORE_PARTNER',
          partnerUserId: p.id,
          contributionAmount: 0,
          createdAt: new Date(joined + i * 1000),
        },
      });
    }
    return { cycle, people };
  }

  /**
   * A cycle as the business makes it: 40 ordered at 100, a 400 leg that left
   * with everything, all delivered and checked in (the purchase is in the
   * ledger, at receipt), and 10 sold at 200 to a verified shop.
   */
  async function tradedCycle() {
    const base = await cycleWithPartners('ARRIVED_EGYPT');
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `PaidBy ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `PAIDBY-${tag}`, name: `Paid-by part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: base.cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date(`${daysAgo(30)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 40,
        unitPrice: 100,
        lineTotal: 4000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: base.cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(5),
        lines: [{ purchaseOrderItemId: item.id, qty: 40 }],
      },
      actor,
    );
    const d = delivery as unknown as { id: string; lines: { id: string }[] };
    await inventory.verifyStock(
      base.cycle.id,
      {
        deliveryId: d.id,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
      },
      actor,
    );
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `PaidBy shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 10, unitPrice: 200 }],
        confirm: true,
      },
      actor,
    );
    return base;
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { status: e.getStatus(), code: body.code, params: body.params };
    }
    throw new Error('expected a refusal');
  }

  const fuel = (
    amount: number,
    extra: Record<string, unknown> = {},
    by: string = actor,
  ) =>
    ledger.create(
      {
        kind: 'EXPENSE',
        category: 'fuel',
        amount,
        currency: 'EGP',
        ...extra,
      },
      by,
    );

  const account = async (userId: string) => {
    const { data } = await accounts.list();
    return data.find((a) => a.partnerUserId === userId)!;
  };
  const balanceOf = async (userId: string) =>
    (await account(userId)).balanceEgp;

  /** Untied money in his account, as Mark paid writes it for a payout left in. */
  const leftIn = (userId: string, amountEgp: number) =>
    prisma.partnerAccountMovement.create({
      data: {
        partnerUserId: userId,
        kind: 'PAYOUT_LEFT_IN',
        amount: amountEgp,
        amountEgp,
        occurredOn: new Date(`${businessToday()}T00:00:00Z`),
        note: 'Payout left in (fixture)',
      },
    });

  /**
   * Every figure a reader of the business's money sees, flattened to numbers
   * by path: the dashboard, the profit and loss, one cycle's profitability,
   * and cash on hand.
   */
  async function figures(cycleId?: string) {
    const kpis = (await analytics.getDashboardKPIs()).data;
    const pnl = (await analytics.getProfitAndLoss()).data;
    const cycles = (await analytics.getCycleProfitability()) as unknown as {
      data: { cycleId?: string; id?: string }[];
    };
    const cycle = cycleId
      ? (cycles.data ?? (cycles as unknown as { cycleId?: string }[])).find(
          (c) => (c.cycleId ?? c.id) === cycleId,
        )
      : undefined;
    const cash = await cashPosition(prisma);
    const flat = new Map<string, number>();
    const walk = (prefix: string, v: unknown) => {
      if (typeof v === 'number') flat.set(prefix, v);
      else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))
        flat.set(prefix, Number(v));
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(`${prefix}.${k}`, x);
    };
    walk('kpis', kpis);
    walk('pnl', pnl);
    walk('cycle', cycle);
    walk('cash', {
      cashIn: cash.cashIn.toString(),
      cashOut: cash.cashOut.toString(),
      cashOnHand: cash.cashOnHand.toString(),
    });
    return flat;
  }
  /**
   * What moved between two readings, by path, rounded to the piastre. A
   * percentage (net profit as a share of sales, to one place) is left out:
   * two equal expenses can move it by 0.1 and 0.2 through rounding alone.
   */
  const delta = (a: Map<string, number>, b: Map<string, number>) => {
    const out: Record<string, number> = {};
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      if (/pct/i.test(k)) continue;
      const d = Math.round(((b.get(k) ?? 0) - (a.get(k) ?? 0)) * 100) / 100;
      if (d !== 0) out[k] = d;
    }
    return out;
  };
  const isCash = (path: string) => /cash/i.test(path);
  const split = (d: Record<string, number>) => ({
    cash: Object.fromEntries(Object.entries(d).filter(([k]) => isCash(k))),
    rest: Object.fromEntries(Object.entries(d).filter(([k]) => !isCash(k))),
  });

  // ─── The money it moves, and the money it does not ─────────────────

  it('charged to a cycle: cash on hand does not move, and P&L, dashboard and the cycle’s profit read it as the business paying would', async () => {
    const { cycle, people } = await tradedCycle();
    const shady = people[1].id;
    const f0 = await figures(cycle.id);
    await fuel(250, { cycleId: cycle.id, paidByUserId: shady });
    const f1 = await figures(cycle.id);
    // The same expense, paid by the business: the twin to compare with.
    await fuel(250, { cycleId: cycle.id });
    const f2 = await figures(cycle.id);

    const byPartner = split(delta(f0, f1));
    const byBusiness = split(delta(f1, f2));
    // No business cash left when Shady paid…
    expect(byPartner.cash).toEqual({});
    // …but it did when the business paid (the comparison is not empty).
    expect(byBusiness.cash['cash.cashOnHand']).toBe(-250);
    expect(byBusiness.cash['cash.cashOut']).toBe(250);
    expect(byBusiness.cash['kpis.cashOnHand']).toBe(-250);
    // Everything else moved exactly as the business-paid expense moved it.
    expect(byPartner.rest).toEqual(byBusiness.rest);
    expect(byPartner.rest['kpis.totalExpenses']).toBe(250);
    expect(byPartner.rest['pnl.expensesEgp']).toBe(250);
    expect(byPartner.rest['kpis.netProfit']).toBe(-250);
    // The cycle's profit fell by it (whatever the row calls its profit).
    expect(
      Object.keys(byPartner.rest).some((k) => k.startsWith('cycle.')),
    ).toBe(true);
    // And Shady's account holds it.
    expect(await balanceOf(shady)).toBe('250.00');
  });

  it('the Fuel quick action’s entry (fuel, no cycle): a running cost with the same shares as the business paying it, his account credited, no cash', async () => {
    const { people } = await cycleWithPartners();
    const shady = people[1].id;
    const cash0 = await cashPosition(prisma);
    const { data: mine } = await fuel(300, {
      paidByUserId: shady,
      note: 'delivery to Mokattam',
    });
    const { data: theirs } = await fuel(300);
    const cash1 = await cashPosition(prisma);
    expect(cash1.cashOnHand.sub(cash0.cashOnHand).toString()).toBe('-300');

    const shares = async (id: string) =>
      (
        await prisma.runningCostShare.findMany({
          where: { costEntryId: id },
          orderBy: { partnerUserId: 'asc' },
        })
      ).map((s) => [s.partnerUserId, s.amount.toFixed(2)]);
    expect((await shares(mine.id)).length).toBeGreaterThan(0);
    expect(await shares(mine.id)).toEqual(await shares(theirs.id));
    const { costs } = await loadRunningCosts(prisma);
    const cost = costs.find((c) => c.id === mine.id)!;
    expect(cost.amount.toFixed(2)).toBe('300.00');

    const acct = await account(shady);
    expect(acct.balanceEgp).toBe('300.00');
    expect(acct.expensesPaidEgp).toBe('300.00');
    expect(acct.untiedEgp).toBe('300.00');
    const m = acct.movements.find((x) => x.kind === 'EXPENSE_PAID')!;
    expect(m).toMatchObject({
      amountEgp: '300.00',
      expenseEntryId: mine.id,
      expenseCategory: 'fuel',
      note: 'delivery to Mokattam',
      cycleId: null,
    });
    expect(mine.paidBy?.id).toBe(shady);
  });

  it('in another currency: the expense in pounds, his credit the same pounds, what he paid kept beside it', async () => {
    const { people } = await cycleWithPartners();
    const { data } = await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'transport_delivery',
        amount: 10,
        currency: 'USD',
        fxRateToEgp: 50,
        paidByUserId: people[0].id,
      },
      actor,
    );
    expect(data.amount.toString()).toBe('500');
    const m = (await account(people[0].id)).movements[0];
    expect(m).toMatchObject({
      kind: 'EXPENSE_PAID',
      amountEgp: '500.00',
      amount: '10.00',
      currency: 'USD',
    });
  });

  // ─── Reversing ──────────────────────────────────────────────────────

  it('reversing the expense reverses the credit: his account back to zero, the undo names him, cash never moved', async () => {
    const { cycle, people } = await tradedCycle();
    const shady = people[1].id;
    const f0 = await figures(cycle.id);
    const { data } = await fuel(400, {
      cycleId: cycle.id,
      paidByUserId: shady,
    });
    expect(await balanceOf(shady)).toBe('400.00');
    const { data: undo } = await ledger.reverse(data.id, 'typed twice', actor);
    expect(undo.paidByUserId).toBe(shady);
    expect(undo.direction).toBe('INFLOW');
    expect(await balanceOf(shady)).toBe('0.00');
    const m = await prisma.partnerAccountMovement.findUniqueOrThrow({
      where: { expenseEntryId: data.id },
    });
    expect(m.reversedAt).not.toBeNull();
    expect(m.reversalReason).toBe('typed twice');
    // The expense and its undo leave cash, the P&L and the dashboard as they
    // were, and every figure as the same pair paid by the business leaves it.
    const f1 = await figures(cycle.id);
    const { data: twin } = await fuel(400, { cycleId: cycle.id });
    await ledger.reverse(twin.id, 'typed twice', actor);
    const f2 = await figures(cycle.id);
    const byPartner = delta(f0, f1);
    expect(byPartner).toEqual(delta(f1, f2));
    expect(
      Object.keys(byPartner).filter(
        (k) => k.startsWith('kpis.') || k.startsWith('pnl.') || isCash(k),
      ),
    ).toEqual([]);
  });

  it('reversing after he took the money out is refused, saying so — and nothing is written; once the withdrawal is undone it goes through', async () => {
    const { people } = await cycleWithPartners();
    const shady = people[1].id;
    const { data } = await fuel(500, { paidByUserId: shady });
    const { data: taken } = await accounts.withdraw(
      shady,
      { amountEgp: 200 },
      actor,
    );
    const r = await refusal(ledger.reverse(data.id, 'not his', actor));
    expect(r.code).toBe('EXPENSE_CREDIT_ALREADY_TAKEN');
    expect(r.params).toMatchObject({ amount: '500.00', available: '300.00' });
    expect(
      await prisma.financialTransaction.count({
        where: { reversalOfId: data.id },
      }),
    ).toBe(0);
    expect(await balanceOf(shady)).toBe('300.00');

    await accounts.reverse(shady, taken.id, 'he gave it back', actor);
    await ledger.reverse(data.id, 'not his', actor);
    expect(await balanceOf(shady)).toBe('0.00');
  });

  it('reversing after his credit was drawn into a cycle’s contribution is refused the same way', async () => {
    const { cycle, people } = await cycleWithPartners();
    const shady = people[1].id;
    const { data } = await fuel(600, { paidByUserId: shady });
    // Left in for a contribution: the business owes it, he funds a cycle with it.
    await accounts.contribute(
      cycle.id,
      { lines: [{ partnerUserId: shady, amountEgp: 600 }] },
      actor,
    );
    expect(await balanceOf(shady)).toBe('0.00');
    expect((await refusal(ledger.reverse(data.id, 'oops', actor))).code).toBe(
      'EXPENSE_CREDIT_ALREADY_TAKEN',
    );
  });

  it('the credit cannot be reversed from his account on its own, nor found under another partner', async () => {
    const { people } = await cycleWithPartners();
    const [abdallah, shady] = people.map((p) => p.id);
    const { data } = await fuel(100, { paidByUserId: shady });
    const m = await prisma.partnerAccountMovement.findUniqueOrThrow({
      where: { expenseEntryId: data.id },
    });
    expect(
      (await refusal(accounts.reverse(shady, m.id, 'try', actor))).code,
    ).toBe('ACCOUNT_EXPENSE_REVERSE_ON_LEDGER');
    expect(
      (await refusal(accounts.reverse(abdallah, m.id, 'try', actor))).code,
    ).toBe('NOT_FOUND');
    expect(await balanceOf(shady)).toBe('100.00');
  });

  it('doing it twice: two expenses are two credits; reversing twice — one after the other or at once — undoes the credit once', async () => {
    const { people } = await cycleWithPartners();
    const shady = people[1].id;
    const { data: one } = await fuel(120, { paidByUserId: shady });
    const { data: two } = await fuel(80, { paidByUserId: shady });
    expect(await balanceOf(shady)).toBe('200.00');

    await ledger.reverse(one.id, 'first', actor);
    expect((await refusal(ledger.reverse(one.id, 'again', actor))).code).toBe(
      'ENTRY_ALREADY_REVERSED',
    );
    expect(await balanceOf(shady)).toBe('80.00');

    const both = await Promise.allSettled(
      [0, 1].map(() => ledger.reverse(two.id, 'at once', actor)),
    );
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(
      (lost.reason as HttpException).getResponse() as { code: string },
    ).toMatchObject({ code: 'ENTRY_ALREADY_REVERSED' });
    expect(
      await prisma.financialTransaction.count({
        where: { reversalOfId: two.id },
      }),
    ).toBe(1);
    expect(await balanceOf(shady)).toBe('0.00');
  });

  // ─── Who can have paid ──────────────────────────────────────────────

  it('another partner’s id: the partner named is credited, not the one recording it', async () => {
    const { people } = await cycleWithPartners();
    const [abdallah, shady] = people.map((p) => p.id);
    await fuel(75, { paidByUserId: shady }, abdallah);
    expect(await balanceOf(shady)).toBe('75.00');
    expect(await balanceOf(abdallah)).toBe('0.00');
  });

  it('refuses an investor, the office’s login, a partner who left, someone who does not exist and a non-id — writing nothing', async () => {
    const { people } = await cycleWithPartners();
    const investor = await prisma.user.create({
      data: {
        email: `paidby-inv-${randomUUID()}@investors.invalid`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    const office = await prisma.user.create({
      data: {
        email: `paidby-office-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'ADMIN_SUPPORT',
      },
    });
    const left = await partner('Left');
    await prisma.partner.update({
      where: { userId: left.id },
      data: { active: false },
    });
    const before = await prisma.financialTransaction.count();
    const movementsBefore = await prisma.partnerAccountMovement.count();
    for (const [who, code] of [
      [investor.id, 'LEDGER_PAYER_NOT_PARTNER'],
      [office.id, 'LEDGER_PAYER_NOT_PARTNER'],
      [randomUUID(), 'LEDGER_PAYER_NOT_PARTNER'],
      ['CYC-2026-0001', 'LEDGER_PAYER_NOT_PARTNER'],
      [left.id, 'LEDGER_PAYER_INACTIVE'],
    ] as const) {
      const r = await refusal(fuel(50, { paidByUserId: who }));
      expect([who, r.status, r.code]).toEqual([who, 400, code]);
    }
    expect(await prisma.financialTransaction.count()).toBe(before);
    expect(await prisma.partnerAccountMovement.count()).toBe(movementsBefore);
    expect(await balanceOf(people[0].id)).toBe('0.00');
  });

  it('income cannot be paid by a partner', async () => {
    const { people } = await cycleWithPartners();
    const r = await refusal(
      ledger.create(
        {
          kind: 'OTHER_INCOME',
          category: 'interest',
          amount: 40,
          currency: 'EGP',
          paidByUserId: people[0].id,
        },
        actor,
      ),
    );
    expect(r.code).toBe('LEDGER_PAID_BY_ONLY_EXPENSE');
    expect(await balanceOf(people[0].id)).toBe('0.00');
  });

  // ─── The limits ─────────────────────────────────────────────────────

  it('refuses zero and negative amounts, crediting nothing', async () => {
    const { people } = await cycleWithPartners();
    for (const amount of [0, -25]) {
      expect(
        (await refusal(fuel(amount, { paidByUserId: people[1].id }))).code,
      ).toBe('LEDGER_AMOUNT_NOT_POSITIVE');
    }
    expect(await balanceOf(people[1].id)).toBe('0.00');
  });

  it('refuses a day that has not arrived; a past day is the credit’s day too', async () => {
    const { people } = await cycleWithPartners();
    const shady = people[1].id;
    expect(
      (
        await refusal(
          fuel(60, { paidByUserId: shady, occurredOn: daysAhead(2) }),
        )
      ).code,
    ).toBe('DATE_IN_FUTURE');
    expect(await balanceOf(shady)).toBe('0.00');
    await fuel(60, { paidByUserId: shady, occurredOn: daysAgo(3) });
    expect((await account(shady)).movements[0].occurredOn).toBe(daysAgo(3));
  });

  // ─── A cycle being settled, or closed ───────────────────────────────

  it('a cycle in settlement still takes a late cost paid by him; a closed one refuses it, and its expense cannot be undone after it closed', async () => {
    const settling = await cycleWithPartners('SETTLEMENT');
    const shady = settling.people[1].id;
    await fuel(90, { cycleId: settling.cycle.id, paidByUserId: shady });
    expect(await balanceOf(shady)).toBe('90.00');

    const closed = await cycleWithPartners('CLOSED');
    expect(
      (
        await refusal(
          fuel(90, { cycleId: closed.cycle.id, paidByUserId: shady }),
        )
      ).code,
    ).toBe('LEDGER_CYCLE_NOT_OPEN');
    expect(await balanceOf(shady)).toBe('90.00');

    const open = await cycleWithPartners();
    const { data } = await fuel(30, {
      cycleId: open.cycle.id,
      paidByUserId: shady,
    });
    await prisma.importCycle.update({
      where: { id: open.cycle.id },
      data: { status: 'CLOSED' },
    });
    expect(
      (await refusal(ledger.reverse(data.id, 'too late', actor))).code,
    ).toBe('LEDGER_CYCLE_NOT_OPEN');
    expect(await balanceOf(shady)).toBe('120.00');
  });

  it('his credit is untied money: he can take it out, or leave it in to fund any cycle', async () => {
    const { cycle, people } = await cycleWithPartners();
    const shady = people[1].id;
    await leftIn(shady, 0.01); // a standing balance from before, untouched
    await fuel(200, { paidByUserId: shady });
    await accounts.withdraw(shady, { amountEgp: 50 }, actor);
    await accounts.contribute(
      cycle.id,
      { lines: [{ partnerUserId: shady, amountEgp: 150 }] },
      actor,
    );
    expect(await balanceOf(shady)).toBe('0.01');
  });
});
