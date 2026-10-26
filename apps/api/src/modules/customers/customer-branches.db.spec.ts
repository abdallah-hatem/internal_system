import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service';
import { PaymentsService } from '../payments/payments.service';
import {
  SalesService,
  type CreateSaleOrderInput,
} from '../sales/sales.service';
import { CustomersService } from './customers.service';
import { CustomerBranchesService } from './customer-branches.service';
import { owedBy } from '../../common/customer-balance';
import { NO_BRANCH, owedByBranch } from '../../common/customer-branches';
import { loadSaleCatalogue, resolveSale } from '../assistant/tools/sales';

/**
 * A customer with branches against a real Postgres (BUSINESS_LOGIC §7, owner
 * 2026-10-25): the unique indexes, the default a sale falls back to, payments
 * to one branch, and balances and statements that must add up — none of which
 * an in-memory fake can prove.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`),
 * never the dev database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=$DATABASE_URL npx jest customer-branches.db
 *
 * Every test makes its own customers, so the suite can run again.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('customer branches against Postgres', () => {
  let prisma: PrismaClient;
  let db: PrismaService;
  let sales: SalesService;
  let payments: PaymentsService;
  let customers: CustomersService;
  let branches: CustomerBranchesService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    customers = new CustomersService(db, audit, {
      overdueSummary: () =>
        Promise.resolve({ data: { totalOverdueEgp: 0, plans: [] } }),
    } as unknown as PaymentPlansService);
    branches = new CustomerBranchesService(db, audit);
    const user = await prisma.user.create({
      data: {
        email: `br-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());

  // ── fixtures: states the business recognises (CLAUDE.md §4) ──────────────

  const shop = (name = 'Shop') =>
    prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `${name} ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });

  /** A product with stock received and verified on a selling cycle. */
  async function stocked(qty = 500) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `BR-${tag}`, name: `Branch part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `BR-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId: product.id,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: 100,
        verificationStatus: 'VERIFIED',
      },
    });
    return product;
  }

  let product: { id: string };
  beforeAll(async () => {
    product = await stocked();
  });

  /** A confirmed sale of `units` at 150 each. */
  const sell = (
    customerId: string,
    units: number,
    extra: Partial<CreateSaleOrderInput> = {},
  ) =>
    sales.create(
      {
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: units, unitPrice: 150 }],
        ...extra,
      },
      actor,
    ) as Promise<{ data: { id: string; orderNo: string } }>;

  const branchOf = async (orderId: string) =>
    (
      await prisma.saleOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { branchId: true },
      })
    ).branchId;

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  /** An owner with three branches; `defaultName` is made the default. */
  async function owner(defaultName?: string) {
    const c = await shop('Owner');
    const made: Record<string, string> = {};
    for (const name of ['Mokattam', 'Master', 'LS2']) {
      const { data } = await branches.create(
        c.id,
        { name, isDefault: name === defaultName },
        actor,
      );
      made[name] = data.id;
    }
    return { customer: c, b: made };
  }

  // ── names and the default ─────────────────────────────────────────────────

  it('refuses a second branch with the same name in any case, and a rename onto one', async () => {
    const { customer, b } = await owner();
    expect(
      await refusal(branches.create(customer.id, { name: '  ls2 ' }, actor)),
    ).toBe('BRANCH_NAME_TAKEN');
    expect(
      await refusal(
        branches.update(customer.id, b.Master, { name: 'MOKATTAM' }, actor),
      ),
    ).toBe('BRANCH_NAME_TAKEN');
    // Its own name in another case is a rename, not a clash.
    const { data } = await branches.update(
      customer.id,
      b.Master,
      { name: 'MASTER' },
      actor,
    );
    expect(data.name).toBe('MASTER');
    // Another customer may use the same name.
    const other = await shop();
    await expect(
      branches.create(other.id, { name: 'LS2' }, actor),
    ).resolves.toBeDefined();
    // Empty and absurd names.
    expect(
      await refusal(branches.create(customer.id, { name: '   ' }, actor)),
    ).toBe('BRANCH_NAME_REQUIRED');
    expect(
      await refusal(
        branches.create(customer.id, { name: 'x'.repeat(81) }, actor),
      ),
    ).toBe('BRANCH_NAME_TOO_LONG');
  });

  it('the database itself refuses a duplicate name, past the service', async () => {
    const { customer } = await owner();
    await expect(
      prisma.customerBranch.create({
        data: { customerId: customer.id, name: 'mokattam' },
      }),
    ).rejects.toThrow();
  });

  it('keeps at most one default: setting another moves it, and the index refuses two', async () => {
    const { customer, b } = await owner('Mokattam');
    await branches.update(customer.id, b.LS2, { isDefault: true }, actor);
    const defaults = await prisma.customerBranch.findMany({
      where: { customerId: customer.id, isDefault: true },
    });
    expect(defaults.map((d) => d.id)).toEqual([b.LS2]);

    // Straight at the table, as a second request racing the first would.
    await expect(
      prisma.customerBranch.update({
        where: { id: b.Master },
        data: { isDefault: true },
      }),
    ).rejects.toThrow();

    // Two "make default" at once: one default at the end, whichever won.
    await Promise.allSettled([
      branches.update(customer.id, b.Mokattam, { isDefault: true }, actor),
      branches.update(customer.id, b.Master, { isDefault: true }, actor),
    ]);
    expect(
      await prisma.customerBranch.count({
        where: { customerId: customer.id, isDefault: true },
      }),
    ).toBe(1);
  });

  it('a new default branch made with isDefault takes it from the old one', async () => {
    const { customer, b } = await owner('Master');
    const { data } = await branches.create(
      customer.id,
      { name: 'Nasr City', isDefault: true },
      actor,
    );
    const now = await prisma.customerBranch.findMany({
      where: { customerId: customer.id, isDefault: true },
    });
    expect(now.map((x) => x.id)).toEqual([data.id]);
    expect(now.map((x) => x.id)).not.toContain(b.Master);
  });

  it('archiving the default stops it being the default; an archived branch cannot become it', async () => {
    const { customer, b } = await owner('Mokattam');
    await branches.archive(customer.id, b.Mokattam, actor);
    const archived = await prisma.customerBranch.findUniqueOrThrow({
      where: { id: b.Mokattam },
    });
    expect(archived.isDefault).toBe(false);
    expect(archived.archivedAt).not.toBeNull();
    expect(
      await refusal(
        branches.update(customer.id, b.Mokattam, { isDefault: true }, actor),
      ),
    ).toBe('BRANCH_ARCHIVED');
    // Archiving twice changes nothing.
    await expect(
      branches.archive(customer.id, b.Mokattam, actor),
    ).resolves.toBeDefined();
  });

  it("another customer's branch is not found through this customer", async () => {
    const a = await owner();
    const other = await shop();
    expect(
      await refusal(
        branches.update(other.id, a.b.LS2, { name: 'Mine now' }, actor),
      ),
    ).toBe('NOT_FOUND');
    expect(await refusal(branches.archive(other.id, a.b.LS2, actor))).toBe(
      'NOT_FOUND',
    );
  });

  // ── a sale's branch ───────────────────────────────────────────────────────

  it('an order sent without a branch lands on the default, null included', async () => {
    const { customer, b } = await owner('Master');
    const left = await sell(customer.id, 1);
    expect(await branchOf(left.data.id)).toBe(b.Master);
    const nulled = await sell(customer.id, 1, { branchId: null });
    expect(await branchOf(nulled.data.id)).toBe(b.Master);
    // A draft takes the same rule.
    const draft = (await sales.create(
      {
        customerId: customer.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 150 }],
      },
      actor,
    )) as { data: { id: string } };
    expect(await branchOf(draft.data.id)).toBe(b.Master);
  });

  it('a branch named is kept; with no default the order is on the owner', async () => {
    const { customer, b } = await owner();
    const named = await sell(customer.id, 1, { branchId: b.LS2 });
    expect(await branchOf(named.data.id)).toBe(b.LS2);
    const none = await sell(customer.id, 1);
    expect(await branchOf(none.data.id)).toBeNull();
  });

  it('a customer with no branches is sold to exactly as before', async () => {
    const plain = await shop();
    const order = await sell(plain.id, 1);
    expect(await branchOf(order.data.id)).toBeNull();
  });

  it("refuses another customer's branch and an archived branch, and saves nothing", async () => {
    const a = await owner();
    const other = await shop();
    const before = await prisma.saleOrder.count();
    expect(await refusal(sell(other.id, 1, { branchId: a.b.LS2 }))).toBe(
      'BRANCH_NOT_THIS_CUSTOMER',
    );
    await branches.archive(a.customer.id, a.b.Master, actor);
    expect(
      await refusal(sell(a.customer.id, 1, { branchId: a.b.Master })),
    ).toBe('BRANCH_ARCHIVED');
    expect(
      await refusal(sell(a.customer.id, 1, { branchId: randomUUID() })),
    ).toBe('NOT_FOUND');
    expect(
      await refusal(sell(a.customer.id, 1, { branchId: 'not-an-id' })),
    ).toBe('NOT_FOUND');
    // Samples and a walk-in sale go through the same rule.
    expect(
      await refusal(
        sales.create(
          {
            samples: true,
            customerId: other.id,
            branchId: a.b.LS2,
            channel: 'B2B',
            currency: 'EGP',
            items: [{ productId: product.id, quantity: 1, unitPrice: 0 }],
          },
          actor,
        ),
      ),
    ).toBe('BRANCH_NOT_THIS_CUSTOMER');
    expect(
      await refusal(
        sales.create(
          {
            walkIn: true,
            branchId: a.b.LS2,
            currency: 'EGP',
            items: [{ productId: product.id, quantity: 1, unitPrice: 450 }],
          } as CreateSaleOrderInput,
          actor,
        ),
      ),
    ).toBe('BRANCH_NOT_THIS_CUSTOMER');
    expect(await prisma.saleOrder.count()).toBe(before);
  });

  it('samples left without a branch go on the default too', async () => {
    const { customer, b } = await owner('LS2');
    const left = (await sales.create(
      {
        samples: true,
        customerId: customer.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 0 }],
      },
      actor,
    )) as { data: { id: string } };
    expect(await branchOf(left.data.id)).toBe(b.LS2);
  });

  // ── the assistant's record_sale: the same rule, through the same service ──

  it('record_sale with no branch named lands on the default; a branch named is used', async () => {
    const { customer, b } = await owner('Mokattam');
    const catalogue = await loadSaleCatalogue(db);
    const line = { product: product.id, qty: 1, unitPrice: 150 };

    const plain = resolveSale(
      { customer: customer.id, lines: [line] },
      catalogue,
    );
    if (plain.status !== 'ready') throw new Error('expected a ready plan');
    expect(plain.body.branchId).toBeUndefined();
    const sold = (await sales.create(plain.body, actor)) as {
      data: { id: string };
    };
    expect(await branchOf(sold.data.id)).toBe(b.Mokattam);

    const named = resolveSale(
      { customer: customer.id, branch: 'ls2', lines: [line] },
      catalogue,
    );
    if (named.status !== 'ready') throw new Error('expected a ready plan');
    const toLs2 = (await sales.create(named.body, actor)) as {
      data: { id: string };
    };
    expect(await branchOf(toLs2.data.id)).toBe(b.LS2);

    // A branch that is not theirs is a question, never a guess.
    const unknown = resolveSale(
      { customer: customer.id, branch: 'Dokki', lines: [line] },
      catalogue,
    );
    expect(unknown.status).toBe('questions');
  });

  // ── money: payments, balances and statements that add up ─────────────────

  /**
   * Owner with Mokattam (150 + 300), Master (450), LS2 (150) and one order on
   * no branch (150): 1,200 owed in all. Sold in that order, one at a time.
   */
  async function trading() {
    const o = await owner();
    const m1 = await sell(o.customer.id, 1, { branchId: o.b.Mokattam }); // 150
    const m2 = await sell(o.customer.id, 2, { branchId: o.b.Mokattam }); // 300
    const ma = await sell(o.customer.id, 3, { branchId: o.b.Master }); // 450
    const l = await sell(o.customer.id, 1, { branchId: o.b.LS2 }); // 150
    const none = await sell(o.customer.id, 1); // 150, no default → owner
    return { ...o, orders: { m1, m2, ma, l, none } };
  }
  const pay = (
    customerId: string,
    amount: number,
    extra: { branchId?: string; orderId?: string } = {},
  ) =>
    payments.create(
      {
        customerId,
        amount,
        currency: 'EGP',
        method: 'CASH',
        applyOldestFirst: true,
        ...extra,
      },
      actor,
    );
  const outstanding = async (id: string) =>
    Number(
      (
        await prisma.saleOrder.findUniqueOrThrow({
          where: { id },
          select: { outstanding: true },
        })
      ).outstanding,
    );

  it('per-branch balances, and the order on no branch, add up to what the owner owes', async () => {
    const t = await trading();
    const owed = await owedByBranch(prisma, t.customer.id, Object.values(t.b));
    expect(owed.get(t.b.Mokattam)).toBe('450.00');
    expect(owed.get(t.b.Master)).toBe('450.00');
    expect(owed.get(t.b.LS2)).toBe('150.00');
    expect(owed.get(NO_BRANCH)).toBe('150.00');
    const sum = [...owed.values()].reduce((s, v) => s + Number(v), 0);
    expect(sum.toFixed(2)).toBe(await owedBy(prisma, t.customer.id));
    expect(sum.toFixed(2)).toBe('1200.00');
    // The list endpoint says the same.
    const { data, meta } = await branches.list(t.customer.id);
    expect(meta.totalOwed).toBe('1200.00');
    expect(meta.noBranchOwed).toBe('150.00');
    expect(data.map((b) => b.owed)).toEqual(['450.00', '450.00', '150.00']);
  });

  it('a payment to one branch goes on its orders only, oldest first', async () => {
    const t = await trading();
    await pay(t.customer.id, 200, { branchId: t.b.Mokattam });
    expect(await outstanding(t.orders.m1.data.id)).toBe(0);
    expect(await outstanding(t.orders.m2.data.id)).toBe(250);
    // Master is older than LS2 and the order on no branch, and untouched.
    expect(await outstanding(t.orders.ma.data.id)).toBe(450);
    expect(await outstanding(t.orders.none.data.id)).toBe(150);

    // LS2 is newer than Mokattam's open order: paying LS2 still skips it.
    await pay(t.customer.id, 100, { branchId: t.b.LS2 });
    expect(await outstanding(t.orders.l.data.id)).toBe(50);
    expect(await outstanding(t.orders.m2.data.id)).toBe(250);
  });

  it('refuses a payment to one branch that is more than that branch owes', async () => {
    const t = await trading();
    const before = await prisma.payment.count({
      where: { customerId: t.customer.id },
    });
    // 451 is less than the owner owes (1,200) but more than Mokattam (450).
    expect(
      await refusal(pay(t.customer.id, 451, { branchId: t.b.Mokattam })),
    ).toBe('PAYMENT_EXCEEDS_BRANCH_OWED');
    await pay(t.customer.id, 150, { branchId: t.b.LS2 });
    expect(await refusal(pay(t.customer.id, 1, { branchId: t.b.LS2 }))).toBe(
      'BRANCH_OWES_NOTHING',
    );
    expect(
      await prisma.payment.count({ where: { customerId: t.customer.id } }),
    ).toBe(before + 1);
  });

  it('refuses a payment spread across branches that is more than the combined total', async () => {
    const t = await trading();
    expect(await refusal(pay(t.customer.id, 1200.01))).toBe(
      'PAYMENT_EXCEEDS_OWED',
    );
    // Exactly the total clears every branch and the order on the owner.
    await pay(t.customer.id, 1200);
    const owed = await owedByBranch(prisma, t.customer.id, Object.values(t.b));
    expect([...owed.values()].every((v) => v === '0.00')).toBe(true);
  });

  it("refuses a payment to another customer's branch, and branch with order together", async () => {
    const t = await trading();
    const other = await owner();
    expect(
      await refusal(pay(t.customer.id, 10, { branchId: other.b.LS2 })),
    ).toBe('BRANCH_NOT_THIS_CUSTOMER');
    expect(
      await refusal(
        pay(t.customer.id, 10, {
          branchId: t.b.LS2,
          orderId: t.orders.l.data.id,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('an archived branch keeps its balance and can still be paid', async () => {
    const t = await trading();
    await branches.archive(t.customer.id, t.b.Master, actor);
    expect((await owedByBranch(prisma, t.customer.id)).get(t.b.Master)).toBe(
      '450.00',
    );
    await pay(t.customer.id, 450, { branchId: t.b.Master });
    expect(await outstanding(t.orders.ma.data.id)).toBe(0);
  });

  it("each branch's statement closes at its balance, and together they make the owner's", async () => {
    const t = await trading();
    // A payment spread over two branches: Mokattam's 450, then 50 of Master.
    await pay(t.customer.id, 500);
    await pay(t.customer.id, 100, { branchId: t.b.LS2 });

    const all = (await customers.statement(t.customer.id, {})).data;
    expect(all.closingBalance).toBe(await owedBy(prisma, t.customer.id));
    const parts = await Promise.all(
      [...Object.values(t.b), NO_BRANCH].map(
        async (branch) =>
          (await customers.statement(t.customer.id, { branch })).data,
      ),
    );
    const owed = await owedByBranch(prisma, t.customer.id, Object.values(t.b));
    for (const [i, id] of [...Object.values(t.b), NO_BRANCH].entries()) {
      expect(parts[i].closingBalance).toBe(owed.get(id));
    }
    const summed = parts.reduce((s, p) => s + Number(p.closingBalance), 0);
    expect(summed.toFixed(2)).toBe(all.closingBalance);
    const profit = parts.reduce((s, p) => s + Number(p.profit), 0);
    expect(profit.toFixed(2)).toBe(all.profit);

    // The spread payment names both branches on the owner's statement, and
    // shows on each branch's as only the part that went there.
    const spread = all.rows.find(
      (r) => r.kind === 'PAYMENT' && r.amount === '500.00',
    )!;
    expect(spread.branches.sort()).toEqual(['Master', 'Mokattam']);
    const mokattam = parts[0].rows.find((r) => r.kind === 'PAYMENT')!;
    expect(mokattam.amount).toBe('450.00');
    expect(mokattam.unapplied).toBeUndefined();
    const master = parts[1].rows.find((r) => r.kind === 'PAYMENT')!;
    expect(master.amount).toBe('50.00');
    // LS2's own payment is not on Master's statement.
    expect(parts[1].rows.filter((r) => r.kind === 'PAYMENT')).toHaveLength(1);
    // The order on no branch is on the owner's statement with no branch named.
    const noneSale = all.rows.find(
      (r) => r.kind === 'SALE' && r.orderId === t.orders.none.data.id,
    )!;
    expect(noneSale.branches).toEqual([]);
  });

  it("refuses another customer's branch on a statement", async () => {
    const t = await trading();
    const other = await owner();
    expect(
      await refusal(
        customers.statement(t.customer.id, { branch: other.b.LS2 }),
      ),
    ).toBe('NOT_FOUND');
  });
});
