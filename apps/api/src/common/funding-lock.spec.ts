/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import { CyclesService } from '../modules/cycles/cycles.service';
import { LendersService } from '../modules/lenders/lenders.service';
import { SettlementsService } from '../modules/settlements/settlements.service';
import { profitBasisOf } from '../modules/settlements/settlement-math';
import { fundingLockOf } from './funding-lock';

/**
 * Funding locks once the settlement is approved (BUSINESS_LOGIC §8, owner
 * 2026-10-18). A contribution, a custom split, a participant added, a friend's
 * payment recorded or removed — each changes what the profit is split on, so
 * none may happen once the split is agreed (APPROVED), paid out (PAID), or the
 * cycle closed. Before that each is allowed, and a draft settlement calculated
 * before the change is refused at approval until it is calculated again.
 *
 * Through the real services over an in-memory database that answers the
 * queries those paths make. The approval's other gates (every unit accounted
 * for, friends repaid, no samples out) are tested where they live; here they
 * pass, so a refusal can only be this one.
 */

jest.mock('./shipment-accounted', () => ({
  assertShipmentAccounted: jest.fn(async () => undefined),
}));
jest.mock('./samples-out', () => ({
  assertCycleHasNoSamplesOut: jest.fn(async () => undefined),
}));
jest.mock('./lender-debt', () => {
  const real = jest.requireActual('./lender-debt');
  return { ...real, assertLendersRepaid: jest.fn(async () => undefined) };
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Row = Record<string, any>;
const ACTOR = randomUUID();

/** `where` as Prisma reads it, for the shapes these paths send. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value?.getTime?.() === cond.getTime();
    if (typeof cond === 'object') {
      if (cond.in) return cond.in.includes(value);
      if (cond.gt instanceof Date)
        return value instanceof Date && value > cond.gt;
      return true;
    }
    return value === cond;
  });
}

function world() {
  const tables: Record<string, Row[]> = {
    importCycle: [],
    settlement: [],
    cycleParticipant: [],
    lenderFinancing: [],
    lender: [],
    purchaseOrder: [],
    user: [],
    financialTransaction: [],
    lenderPlan: [],
  };
  const withRelations = (table: string, row: Row) => {
    if (table === 'cycleParticipant') {
      return {
        ...row,
        cycle: tables.importCycle.find((c) => c.id === row.cycleId),
      };
    }
    if (table === 'lenderFinancing') {
      return {
        ...row,
        lender: tables.lender.find((l) => l.id === row.lenderId),
        purchaseOrder: tables.purchaseOrder.find(
          (p) => p.id === row.purchaseOrderId,
        ),
        cycle: tables.importCycle.find((c) => c.id === row.cycleId),
        repayments: [],
        plans: [],
      };
    }
    if (table === 'purchaseOrder') {
      return {
        ...row,
        cycle: tables.importCycle.find((c) => c.id === row.cycleId),
        items: [{ lineTotal: D(1000) }],
        lenderFinancings: [],
      };
    }
    if (table === 'settlement') {
      return {
        ...row,
        cycle: tables.importCycle.find((c) => c.id === row.cycleId),
        lines: [],
      };
    }
    return row;
  };
  const model = (table: string) => {
    const all = (args: Row = {}) =>
      tables[table].filter((r) => matches(r, args.where));
    const one = async (args: Row) => {
      const row = all(args)[0];
      return row ? withRelations(table, row) : null;
    };
    return {
      findUnique: one,
      findFirst: one,
      findUniqueOrThrow: async (args: Row) => {
        const row = await one(args);
        if (!row) throw new Error(`fake: no ${table}`);
        return row;
      },
      findMany: async (args: Row = {}) =>
        all(args).map((r) => withRelations(table, r)),
      create: async ({ data }: Row) => {
        const now = new Date();
        const row = {
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        tables[table].push(row);
        return withRelations(table, row);
      },
      update: async ({ where, data }: Row) => {
        const row = tables[table].find((r) => matches(r, where));
        if (!row) throw new Error(`fake: no ${table}`);
        Object.assign(row, data, { updatedAt: new Date() });
        return withRelations(table, row);
      },
      updateMany: async ({ where, data }: Row) => {
        const rows = all({ where });
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    };
  };
  const prisma: any = Object.fromEntries(
    Object.keys(tables).map((t) => [t, model(t)]),
  );
  prisma.$queryRaw = async () => [];
  prisma.$transaction = async (cb: (tx: any) => Promise<unknown>) => cb(prisma);

  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    create: jest.fn(),
  } as unknown as NotificationsService;
  const p = prisma as PrismaService;
  return {
    tables,
    cycles: new CyclesService(p, audit, notifications),
    lenders: new LendersService(p, audit, notifications),
    settlements: new SettlementsService(p, audit),
  };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as Row;
    return { status: e.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

/**
 * A cycle the business recognises: three core partners on it, funded
 * equally, one order with a friend's payment on it (nothing repaid), and —
 * when asked — a settlement in the given state.
 */
function cycleWith(
  w: ReturnType<typeof world>,
  opts: { status?: string; settlement?: string } = {},
) {
  const cycle = {
    id: randomUUID(),
    code: 'CYC-2026-0042',
    status: opts.status ?? 'SELLING',
  };
  w.tables.importCycle.push(cycle);
  const partners = [1, 2, 3].map(() => {
    const user = { id: randomUUID(), role: 'CORE_PARTNER', status: 'ACTIVE' };
    w.tables.user.push(user);
    const row = {
      id: randomUUID(),
      cycleId: cycle.id,
      participantType: 'CORE_PARTNER',
      partnerUserId: user.id,
      contributionAmount: D(10000),
      customProfitPct: null,
      investorFeePct: null,
      createdAt: new Date('2026-10-01T08:00:00Z'),
      updatedAt: new Date('2026-10-01T08:00:00Z'),
    };
    w.tables.cycleParticipant.push(row);
    return row;
  });
  const lender = { id: randomUUID(), name: 'Mohammed' };
  w.tables.lender.push(lender);
  const po = { id: randomUUID(), reference: 'PO-2026-0042', cycleId: cycle.id };
  w.tables.purchaseOrder.push(po);
  const financing = {
    id: randomUUID(),
    lenderId: lender.id,
    purchaseOrderId: po.id,
    cycleId: cycle.id,
    currency: 'AED',
    amount: D(1000),
    fxRateToEgp: D(13),
    amountEgp: D(13000),
    paidOn: new Date('2026-10-01T00:00:00Z'),
    ledgerTransactionId: randomUUID(),
    removedAt: null,
    createdAt: new Date('2026-10-01T08:00:00Z'),
  };
  w.tables.lenderFinancing.push(financing);
  let settlement: Row | undefined;
  if (opts.settlement) {
    settlement = {
      id: randomUUID(),
      cycleId: cycle.id,
      status: opts.settlement,
      calculatedAt: new Date('2026-10-05T08:00:00Z'),
    };
    w.tables.settlement.push(settlement);
  }
  return { cycle, partners, lender, po, financing, settlement };
}

const outsider = (w: ReturnType<typeof world>) => {
  const user = { id: randomUUID(), role: 'TEMP_INVESTOR', status: 'ACTIVE' };
  w.tables.user.push(user);
  return user;
};

/** The three ways funding is locked, as the business reaches them. */
const LOCKED = [
  {
    name: 'an APPROVED settlement',
    status: 'SETTLEMENT',
    settlement: 'APPROVED',
    reason: 'SETTLEMENT_APPROVED',
  },
  {
    name: 'a PAID settlement',
    status: 'CLOSED',
    settlement: 'PAID',
    reason: 'SETTLEMENT_PAID',
  },
  {
    name: 'a CLOSED cycle with no settlement',
    status: 'CLOSED',
    settlement: undefined,
    reason: 'CYCLE_CLOSED',
  },
] as const;

// ─── Contributions and participants ───────────────────────────────────────

describe('a contribution cannot change once the settlement is approved', () => {
  for (const c of LOCKED) {
    it(`editing a contribution with ${c.name} is refused, coded, and nothing is written`, async () => {
      const w = world();
      const { partners } = cycleWith(w, c);
      const r = await refusal(
        w.cycles.updateParticipant(
          partners[0].id,
          { contributionAmount: 99999 },
          ACTOR,
        ),
      );
      expect(r).toMatchObject({
        status: 400,
        code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
        params: { reason: c.reason },
      });
      expect(partners[0].contributionAmount.toFixed(2)).toBe('10000.00');
      expect(w.tables.financialTransaction).toHaveLength(0);
    });

    it(`Split equally (one edit per partner) with ${c.name} changes nobody`, async () => {
      const w = world();
      const { partners } = cycleWith(w, c);
      for (const p of partners) {
        const r = await refusal(
          w.cycles.updateParticipant(
            p.id,
            { contributionAmount: 4997.32 },
            ACTOR,
          ),
        );
        expect(r.code).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
      }
      expect(partners.map((p) => p.contributionAmount.toFixed(2))).toEqual([
        '10000.00',
        '10000.00',
        '10000.00',
      ]);
    });

    it(`a custom split set with ${c.name} is refused too`, async () => {
      const w = world();
      const { partners } = cycleWith(w, c);
      const r = await refusal(
        w.cycles.updateParticipant(
          partners[0].id,
          { customProfitPct: 50 },
          ACTOR,
        ),
      );
      expect(r.code).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
      expect(partners[0].customProfitPct).toBeNull();
    });
  }

  it('adding a participant once the settlement is approved or paid is refused, coded', async () => {
    // Paid closes the cycle, which keeps its own older refusal; a PAID
    // settlement on a cycle not (yet) closed is locked by this rule.
    const cases = [
      { ...LOCKED[0], code: 'FUNDING_LOCKED_AFTER_SETTLEMENT' },
      { ...LOCKED[1], code: 'CYCLE_CLOSED_NO_PARTICIPANTS' },
      {
        ...LOCKED[1],
        name: 'a PAID settlement, cycle reopened',
        status: 'SELLING',
        code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
      },
    ];
    for (const c of cases) {
      const w = world();
      const { cycle } = cycleWith(w, c);
      const investor = outsider(w);
      const r = await refusal(
        w.cycles.addParticipant(
          cycle.id,
          {
            participantType: 'TEMP_INVESTOR',
            investorUserId: investor.id,
            contributionAmount: 5000,
          },
          ACTOR,
        ),
      );
      expect([c.name, r.status, r.code]).toEqual([c.name, 400, c.code]);
      expect(w.tables.cycleParticipant).toHaveLength(3);
    }
  });

  it('adding a participant to a closed cycle is still refused (its own code)', async () => {
    const w = world();
    const { cycle } = cycleWith(w, LOCKED[2]);
    const r = await refusal(
      w.cycles.addParticipant(
        cycle.id,
        {
          participantType: 'TEMP_INVESTOR',
          investorUserId: outsider(w).id,
          contributionAmount: 5000,
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('CYCLE_CLOSED_NO_PARTICIPANTS');
    expect(w.tables.cycleParticipant).toHaveLength(3);
  });
});

describe('before approval, funding may change', () => {
  for (const settlement of [undefined, 'DRAFT', 'REVERSED']) {
    it(`with ${settlement ?? 'no'} settlement a contribution is edited and its ledger row written`, async () => {
      const w = world();
      const { partners } = cycleWith(w, { settlement });
      await w.cycles.updateParticipant(
        partners[0].id,
        { contributionAmount: 12000 },
        ACTOR,
      );
      expect(partners[0].contributionAmount).toBe(12000);
      expect(w.tables.financialTransaction).toHaveLength(1);
      expect(w.tables.financialTransaction[0].amount.toFixed(2)).toBe(
        '2000.00',
      );
    });
  }

  it('the second time: editing twice before approval works both times', async () => {
    const w = world();
    const { partners } = cycleWith(w);
    await w.cycles.updateParticipant(
      partners[0].id,
      { contributionAmount: 12000 },
      ACTOR,
    );
    await w.cycles.updateParticipant(
      partners[0].id,
      { contributionAmount: 11000 },
      ACTOR,
    );
    expect(partners[0].contributionAmount).toBe(11000);
  });

  it('an investor is added while the cycle is selling', async () => {
    const w = world();
    const { cycle } = cycleWith(w);
    await w.cycles.addParticipant(
      cycle.id,
      {
        participantType: 'TEMP_INVESTOR',
        investorUserId: outsider(w).id,
        contributionAmount: 5000,
      },
      ACTOR,
    );
    expect(w.tables.cycleParticipant).toHaveLength(4);
  });

  it('a participant that does not exist is a 404, not a 500', async () => {
    const w = world();
    cycleWith(w);
    const r = await refusal(
      w.cycles.updateParticipant(
        randomUUID(),
        { contributionAmount: 1 },
        ACTOR,
      ),
    );
    expect(r).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

// ─── A friend's payment ────────────────────────────────────────────────────

describe("a friend's payment is locked with the rest of the funding", () => {
  for (const c of LOCKED) {
    it(`removing it with ${c.name} is refused, coded, and it still stands`, async () => {
      const w = world();
      const { financing } = cycleWith(w, c);
      const r = await refusal(
        w.lenders.removeFinancing(
          financing.id,
          'he did not pay after all',
          ACTOR,
        ),
      );
      expect(r).toMatchObject({
        status: 400,
        code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
        params: { reason: c.reason },
      });
      expect(financing.removedAt).toBeNull();
      expect(w.tables.financialTransaction).toHaveLength(0);
    });
  }

  it('recording one on a cycle being settled or closed is refused, coded', async () => {
    for (const c of LOCKED) {
      const w = world();
      const { po } = cycleWith(w, c);
      const r = await refusal(
        w.lenders.finance(
          po.id,
          { lenderId: w.tables.lender[0].id, amount: 10 },
          ACTOR,
        ),
      );
      expect([c.name, r.status, r.code]).toEqual([
        c.name,
        400,
        'CYCLE_CLOSED_FOR_FINANCING',
      ]);
    }
  });

  it('recording one where an approved settlement stands on a cycle not marked settling is refused by the lock', async () => {
    const w = world();
    const { po } = cycleWith(w, { status: 'SELLING', settlement: 'APPROVED' });
    const r = await refusal(
      w.lenders.finance(
        po.id,
        { lenderId: w.tables.lender[0].id, amount: 10 },
        ACTOR,
      ),
    );
    expect(r).toMatchObject({
      status: 400,
      code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
    });
    expect(w.tables.lenderFinancing).toHaveLength(1);
  });

  it('before approval it is removed, with its balancing ledger row', async () => {
    const w = world();
    const { financing } = cycleWith(w, { settlement: 'DRAFT' });
    await w.lenders.removeFinancing(
      financing.id,
      'he did not pay after all',
      ACTOR,
    );
    expect(financing.removedAt).toBeInstanceOf(Date);
    expect(w.tables.financialTransaction).toHaveLength(1);
    expect(w.tables.financialTransaction[0].direction).toBe('OUTFLOW');
  });
});

// ─── A draft calculated before the funding changed ───────────────────────

describe('approving a draft calculated before the funding changed', () => {
  it('is refused after a contribution was edited, coded; the cycle does not move', async () => {
    const w = world();
    const { cycle, partners, settlement } = cycleWith(w, {
      settlement: 'DRAFT',
    });
    await w.cycles.updateParticipant(
      partners[1].id,
      { contributionAmount: 15000 },
      ACTOR,
    );
    const r = await refusal(w.settlements.approve(settlement!.id, ACTOR));
    expect(r).toMatchObject({ status: 400, code: 'SETTLEMENT_STALE_FUNDING' });
    expect(settlement!.status).toBe('DRAFT');
    expect(cycle.status).toBe('SELLING');
  });

  it("is refused after a friend's payment was removed", async () => {
    const w = world();
    const { financing, settlement } = cycleWith(w, { settlement: 'DRAFT' });
    await w.lenders.removeFinancing(
      financing.id,
      'recorded on the wrong cycle',
      ACTOR,
    );
    const r = await refusal(w.settlements.approve(settlement!.id, ACTOR));
    expect(r.code).toBe('SETTLEMENT_STALE_FUNDING');
  });

  it('is refused after a participant was added', async () => {
    const w = world();
    const { cycle, settlement } = cycleWith(w, { settlement: 'DRAFT' });
    await w.cycles.addParticipant(
      cycle.id,
      {
        participantType: 'TEMP_INVESTOR',
        investorUserId: outsider(w).id,
        contributionAmount: 5000,
      },
      ACTOR,
    );
    const r = await refusal(w.settlements.approve(settlement!.id, ACTOR));
    expect(r.code).toBe('SETTLEMENT_STALE_FUNDING');
  });

  it('a draft calculated after the last change approves, and then funding is locked', async () => {
    const w = world();
    const { cycle, partners, settlement } = cycleWith(w, {
      settlement: 'DRAFT',
    });
    await w.settlements.approve(settlement!.id, ACTOR);
    expect(settlement!.status).toBe('APPROVED');
    expect(cycle.status).toBe('SETTLEMENT');
    const r = await refusal(
      w.cycles.updateParticipant(
        partners[0].id,
        { contributionAmount: 1 },
        ACTOR,
      ),
    );
    expect(r.code).toBe('FUNDING_LOCKED_AFTER_SETTLEMENT');
  });
});

// ─── The readings the cycle page uses ──────────────────────────────────────

describe('fundingLockOf', () => {
  it('names why, PAID before APPROVED before CLOSED; nothing before approval', () => {
    expect(fundingLockOf('SELLING', [])).toBeNull();
    expect(
      fundingLockOf('SELLING', [{ status: 'DRAFT' }, { status: 'REVERSED' }]),
    ).toBeNull();
    expect(fundingLockOf('SETTLEMENT', [{ status: 'APPROVED' }])).toBe(
      'SETTLEMENT_APPROVED',
    );
    expect(
      fundingLockOf('CLOSED', [{ status: 'REVERSED' }, { status: 'PAID' }]),
    ).toBe('SETTLEMENT_PAID');
    expect(fundingLockOf('CLOSED', [])).toBe('CYCLE_CLOSED');
    expect(fundingLockOf('CANCELLED', [])).toBeNull();
  });

  it('the cycle as the page reads it carries the reason', async () => {
    const w = world();
    const { cycle } = cycleWith(w, {
      status: 'SETTLEMENT',
      settlement: 'APPROVED',
    });
    w.tables.importCycle[0].settlements = w.tables.settlement;
    const { data } = await w.cycles.findById(cycle.id);
    expect((data as Row).fundingLock).toBe('SETTLEMENT_APPROVED');
  });
});

describe('profitBasisOf — the note shows exactly when settling would refuse', () => {
  const p = (contribution: number, extra: Row = {}) => ({
    type: 'CORE_PARTNER' as const,
    contribution: D(contribution),
    customProfitPct: null,
    ...extra,
  });

  it('zero contributions, nobody paid: NONE', () => {
    expect(profitBasisOf([p(0), p(0), p(0)])).toBe('NONE');
  });
  it('zero contributions, a friend paid only part: still NONE', () => {
    expect(profitBasisOf([p(0), p(0), p(0)], { fundedByLenders: false })).toBe(
      'NONE',
    );
  });
  it('zero contributions, a friend paid it all: LENDERS', () => {
    expect(profitBasisOf([p(0), p(0), p(0)], { fundedByLenders: true })).toBe(
      'LENDERS',
    );
  });
  it('a friend paid it all but no core partner is on it: NONE', () => {
    expect(
      profitBasisOf([{ ...p(0), type: 'TEMP_INVESTOR' as const }], {
        fundedByLenders: true,
      }),
    ).toBe('NONE');
  });
  it('any contribution: CONTRIBUTIONS', () => {
    expect(profitBasisOf([p(0), p(0.01), p(0)])).toBe('CONTRIBUTIONS');
  });
  it('an agreed split: CUSTOM_SPLIT, whatever was put in', () => {
    expect(
      profitBasisOf([
        p(0, { customProfitPct: D(50) }),
        p(0, { customProfitPct: D(50) }),
      ]),
    ).toBe('CUSTOM_SPLIT');
  });
});
