/**
 * The guards of the one-off CYC-2026-0001 correction
 * (prisma/one-off/2026-10-23-cyc-0001-extras.ts): where it may write, the
 * starting facts it insists on, and that a second run is refused.
 */
import {
  COPY_DB,
  EXTRAS,
  FINANCING,
  LENDER_NAME,
  NEW_CATEGORIES,
  PO_REFERENCE,
  REPAYMENTS,
  assertTarget,
  decideRun,
  startingFactMismatches,
  stepsDone,
  type CorrectionState,
  type RunDecision,
} from '../../prisma/one-off/2026-10-23-cyc-0001-extras.guards';

/** The reason of a refusal; fails the test when the run was not refused. */
function refusal(d: RunDecision): string {
  if (d.action !== 'refuse')
    throw new Error(`expected a refusal, got ${d.action}`);
  return d.reason;
}

const LOCAL_COPY = `postgresql://postgres:postgres@localhost:5432/${COPY_DB}`;
const NEON =
  'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require';

const lines5 = [45, 70, 70, 30, 15].map((q, i) => ({
  purchaseOrderItemId: `poi${i}`,
  qty: String(q),
}));

/** Production's CYC-2026-0001 as it stood on 2026-10-23 (the dump of 05:08). */
function production(): CorrectionState {
  return {
    cycle: {
      id: 'c1',
      code: 'CYC-2026-0001',
      status: 'SELLING',
      originType: 'CHINA',
    },
    orders: [
      {
        id: 'po1',
        reference: PO_REFERENCE,
        currency: 'AED',
        fxRateToEgp: '13.8500',
        orderedOn: '2026-06-13',
        items: [
          {
            id: 'poi0',
            productName: 'Q58 Max',
            orderedQty: '45',
            unitPrice: '36.4567',
            lineTotal: '1640.55',
          },
          {
            id: 'poi1',
            productName: 'Y30',
            orderedQty: '70',
            unitPrice: '23.5566',
            lineTotal: '1648.96',
          },
          {
            id: 'poi2',
            productName: 'Y20 MAX',
            orderedQty: '70',
            unitPrice: '29.5393',
            lineTotal: '2067.75',
          },
          {
            id: 'poi3',
            productName: 'Y20 FM',
            orderedQty: '30',
            unitPrice: '24.8657',
            lineTotal: '745.97',
          },
          {
            id: 'poi4',
            productName: 'Y12 PRO',
            orderedQty: '15',
            unitPrice: '27.1087',
            lineTotal: '406.63',
          },
        ],
      },
    ],
    legs: [
      {
        id: 'leg1',
        sequence: 1,
        costBasis: 'FLAT',
        amount: '1551.74',
        currency: 'AED',
        fxRateToEgp: '13.8500',
        ratePerUnit: null,
        chargeablePieces: null,
        departures: [{ id: 'dep1', day: '2026-07-20', lines: lines5 }],
        deliveries: [
          {
            id: 'del1',
            day: '2026-08-10',
            lines: lines5.map((l, i) => ({ ...l, id: `dl1-${i}` })),
          },
        ],
      },
      {
        id: 'leg2',
        sequence: 2,
        costBasis: 'PER_PIECE',
        amount: '4600.00',
        currency: 'AED',
        fxRateToEgp: '14.0000',
        ratePerUnit: '20',
        chargeablePieces: '230',
        departures: [{ id: 'dep2', day: '2026-08-28', lines: lines5 }],
        deliveries: [
          {
            id: 'del2',
            day: '2026-09-09',
            lines: lines5.map((l, i) => ({ ...l, id: `dl2-${i}` })),
          },
        ],
      },
    ],
    batches: lines5.map((l, i) => ({
      id: `b${i}`,
      sourcePoItemId: l.purchaseOrderItemId,
      sourceDeliveryLineId: `dl2-${i}`,
      receivedQty: l.qty,
    })),
    losses: 0,
    standingTransfers: 0,
    standingSettlements: 0,
    financings: [
      {
        id: 'f0',
        lender: LENDER_NAME,
        purchaseOrderId: 'po1',
        amount: '6509.86',
        currency: 'AED',
        fxRateToEgp: '13.8500',
        paidOn: '2026-07-15',
        removed: true,
        repayments: [],
      },
      {
        id: 'f1',
        lender: LENDER_NAME,
        purchaseOrderId: 'po1',
        amount: '8302.60',
        currency: 'AED',
        fxRateToEgp: '13.8500',
        paidOn: '2026-07-15',
        removed: false,
        repayments: [],
      },
    ],
    bankFeesEgp: '3338.82',
    contributions: [
      { id: 'p1', type: 'CORE_PARTNER', amount: '21466.99' },
      { id: 'p2', type: 'CORE_PARTNER', amount: '21466.99' },
      { id: 'p3', type: 'CORE_PARTNER', amount: '21467.00' },
    ],
    categoriesPresent: [],
    productsPresent: [],
  };
}

