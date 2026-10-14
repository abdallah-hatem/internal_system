import { HttpException } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { LedgerController } from './ledger.controller';
import { ROLES_KEY } from '../../common/guards/roles.guard';
import {
  MANUAL_EXPENSE_CATEGORIES,
  OTHER_INCOME_CATEGORIES,
} from '../../common/manual-ledger-categories';
import {
  CAPITALISED_CATEGORIES,
  COST_RECOVERY_CATEGORIES,
} from '../../common/ledger-categories';

/**
 * L6 — a manual ledger entry that can't lie (BUSINESS_LOGIC §9, 2026-10-11).
 *
 * `POST /ledger` saved whatever it was sent: a partner could type category
 * `purchase`, `contribution` or `settlement`, either direction, any amount,
 * any cycle id — and move cash, profit or a settlement without any flow
 * knowing. Every case below was accepted before this.
 */

const CYCLE_ID = '11111111-1111-4111-8111-111111111111';
const CLOSED_ID = '22222222-2222-4222-8222-222222222222';
const CANCELLED_ID = '33333333-3333-4333-8333-333333333333';
const SETTLING_ID = '44444444-4444-4444-8444-444444444444';
const MISSING_ID = '55555555-5555-4555-8555-555555555555';

const CYCLES: Record<string, { id: string; code: string; status: string }> = {
  [CYCLE_ID]: { id: CYCLE_ID, code: 'CYC-2026-001', status: 'SELLING' },
  [CLOSED_ID]: { id: CLOSED_ID, code: 'CYC-2026-002', status: 'CLOSED' },
  [CANCELLED_ID]: {
    id: CANCELLED_ID,
    code: 'CYC-2026-003',
    status: 'CANCELLED',
  },
  [SETTLING_ID]: {
    id: SETTLING_ID,
    code: 'CYC-2026-004',
    status: 'SETTLEMENT',
  },
};

function setup() {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    importCycle: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(CYCLES[where.id] ?? null),
      ),
    },
    financialTransaction: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'tx-new', ...data });
      }),
      // What fixing a running cost's shares reads (§8, L7): the cost just made.
      findMany: jest.fn(({ where }: { where: { cycleId?: unknown } }) =>
        Promise.resolve(
          where.cycleId === null
            ? created
                .filter((d) => !d.cycleId && d.direction === 'OUTFLOW')
                .map((d) => ({
                  ...d,
                  id: 'tx-new',
                  cycleId: null,
                  reversalOfId: null,
                  createdAt: new Date('2026-10-10T23:30:00Z'),
                }))
            : [],
        ),
      ),
    },
    // Three core partners; the third joined after 1 October.
    partner: {
      findMany: jest.fn().mockResolvedValue([
        {
          userId: 'p-1',
          displayName: 'A',
          createdAt: new Date('2026-01-01T08:00:00Z'),
        },
        {
          userId: 'p-2',
          displayName: 'B',
          createdAt: new Date('2026-01-02T08:00:00Z'),
        },
        {
          userId: 'p-3',
          displayName: 'C',
          createdAt: new Date('2026-10-05T08:00:00Z'),
        },
      ]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    runningCostShare: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    runningCostCharge: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const ledger = new LedgerService(prisma as never, audit as never);
  return { ledger, prisma, created, audit };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return {
      status: e.getStatus(),
      ...(e.getResponse() as {
        code: string;
        message: string;
        params?: Record<string, string | number>;
      }),
    };
  }
  throw new Error('expected a refusal, and it was saved');
};

