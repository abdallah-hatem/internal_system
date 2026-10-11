/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- refusal bodies are untyped records */
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import {
  CAPITALISED_CATEGORIES,
  NOT_CASH_CATEGORIES,
  NOT_OPERATING_EXPENSE,
  transferNetEgp,
} from './ledger-categories';
import {
  planTransferLines,
  sourceRefusal,
  targetRefusal,
  toFundEgp,
  undoRefusal,
  type ShelfBatch,
} from './stock-transfers';

/**
 * L5 — the rules of moving leftovers between cycles, as pure functions
 * (BUSINESS_LOGIC §8, 2026-10-11). The service runs exactly these; the
 * in-memory runs through the service are `modules/stock-transfers/*.spec.ts`.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return (e.getResponse() as any).code as string;
  }
  return null;
};
const refusalCode = (e: HttpException | null) =>
  e ? ((e.getResponse() as any).code as string) : null;

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
const batch = (over: Partial<ShelfBatch> & { id: string }): ShelfBatch => ({
  productId: 'pad',
  productName: 'Brake pad',
  saleableQty: 10,
  heldQty: 0,
  landedUnitCostEgp: 110,
  createdAt: day(1),
  ...over,
});

describe('planTransferLines — how many of what, from which batch', () => {
  const shelf = [
    // Listed newest first on purpose: the plan must still take the oldest.
    batch({
      id: 'b2',
      saleableQty: 15,
      landedUnitCostEgp: '120.5',
      createdAt: day(20),
    }),
    batch({
      id: 'b1',
      saleableQty: 10,
      landedUnitCostEgp: 110,
      createdAt: day(5),
    }),
  ];

  it('a partial move takes the oldest check-in first and costs each part at its own batch', () => {
    const lines = planTransferLines(shelf, [{ productId: 'pad', qty: 12 }]);
    expect(
      lines.map((l) => [
        l.sourceBatchId,
        l.qty.toNumber(),
        l.unitCostEgp.toString(),
        l.costEgp.toFixed(2),
      ]),
    ).toEqual([
      ['b1', 10, '110', '1100.00'],
      ['b2', 2, '120.5', '241.00'],
    ]);
  });

  it('moving everything empties every batch of it', () => {
    const lines = planTransferLines(shelf, [{ productId: 'pad', qty: 25 }]);
    expect(lines.reduce((s, l) => s.add(l.qty), D(0)).toNumber()).toBe(25);
    expect(lines.map((l) => l.sourceBatchId)).toEqual(['b1', 'b2']);
  });

  it('more than is on the shelf is refused, naming what is there', () => {
    let body: any;
    try {
      planTransferLines(shelf, [{ productId: 'pad', qty: 26 }]);
    } catch (e) {
      body = (e as HttpException).getResponse();
    }
    expect(body).toMatchObject({
      code: 'TRANSFER_MORE_THAN_ON_SHELF',
      params: { product: 'Brake pad', available: '25', requested: '26' },
    });
  });

  it('units held for a shop request are not on the shelf to move', () => {
    const held = [batch({ id: 'b1', saleableQty: 10, heldQty: 4 })];
    expect(
      code(() => planTransferLines(held, [{ productId: 'pad', qty: 7 }])),
    ).toBe('TRANSFER_MORE_THAN_ON_SHELF');
    expect(
      planTransferLines(held, [{ productId: 'pad', qty: 6 }])[0].qty.toNumber(),
    ).toBe(6);
  });

  it('a product the cycle never had has a shelf of zero — refused, by its name', () => {
    let body: any;
    try {
      planTransferLines(
        shelf,
        [{ productId: 'chain', qty: 1 }],
        new Map([['chain', 'Chain kit']]),
      );
    } catch (e) {
      body = (e as HttpException).getResponse();
    }
    expect(body).toMatchObject({
      code: 'TRANSFER_MORE_THAN_ON_SHELF',
      params: { product: 'Chain kit', available: '0' },
    });
  });

  it.each([0, -3, 'abc', Number.NaN, Infinity])(
    'a quantity of %p is refused',
    (qty) => {
      expect(
        code(() => planTransferLines(shelf, [{ productId: 'pad', qty: qty }])),
      ).toBe('TRANSFER_QTY_NOT_POSITIVE');
    },
  );

  it('no lines at all, or one product twice, is refused', () => {
    expect(code(() => planTransferLines(shelf, []))).toBe('TRANSFER_NO_LINES');
    expect(
      code(() =>
        planTransferLines(shelf, [
          { productId: 'pad', qty: 1 },
          { productId: 'pad', qty: 1 },
        ]),
      ),
    ).toBe('TRANSFER_DUPLICATE_PRODUCT');
  });

  it('a third of a unit costs to the piastre, never more than the batch is worth', () => {
    const lines = planTransferLines(
      [batch({ id: 'b', saleableQty: 3, landedUnitCostEgp: '33.3333' })],
      [{ productId: 'pad', qty: 3 }],
    );
    expect(lines[0].costEgp.toFixed(2)).toBe('100.00');
  });
});

describe('who can give, who can take', () => {
  const cycle = (status: string, id = 'a', code = 'CYC-A') => ({
    id,
    code,
    status,
  });

  it.each(['SELLING', 'SETTLEMENT'])(
    'a cycle %s can hand leftovers on',
    (s) => {
      expect(sourceRefusal(cycle(s), { paid: false })).toBeNull();
    },
  );
  it.each([
    'PLANNING',
    'PURCHASING',
    'IN_TRANSIT',
    'ARRIVED_EGYPT',
    'VERIFICATION',
    'CLOSED',
    'CANCELLED',
  ])('a cycle %s cannot', (s) => {
    expect(refusalCode(sourceRefusal(cycle(s), { paid: false }))).toBe(
      'TRANSFER_SOURCE_NOT_SELLING',
    );
  });
  it('a cycle already paid out cannot, even if reopened to settlement', () => {
    expect(
      refusalCode(sourceRefusal(cycle('SETTLEMENT'), { paid: true })),
    ).toBe('TRANSFER_SOURCE_PAID');
  });

  it('never to itself', () => {
    expect(refusalCode(targetRefusal(cycle('SELLING'), cycle('SELLING')))).toBe(
      'TRANSFER_SAME_CYCLE',
    );
  });
  it.each(['SETTLEMENT', 'CLOSED', 'CANCELLED'])('never to a cycle %s', (s) => {
    expect(
      refusalCode(targetRefusal(cycle('SELLING'), cycle(s, 'b', 'CYC-B'))),
    ).toBe('TRANSFER_TARGET_CLOSED');
  });
  it.each(['PLANNING', 'FUNDING', 'IN_TRANSIT', 'ARRIVED_EGYPT', 'SELLING'])(
    'to a cycle %s is fine',
    (s) => {
      expect(
        targetRefusal(cycle('SELLING'), cycle(s, 'b', 'CYC-B')),
      ).toBeNull();
    },
  );
});

describe('undo — only while nothing has happened to the units in B and A is not paid out', () => {
  const untouched = {
    remainingQty: 20,
    saleableQty: 20,
    reservedQty: 0,
    allocations: 0,
    reservations: 0,
    returns: 0,
    movedOn: 0,
  };
  const input = (
    over: Partial<Parameters<typeof undoRefusal>[0]> = {},
    dest: any = untouched,
  ) => ({
    status: 'ACTIVE',
    from: { id: 'a', code: 'CYC-A', status: 'SELLING' },
    fromPaid: false,
    to: { id: 'b', code: 'CYC-B', status: 'SELLING' },
    lines: [{ productName: 'Brake pad', qty: 20, dest }],
    ...over,
  });

  it('untouched: allowed', () => {
    expect(undoRefusal(input())).toBeNull();
  });
  it('after a sale in B: refused', () => {
    expect(
      refusalCode(
        undoRefusal(
          input(
            {},
            { ...untouched, remainingQty: 15, saleableQty: 15, allocations: 1 },
          ),
        ),
      ),
    ).toBe('TRANSFER_UNITS_SOLD');
  });
  it('after a sale in B that was cancelled (units back, history stays): still refused', () => {
    expect(
      refusalCode(undoRefusal(input({}, { ...untouched, allocations: 1 }))),
    ).toBe('TRANSFER_UNITS_SOLD');
  });
  it('with units held for a request, or moved on again: refused', () => {
    expect(
      refusalCode(undoRefusal(input({}, { ...untouched, reservations: 1 }))),
    ).toBe('TRANSFER_UNITS_SOLD');
    expect(
      refusalCode(
        undoRefusal(
          input(
            {},
            { ...untouched, remainingQty: 0, saleableQty: 0, movedOn: 1 },
          ),
        ),
      ),
    ).toBe('TRANSFER_UNITS_SOLD');
  });
  it('after A is paid out: refused', () => {
    expect(refusalCode(undoRefusal(input({ fromPaid: true })))).toBe(
      'TRANSFER_SOURCE_PAID',
    );
    expect(
      refusalCode(
        undoRefusal(
          input({ from: { id: 'a', code: 'CYC-A', status: 'CLOSED' } }),
        ),
      ),
    ).toBe('TRANSFER_SOURCE_PAID');
  });
  it('B settling or closed: refused', () => {
    expect(
      refusalCode(
        undoRefusal(
          input({ to: { id: 'b', code: 'CYC-B', status: 'SETTLEMENT' } }),
        ),
      ),
    ).toBe('TRANSFER_TARGET_CLOSED');
  });
  it('twice: refused', () => {
    expect(refusalCode(undoRefusal(input({ status: 'REVERSED' })))).toBe(
      'TRANSFER_ALREADY_UNDONE',
    );
  });
});

describe('money', () => {
  it("B's cost to fund rises by exactly what was moved in", () => {
    const before = toFundEgp({
      landed: '10000.00',
      transferredIn: 0,
      financed: 0,
    }).toFund;
    const after = toFundEgp({
      landed: '10000.00',
      transferredIn: '2200.00',
      financed: 0,
    }).toFund;
    expect(after.sub(before).toFixed(2)).toBe('2200.00');
  });
  it('a friend who paid more than the goods still leaves the moved-in stock to fund', () => {
    expect(
      toFundEgp({
        landed: 1000,
        transferredIn: 500,
        financed: 1200,
      }).toFund.toFixed(2),
    ).toBe('300.00');
    expect(
      toFundEgp({
        landed: 1000,
        transferredIn: 0,
        financed: 1200,
      }).toFund.toFixed(2),
    ).toBe('0.00');
  });

  it('a transfer is not an expense, not a recovery, and not cash', () => {
    expect(CAPITALISED_CATEGORIES).toContain('cycle_transfer');
    expect(NOT_OPERATING_EXPENSE).toContain('cycle_transfer');
    expect(NOT_CASH_CATEGORIES).toEqual(['cycle_transfer']);
  });

  it('transferNetEgp: taking stock on adds to a cycle’s cost, handing it on takes it off, undoing nets to zero', () => {
    const out = {
      direction: 'INFLOW',
      category: 'cycle_transfer',
      amount: '2200.00',
    };
    const into = {
      direction: 'OUTFLOW',
      category: 'cycle_transfer',
      amount: '2200.00',
    };
    expect(transferNetEgp([out]).toFixed(2)).toBe('-2200.00');
    expect(transferNetEgp([into]).toFixed(2)).toBe('2200.00');
    expect(
      transferNetEgp([into, { ...into, direction: 'INFLOW' }]).toFixed(2),
    ).toBe('0.00');
    expect(
      transferNetEgp([
        { direction: 'OUTFLOW', category: 'purchase', amount: 9 },
      ]).toFixed(2),
    ).toBe('0.00');
  });
});