/** The same cycle once the whole correction ran. */
function corrected(): CorrectionState {
  const s = production();
  const extra = EXTRAS.map((e, i) => ({
    id: `x${i}`,
    productName: e.name,
    orderedQty: String(e.qty),
    unitPrice: String(e.unitPrice),
    lineTotal: (e.qty * e.unitPrice).toFixed(2),
  }));
  s.orders[0].items.push(...extra);
  s.batches.push(
    ...extra.map((x, i) => ({
      id: `xb${i}`,
      sourcePoItemId: x.id,
      sourceDeliveryLineId: `xdl${i}`,
      receivedQty: x.orderedQty,
    })),
  );
  Object.assign(s.legs[1], { costBasis: 'FLAT', amount: '5250.00' });
  s.financings[1].removed = true;
  s.financings.push({
    id: 'f2',
    lender: LENDER_NAME,
    purchaseOrderId: 'po1',
    amount: '13905.69',
    currency: 'AED',
    fxRateToEgp: '13.9066',
    paidOn: FINANCING.paidOn,
    removed: false,
    repayments: REPAYMENTS.map((r) => ({
      paidOn: r.paidOn,
      amountEgp: r.amountEgp ?? '69064.93',
      rateToEgp: String(r.rateToEgp),
    })),
  });
  s.contributions.forEach((p) => (p.amount = '67056.33'));
  s.categoriesPresent = NEW_CATEGORIES.map((c) => c.name);
  s.productsPresent = EXTRAS.map((e) => e.name);
  return s;
}

describe('where the correction may write', () => {
  it('writes to the local copy without a flag', () => {
    expect(assertTarget(LOCAL_COPY, [])).toEqual({
      host: 'localhost',
      db: COPY_DB,
      production: false,
    });
  });

  it("refuses the developer's database, and any other, without --production", () => {
    expect(() =>
      assertTarget(
        'postgresql://postgres:postgres@localhost:5432/motorcycle_parts',
        [],
      ),
    ).toThrow(/Refusing to write to motorcycle_parts on localhost/);
    expect(() =>
      assertTarget(
        'postgresql://postgres:postgres@localhost:5432/motorcycle_parts_alice',
        ['--plan'],
      ),
    ).toThrow(/Refusing/);
    expect(() => assertTarget(NEON, [])).toThrow(/Refusing to write to neondb/);
  });

  it('refuses a remote database merely named like the copy', () => {
    expect(() =>
      assertTarget(`postgresql://u:p@db.example.com/${COPY_DB}`, []),
    ).toThrow(/Refusing/);
  });

  it('writes to production only with --production, and never to a database on this machine with it', () => {
    expect(assertTarget(NEON, ['--production'])).toMatchObject({
      db: 'neondb',
      production: true,
    });
    expect(() =>
      assertTarget(
        'postgresql://postgres:postgres@localhost:5432/motorcycle_parts',
        ['--production'],
      ),
    ).toThrow(/on this machine/);
    expect(() => assertTarget(LOCAL_COPY, ['--production'])).toThrow(
      /on this machine/,
    );
  });

  it('refuses when DATABASE_URL is missing or not a URL', () => {
    expect(() => assertTarget(undefined, [])).toThrow(/not set/);
    expect(() => assertTarget('not a url', ['--production'])).toThrow(
      /not set/,
    );
  });
});

