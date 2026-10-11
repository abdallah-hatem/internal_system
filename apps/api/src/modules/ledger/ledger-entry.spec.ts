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
    },
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
  const SYSTEM = [
    ...CAPITALISED_CATEGORIES,
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
        accountId: null,
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
});