const expense = (over: Record<string, unknown> = {}) => ({
  kind: 'EXPENSE',
  category: 'rent',
  amount: 1500,
  currency: 'EGP',
  occurredOn: '2026-10-01',
  ...over,
});
const income = (over: Record<string, unknown> = {}) => ({
  kind: 'OTHER_INCOME',
  category: 'interest',
  amount: 250,
  currency: 'EGP',
  occurredOn: '2026-10-01',
  ...over,
});

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  // 23:30 UTC on the 10th is 02:30 on the 11th in Cairo.
  jest.setSystemTime(new Date('2026-10-10T23:30:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('a correct manual entry saves', () => {
  it('an expense: money out, type EXPENSE, the date it happened', async () => {
    const { ledger, created, audit } = setup();
    await ledger.create(expense({ note: '  October rent  ' }), 'u-1');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'EXPENSE',
      category: 'rent',
      direction: 'OUTFLOW',
      currency: 'EGP',
      cycleId: null,
      reason: 'October rent',
      createdBy: 'u-1',
    });
    expect(String(created[0].amount)).toBe('1500');
    expect((created[0].occurredOn as Date).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('other income: money in, type OTHER_INCOME', async () => {
    const { ledger, created } = setup();
    await ledger.create(income(), 'u-1');
    expect(created[0]).toMatchObject({
      type: 'OTHER_INCOME',
      category: 'interest',
      direction: 'INFLOW',
    });
  });

  it('a foreign amount is stored in pounds at the rate given, the original kept', async () => {
    const { ledger, created } = setup();
    await ledger.create(
      expense({ amount: 100.5, currency: 'AED', fxRateToEgp: 13.85 }),
      'u-1',
    );
    // The settlement and the dashboard sum `amount` as pounds.
    expect(String(created[0].amount)).toBe('1391.93');
    expect(created[0]).toMatchObject({ currency: 'EGP' });
    expect(String(created[0].fxRateToEgp)).toBe('13.85');
    expect(String(created[0].originalAmount)).toBe('100.5');
    expect(created[0].originalCurrency).toBe('AED');
  });

  it('no date means today in Cairo, not in UTC', async () => {
    const { ledger, created } = setup();
    await ledger.create(expense({ occurredOn: undefined }), 'u-1');
    expect((created[0].occurredOn as Date).toISOString().slice(0, 10)).toBe(
      '2026-10-11',
    );
  });

  it('today in Cairo is not the future, though it is tomorrow in UTC', async () => {
    const { ledger, created } = setup();
    await ledger.create(expense({ occurredOn: '2026-10-11' }), 'u-1');
    expect(created).toHaveLength(1);
  });

  it('extra freight charged to an open cycle saves against that cycle', async () => {
    const { ledger, created } = setup();
    await ledger.create(
      expense({ category: 'extra_freight', cycleId: CYCLE_ID }),
      'u-1',
    );
    expect(created[0]).toMatchObject({
      cycleId: CYCLE_ID,
      category: 'extra_freight',
    });
  });

  it('a cycle being settled still takes a late cost (only closed and cancelled are shut)', async () => {
    const { ledger, created } = setup();
    await ledger.create(expense({ cycleId: SETTLING_ID }), 'u-1');
    expect(created).toHaveLength(1);
  });
});

describe('the category list decides what can be recorded', () => {
  // `cycle_transfer` has its own refusal, LEDGER_CATEGORY_RESERVED (L5).
  const SYSTEM = [
    ...CAPITALISED_CATEGORIES.filter((c) => c !== 'cycle_transfer'),
    ...COST_RECOVERY_CATEGORIES,
    'revenue',
    'refund',
  ];

  it.each(SYSTEM)(
    'system category %s is refused as an expense and as income',
    async (category) => {
      const { ledger, created } = setup();
      for (const body of [expense({ category }), income({ category })]) {
        const r = await refusal(ledger.create(body, 'u-1'));
        expect(r.status).toBe(400);
        expect(r.code).toBe('LEDGER_CATEGORY_NOT_MANUAL');
        expect(r.params).toEqual({ category });
      }
      expect(created).toHaveLength(0);
    },
  );

  it('a transfer between cycles is reserved, whatever kind it is sent as', async () => {
    const { ledger, created } = setup();
    for (const body of [
      expense({ category: 'cycle_transfer' }),
      income({ category: 'cycle_transfer' }),
      { category: 'cycle_transfer', amount: 100, currency: 'EGP' },
    ]) {
      const r = await refusal(ledger.create(body as never, 'u-1'));
      expect(r.code).toBe('LEDGER_CATEGORY_RESERVED');
    }
    expect(created).toHaveLength(0);
  });

  it.each(['Rent', 'misc', '', '  rent'])(
    'free text %p is refused',
    async (category) => {
      const { ledger, created } = setup();
      const r = await refusal(ledger.create(expense({ category }), 'u-1'));
      expect(r.code).toBe('LEDGER_CATEGORY_NOT_MANUAL');
      expect(created).toHaveLength(0);
    },
  );

  it.each(OTHER_INCOME_CATEGORIES)(
    'income category %s is not an expense',
    async (category) => {
      const { ledger } = setup();
      const r = await refusal(ledger.create(expense({ category }), 'u-1'));
      expect(r.code).toBe('LEDGER_CATEGORY_WRONG_KIND');
      expect(r.params).toEqual({ category, kind: 'EXPENSE' });
    },
  );

  it.each(MANUAL_EXPENSE_CATEGORIES)(
    'expense category %s is not income',
    async (category) => {
      const { ledger } = setup();
      const r = await refusal(ledger.create(income({ category }), 'u-1'));
      expect(r.code).toBe('LEDGER_CATEGORY_WRONG_KIND');
    },
  );

  it('an unknown kind is refused', async () => {
    const { ledger, created } = setup();
    for (const kind of [undefined, 'PURCHASE', 'expense']) {
      const r = await refusal(ledger.create(expense({ kind }), 'u-1'));
      expect(r.code).toBe('VALIDATION_FAILED');
    }
    expect(created).toHaveLength(0);
  });
});

describe('a partner’s running-cost share is the payout’s, never typed (§8, L7)', () => {
  it.each([
    ['as an expense', expense({ category: 'running_cost_share' })],
    ['as income', income({ category: 'running_cost_share' })],
  ])(
    'typing a running_cost_share entry %s is refused, nothing written',
    async (_how, body) => {
      const { ledger, created } = setup();
      const r = await refusal(ledger.create(body, 'u-1'));
      expect(r.code).toBe('LEDGER_CATEGORY_NOT_MANUAL');
      expect(created).toHaveLength(0);
    },
  );

  it('reversing one on its own is refused — it belongs to its settlement', async () => {
    const { ledger, prisma, created } = setup();
    Object.assign(prisma.financialTransaction, {
      findUnique: jest.fn().mockResolvedValue({
        id: 'tx-share',
        type: 'RUNNING_COST_CHARGE',
        category: 'running_cost_share',
        direction: 'INFLOW',
        amount: 1000,
        currency: 'EGP',
        cycleId: CYCLE_ID,
        relatedType: 'SETTLEMENT',
        relatedId: 's-1',
        reversalOfId: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    });
    const r = await refusal(
      ledger.reverse('tx-share', 'typed by mistake', 'u-1'),
    );
    expect(r.code).toBe('ENTRY_OWNED_ELSEWHERE');
    expect(created).toHaveLength(0);
  });
});

describe('recording a running cost fixes its shares (§8, L7 review 2026-10-12)', () => {
  it('rent with no cycle: shared by the partners who were partners on its day, stored once', async () => {
    const { ledger, prisma } = setup();
    await ledger.create(
      expense({ amount: 1500, occurredOn: '2026-10-01' }),
      'u-1',
    );
    const calls = prisma.runningCostShare.createMany.mock.calls as unknown[][];
    const call = calls[0][0] as {
      data: { partnerUserId: string; amount: { toFixed(n: number): string } }[];
    };
    // C joined on 5 October: he owes nothing of rent spent on the 1st.
    expect(
      call.data.map((d) => [d.partnerUserId, d.amount.toFixed(2)]),
    ).toEqual([
      ['p-1', '750.00'],
      ['p-2', '750.00'],
    ]);
  });

  it('a cost charged to a cycle, or income, fixes no running-cost shares', async () => {
    const { ledger, prisma } = setup();
    await ledger.create(
      expense({ category: 'extra_freight', cycleId: CYCLE_ID }),
      'u-1',
    );
    await ledger.create(income(), 'u-1');
    expect(prisma.runningCostShare.createMany).not.toHaveBeenCalled();
  });
});

describe('the kind sets the direction and the type', () => {
  it('an expense sent as money in is refused', async () => {
    const { ledger, created } = setup();
    const r = await refusal(
      ledger.create(expense({ direction: 'INFLOW' }), 'u-1'),
    );
    expect(r.code).toBe('LEDGER_DIRECTION_MISMATCH');
    expect(r.params).toEqual({ kind: 'EXPENSE', direction: 'INFLOW' });
    expect(created).toHaveLength(0);
  });

  it('income sent as money out is refused', async () => {
    const { ledger } = setup();
    const r = await refusal(
      ledger.create(income({ direction: 'OUTFLOW' }), 'u-1'),
    );
    expect(r.code).toBe('LEDGER_DIRECTION_MISMATCH');
  });

  it('a matching direction is accepted', async () => {
    const { ledger, created } = setup();
    await ledger.create(expense({ direction: 'OUTFLOW' }), 'u-1');
    expect(created).toHaveLength(1);
  });

  it.each([
    'PURCHASE_COST',
    'PAYMENT_RECEIVED',
    'SETTLEMENT_PAYOUT',
    'CAPITAL_CONTRIBUTION',
    'LENDER_FINANCING',
    'SUPPLIER_REFUND',
    'OTHER_INCOME',
  ])(
    'a system or mismatched type %s is refused on an expense',
    async (type) => {
      const { ledger, created } = setup();
      const r = await refusal(ledger.create(expense({ type }), 'u-1'));
      expect(r.code).toBe('LEDGER_TYPE_NOT_MANUAL');
      expect(created).toHaveLength(0);
    },
  );
});

describe('amounts, rates and dates', () => {
  it.each([0, -5, Number.NaN, '12abc'])(
    'amount %p is refused',
    async (amount) => {
      const { ledger, created } = setup();
      const r = await refusal(ledger.create(expense({ amount }), 'u-1'));
      expect(r.code).toBe('LEDGER_AMOUNT_NOT_POSITIVE');
      expect(created).toHaveLength(0);
    },
  );

  it.each([0, -13.85, undefined])(
    'a foreign currency at rate %p is refused',
    async (fxRateToEgp) => {
      const { ledger, created } = setup();
      const r = await refusal(
        ledger.create(expense({ currency: 'USD', fxRateToEgp }), 'u-1'),
      );
      expect(r.code).toBe('LEDGER_RATE_NOT_POSITIVE');
      expect(r.params).toEqual({ currency: 'USD' });
      expect(created).toHaveLength(0);
    },
  );

  it('pounds at any rate but 1 is refused — it would scale the amount', async () => {
    const { ledger, created } = setup();
    const r = await refusal(
      ledger.create(expense({ currency: 'EGP', fxRateToEgp: 2 }), 'u-1'),
    );
    expect(r.code).toBe('LEDGER_EGP_RATE');
    expect(created).toHaveLength(0);
  });

  it('a currency that is not a code is refused', async () => {
    const { ledger } = setup();
    const r = await refusal(
      ledger.create(expense({ currency: 'pounds' }), 'u-1'),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
  });

  it('a date that has not arrived in Cairo is refused', async () => {
    const { ledger, created } = setup();
    const r = await refusal(
      ledger.create(expense({ occurredOn: '2026-10-12' }), 'u-1'),
    );
    expect(r.code).toBe('DATE_IN_FUTURE');
    expect(r.params).toEqual({ label: 'LEDGER_ENTRY', day: '2026-10-12' });
    expect(created).toHaveLength(0);
  });

  it.each(['2026-02-30', 'yesterday', '2026-1-5'])(
    'a date that is not a day (%s) is refused',
    async (occurredOn) => {
      const { ledger, created } = setup();
      const r = await refusal(ledger.create(expense({ occurredOn }), 'u-1'));
      expect(r.code).toBe('BAD_DATE');
      expect(created).toHaveLength(0);
    },
  );
});

describe('the cycle it is charged to', () => {
  it('extra freight without a cycle is refused', async () => {
    const { ledger, created } = setup();
    const r = await refusal(
      ledger.create(expense({ category: 'extra_freight' }), 'u-1'),
    );
    expect(r.code).toBe('LEDGER_CYCLE_REQUIRED');
    expect(r.params).toEqual({ category: 'extra_freight' });
    expect(created).toHaveLength(0);
  });

  it('a cycle that does not exist is a 404, never a 500', async () => {
    const { ledger, created } = setup();
    for (const cycleId of [MISSING_ID, 'not-a-uuid', 'CYC-2026-001']) {
      const r = await refusal(ledger.create(expense({ cycleId }), 'u-1'));
      expect(r.status).toBe(404);
      expect(r.code).toBe('NOT_FOUND');
      expect(r.params).toEqual({ entity: 'cycle' });
    }
    expect(created).toHaveLength(0);
  });

  it.each([
    ['CLOSED', CLOSED_ID],
    ['CANCELLED', CANCELLED_ID],
  ])('a %s cycle takes nothing more', async (status, cycleId) => {
    const { ledger, created } = setup();
    for (const body of [expense({ cycleId }), income({ cycleId })]) {
      const r = await refusal(ledger.create(body, 'u-1'));
      expect(r.code).toBe('LEDGER_CYCLE_NOT_OPEN');
      expect(r.params).toEqual({ cycle: CYCLES[cycleId].code, status });
    }
    expect(created).toHaveLength(0);
  });
});

describe('who may write an entry', () => {
  it('only a core partner — the office can read the ledger, not write it', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its decorator metadata, never called
      LedgerController.prototype.create,
    ) as string[];
    expect(roles).toEqual(['CORE_PARTNER']);
    const reverse = Reflect.getMetadata(
      ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its decorator metadata, never called
      LedgerController.prototype.reverse,
    ) as string[];
    expect(reverse).toEqual(['CORE_PARTNER']);
  });
});

describe('the second time: reversing a manual entry', () => {
  const reversible = (cycleId: string | null) => {
    const { ledger, prisma, created } = setup();
    Object.assign(prisma.financialTransaction, {
      findUnique: jest.fn().mockResolvedValue({
        id: 'tx-rent',
        type: 'EXPENSE',
        category: 'extra_freight',
        direction: 'OUTFLOW',
        amount: 1391.93,
        currency: 'EGP',
        fxRateToEgp: 13.85,
        originalAmount: 100.5,
        originalCurrency: 'AED',
        occurredOn: new Date('2026-09-01T00:00:00Z'),
        cycleId,
        relatedType: null,
        relatedId: null,
        reversalOfId: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
    });
    return { ledger, created };
  };

  it('is dated the day it is undone in Cairo and keeps what was paid', async () => {
    const { ledger, created } = reversible(CYCLE_ID);
    await ledger.reverse('tx-rent', 'entered twice', 'u-1');
    expect(created[0]).toMatchObject({
      direction: 'INFLOW',
      reversalOfId: 'tx-rent',
      originalAmount: 100.5,
      originalCurrency: 'AED',
    });
    expect((created[0].occurredOn as Date).toISOString().slice(0, 10)).toBe(
      '2026-10-11',
    );
  });

  it.each([
    ['CLOSED', CLOSED_ID],
    ['CANCELLED', CANCELLED_ID],
  ])(
    'is refused on a %s cycle — its profit was already paid out',
    async (status, cycleId) => {
      const { ledger, created } = reversible(cycleId);
      const r = await refusal(
        ledger.reverse('tx-rent', 'late correction', 'u-1'),
      );
      expect(r.code).toBe('LEDGER_CYCLE_NOT_OPEN');
      expect(r.params).toEqual({ cycle: CYCLES[cycleId].code, status });
      expect(created).toHaveLength(0);
    },
  );

  // L7 (§8): a running cost a partner's payout already took cannot simply
  // vanish — he was paid less for it.
  const runningCost = (standing: { code: string }[]) => {
    const made = reversible(null);
    const prisma = (
      made.ledger as unknown as { prisma: Record<string, unknown> }
    ).prisma;
    prisma.runningCostCharge = {
      findMany: jest
        .fn()
        .mockResolvedValue(
          standing.map((c) => ({ settlement: { cycle: { code: c.code } } })),
        ),
    };
    return made;
  };

  it('a running cost already taken from a payout is refused, naming the settlement’s cycle', async () => {
    const { ledger, created } = runningCost([
      { code: 'CYC-2026-007' },
      { code: 'CYC-2026-007' },
    ]);
    const r = await refusal(ledger.reverse('tx-rent', 'wrong month', 'u-1'));
    expect(r.code).toBe('RUNNING_COST_CHARGED');
    expect(r.params).toEqual({ cycles: 'CYC-2026-007' });
    expect(created).toHaveLength(0);
  });

  it('a running cost nobody has been charged for yet reverses as any entry does', async () => {
    const { ledger, created } = runningCost([]);
    await ledger.reverse('tx-rent', 'wrong month', 'u-1');
    expect(created).toHaveLength(1);
  });
});