describe('the starting facts', () => {
  it('accepts production as it stood', () => {
    expect(startingFactMismatches(production())).toEqual([]);
    expect(decideRun(production(), [])).toEqual({ action: 'fresh' });
  });

  it.each<[string, (s: CorrectionState) => void, RegExp]>([
    [
      'leg 2 already re-priced',
      (s) => Object.assign(s.legs[1], { amount: '4650.00' }),
      /leg 2 is PER_PIECE/,
    ],
    [
      'a line was added to the order',
      (s) => s.orders[0].items.pop(),
      /4 lines, not 5/,
    ],
    [
      'the cycle moved on',
      (s) => (s.cycle!.status = 'SETTLEMENT'),
      /status is SETTLEMENT/,
    ],
    [
      'a repayment exists',
      (s) =>
        s.financings[1].repayments.push({
          paidOn: '2026-08-15',
          amountEgp: '1',
          rateToEgp: '14',
        }),
      /standing repayments/,
    ],
    [
      'his payment is a different figure',
      (s) => (s.financings[1].amount = '8655.69'),
      /not 8,302.60 AED/,
    ],
    [
      'a second friend paid',
      (s) =>
        s.financings.push({
          ...s.financings[1],
          id: 'f9',
          lender: 'Mohammed abo setta',
        }),
      /2 friends' payments stand/,
    ],
    [
      'contributions changed',
      (s) => (s.contributions[0].amount = '30000.00'),
      /contributions are/,
    ],
    ['the card fee was reversed', (s) => (s.bankFeesEgp = '0.00'), /bank_fees/],
    [
      'a delivery on another day',
      (s) => (s.legs[1].deliveries[0].day = '2026-09-10'),
      /not 2026-09-09/,
    ],
    ['a loss recorded', (s) => (s.losses = 1), /losses/],
    [
      'a settlement drafted',
      (s) => (s.standingSettlements = 1),
      /settlements stand/,
    ],
  ])('stops when %s', (_, change, expected) => {
    const s = production();
    change(s);
    expect(startingFactMismatches(s).join('\n')).toMatch(expected);
    const decision = decideRun(s, ['--production']);
    expect(decision.action).toBe('refuse');
    expect(decision.action === 'refuse' && decision.reason).toMatch(
      /not what the correction was written for/,
    );
  });
});

describe('a second run', () => {
  it('is refused once the correction is complete, with or without --resume', () => {
    const s = corrected();
    expect(Object.values(stepsDone(s)).every(Boolean)).toBe(true);
    for (const argv of [[], ['--resume'], ['--plan']]) {
      expect(refusal(decideRun(s, argv))).toMatch(/already applied/);
    }
  });

  it('is refused after a run that stopped part way, unless --resume is passed', () => {
    const s = production();
    s.categoriesPresent = NEW_CATEGORIES.map((c) => c.name);
    s.productsPresent = [EXTRAS[0].name];
    expect(refusal(decideRun(s, []))).toMatch(/--resume/);
    expect(decideRun(s, ['--resume'])).toEqual({
      action: 'resume',
      done: ['categories'],
    });
  });

  it('is refused when what is done is not the first steps in order', () => {
    const s = production();
    // The financing corrected by hand, nothing else: not a state this run produced.
    s.financings[1] = {
      ...s.financings[1],
      amount: '13905.69',
      fxRateToEgp: '13.9066',
    };
    expect(refusal(decideRun(s, ['--resume']))).toMatch(/out of order/);
  });

  it('does not count the leg as corrected while it still charges per piece', () => {
    const s = corrected();
    Object.assign(s.legs[1], { costBasis: 'PER_PIECE' });
    expect(stepsDone(s).leg2Cost).toBe(false);
    expect(refusal(decideRun(s, ['--resume']))).toMatch(/out of order/);
  });
});
