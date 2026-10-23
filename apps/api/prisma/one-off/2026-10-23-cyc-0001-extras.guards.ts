/**
 * The facts, the target check and the "has this run already?" check for the
 * one-off correction of CYC-2026-0001 (owner, 2026-10-22/23). Pure: no Nest,
 * no database. The script reads the database into a `CorrectionState` and
 * asks these functions what to do with it, so the guards are unit-tested
 * (src/one-off/cyc-0001-extras-guards.spec.ts) without a database.
 *
 * See `2026-10-23-cyc-0001-extras.ts` for what the correction does.
 */

/** The only database the script writes to without `--production`. */
export const COPY_DB = 'motorcycle_parts_prodcopy';

export const CYCLE_CODE = 'CYC-2026-0001';
export const PO_REFERENCE = 'PO-2026-0001';
export const LENDER_NAME = 'Ahmad Eraiby';

/** The Arabic names are Claude's wording (owner to confirm). */
export const NEW_CATEGORIES = [
  { name: 'Bags', nameAr: 'حقائب' },
  { name: 'Screws', nameAr: 'مسامير' },
  { name: 'Phone holders', nameAr: 'حوامل هواتف' },
] as const;

export interface Extra {
  name: string;
  category: (typeof NEW_CATEGORIES)[number]['name'];
  qty: number;
  /** AED, the order's currency. */
  unitPrice: number;
}

/** The 18 pieces forgotten when the cycle was entered — 353.09 AED, none sold. */
export const EXTRAS: readonly Extra[] = [
  {
    name: 'Hard motorcycle bag (waist bag)',
    category: 'Bags',
    qty: 1,
    unitPrice: 29.27,
  },
  {
    name: 'Tactical Knight motorcycle bag (leg bag)',
    category: 'Bags',
    qty: 1,
    unitPrice: 34.35,
  },
  {
    name: 'Tactical motorcycle leg bag',
    category: 'Bags',
    qty: 1,
    unitPrice: 30.53,
  },
  {
    name: "Men's multifunctional tactical leg bag",
    category: 'Bags',
    qty: 1,
    unitPrice: 34.1,
  },
  {
    name: 'Universal motorcycle screws 177 pcs — White',
    category: 'Screws',
    qty: 1,
    unitPrice: 20.31,
  },
  {
    name: 'Universal motorcycle screws 177 pcs — Green',
    category: 'Screws',
    qty: 1,
    unitPrice: 20.31,
  },
  {
    name: 'Universal motorcycle screws 177 pcs — Red',
    category: 'Screws',
    qty: 1,
    unitPrice: 20.31,
  },
  {
    name: 'Universal motorcycle screws 177 pcs — Blue',
    category: 'Screws',
    qty: 1,
    unitPrice: 20.31,
  },
  {
    name: 'Bicycle phone holder (octopus handlebar style)',
    category: 'Phone holders',
    qty: 10,
    unitPrice: 14.36,
  },
];

/** Leg 2, Dubai → Cairo: one flat amount for all 248 pieces (owner 2026-10-23). */
export const LEG2_COST = {
  costBasis: 'FLAT' as const,
  amount: 5250,
  currency: 'AED',
  fxRateToEgp: 14,
};

/**
 * Ahmad Eraiby's payment, recorded again: 8,302.60 + 353.09 + 5,250 AED. One
 * rate per payment, so the two rates are blended: 8,655.69 at 13.85 and
 * 5,250 at 14 is 193,381.31 EGP; ÷ 13,905.69 = 13.90660… → 13.9066 (four
 * places, the most a rate holds), which stores 193,380.81 EGP.
 */
export const FINANCING = {
  amount: 13905.69,
  currency: 'AED',
  fxRateToEgp: 13.9066,
  paidOn: '2026-07-15',
  note:
    'Alibaba order 304423979001024016, paid by card on 15 Jul 2026 (AED 8,302.60: goods, China→UAE shipping, card fee) ' +
    '+ the 18 pieces left out when the cycle was entered (AED 353.09) + Dubai → Cairo shipping (AED 5,250) = AED 13,905.69. ' +
    'Rate blended: 8,655.69 at 13.85 and 5,250 at 14 (owner, 2026-10-23).',
};
export const OLD_FINANCING = {
  amount: '8302.60',
  fxRateToEgp: '13.8500',
  paidOn: '2026-07-15',
};
export const REMOVAL_REASON =
  "Corrected: the order's 18 forgotten pieces and leg 2, owner 2026-10-23";

/** Equal thirds of 13,905.69 AED. The last is the "pays it off" figure the service quotes. */
export const REPAYMENTS = [
  {
    paidOn: '2026-08-15',
    rateToEgp: 14,
    amountEgp: '64893.22' as string | null,
  },
  {
    paidOn: '2026-09-15',
    rateToEgp: 14.5,
    amountEgp: '67210.84' as string | null,
  },
  {
    paidOn: '2026-10-15',
    rateToEgp: 14.9,
    amountEgp: null as string | null,
    expected: '69064.93',
  },
] as const;

/** 201,168.99 EGP repaid ÷ 3, equal split (owner 2026-10-23). */
export const CONTRIBUTION_EGP = '67056.33';
export const OLD_CONTRIBUTIONS = ['21466.99', '21466.99', '21467.00'];

// ─── The database, as the script reads it ───────────────────────────────

export interface StateLine {
  purchaseOrderItemId: string;
  qty: string;
}

export interface CorrectionState {
  cycle: {
    id: string;
    code: string;
    status: string;
    originType: string;
  } | null;
  orders: {
    id: string;
    reference: string;
    currency: string;
    fxRateToEgp: string;
    orderedOn: string;
    items: {
      id: string;
      productName: string;
      orderedQty: string;
      unitPrice: string;
      lineTotal: string;
    }[];
  }[];
  legs: {
    id: string;
    sequence: number;
    costBasis: string;
    amount: string | null;
    currency: string;
    fxRateToEgp: string | null;
    ratePerUnit: string | null;
    chargeablePieces: string | null;
    departures: { id: string; day: string; lines: StateLine[] }[];
    deliveries: {
      id: string;
      day: string;
      lines: (StateLine & { id: string })[];
    }[];
  }[];
  batches: {
    id: string;
    sourcePoItemId: string | null;
    sourceDeliveryLineId: string | null;
    receivedQty: string;
  }[];
  losses: number;
  standingTransfers: number;
  standingSettlements: number;
  financings: {
    id: string;
    lender: string;
    purchaseOrderId: string;
    amount: string;
    currency: string;
    fxRateToEgp: string;
    paidOn: string;
    removed: boolean;
    repayments: { paidOn: string; amountEgp: string; rateToEgp: string }[];
  }[];
  /** Standing `bank_fees` expenses charged to the cycle, EGP. */
  bankFeesEgp: string;
  contributions: { id: string; type: string; amount: string }[];
  /** Which of NEW_CATEGORIES / EXTRAS already exist, by name. */
  categoriesPresent: string[];
  productsPresent: string[];
}

const num = (v: string | null | undefined) => Number(v ?? 0);
const sumQty = (lines: readonly { qty: string }[]) =>
  lines.reduce((s, l) => s + num(l.qty), 0);
const eq2 = (a: string | number | null, b: string | number) =>
  Math.round(num(String(a)) * 100) === Math.round(Number(b) * 100);
const eq4 = (a: string | number | null, b: string | number) =>
  Math.round(num(String(a)) * 10000) === Math.round(Number(b) * 10000);

// ─── Where to write ─────────────────────────────────────────────────────

export function databaseOf(
  url: string | undefined,
): { host: string; db: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      db: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Refuses unless the database is the local production copy — or `--production`
 * was passed, and then only for a database that is not on this machine (so the
 * flag cannot be pointed at the developer's `motorcycle_parts` by mistake).
 * Returns what it will write to; throws with the reason otherwise.
 */
export function assertTarget(
  url: string | undefined,
  argv: readonly string[],
): { host: string; db: string; production: boolean } {
  const target = databaseOf(url);
  if (!target) throw new Error('DATABASE_URL is not set or not a URL.');
  const production = argv.includes('--production');
  const local = LOCAL_HOSTS.includes(target.host);
  if (production) {
    if (local) {
      throw new Error(
        `--production was passed but DATABASE_URL names ${target.db} on ${target.host}, a database on this machine.`,
      );
    }
    return { ...target, production };
  }
  if (target.db !== COPY_DB || !local) {
    throw new Error(
      `Refusing to write to ${target.db} on ${target.host}: without --production this runs only on the local copy, ${COPY_DB}.`,
    );
  }
  return { ...target, production };
}

// ─── The starting facts ─────────────────────────────────────────────────

/**
 * Every fact the owner gave about the cycle before the correction, checked.
 * An empty list means it is the state the correction was written for.
 */
export function startingFactMismatches(s: CorrectionState): string[] {
  const bad: string[] = [];
  const c = s.cycle;
  if (!c) return [`cycle ${CYCLE_CODE} not found`];
  if (c.status !== 'SELLING')
    bad.push(`cycle status is ${c.status}, not SELLING`);
  if (c.originType !== 'CHINA')
    bad.push(`cycle origin is ${c.originType}, not CHINA`);

  if (s.orders.length !== 1)
    bad.push(`cycle has ${s.orders.length} purchase orders, not 1`);
  const po = s.orders.find((o) => o.reference === PO_REFERENCE);
  if (!po) {
    bad.push(`${PO_REFERENCE} not on the cycle`);
  } else {
    if (po.currency !== 'AED')
      bad.push(`${PO_REFERENCE} is in ${po.currency}, not AED`);
    if (!eq4(po.fxRateToEgp, 13.85))
      bad.push(`${PO_REFERENCE} rate is ${po.fxRateToEgp}, not 13.85`);
    if (po.items.length !== 5)
      bad.push(`${PO_REFERENCE} has ${po.items.length} lines, not 5`);
    const pieces = sumQty(po.items.map((i) => ({ qty: i.orderedQty })));
    if (pieces !== 230)
      bad.push(`${PO_REFERENCE} has ${pieces} pieces, not 230`);
    // The line totals, to the cent, sum to 6,509.86; unrounded (qty × price)
    // they are 6,509.866, which the owner's figure 6,509.87 rounds.
    const lines = po.items.reduce(
      (t, i) => t + Math.round(num(i.lineTotal) * 100),
      0,
    );
    const exact = po.items.reduce(
      (t, i) => t + num(i.orderedQty) * num(i.unitPrice),
      0,
    );
    if (lines !== 650986)
      bad.push(`${PO_REFERENCE} lines total ${lines / 100} AED, not 6,509.86`);
    if (!eq2(exact, 6509.87))
      bad.push(
        `${PO_REFERENCE} goods (qty × price) are ${exact}, not 6,509.87`,
      );
  }

  const leg1 = s.legs.find((l) => l.sequence === 1);
  const leg2 = s.legs.find((l) => l.sequence === 2);
  if (s.legs.length !== 2 || !leg1 || !leg2) {
    bad.push(
      `cycle has legs ${s.legs.map((l) => l.sequence).join(',')}, not 1 and 2`,
    );
  } else {
    if (
      leg1.costBasis !== 'FLAT' ||
      !eq2(leg1.amount, 1551.74) ||
      leg1.currency !== 'AED' ||
      !eq4(leg1.fxRateToEgp, 13.85)
    ) {
      bad.push(
        `leg 1 is ${leg1.costBasis} ${leg1.amount} ${leg1.currency} at ${leg1.fxRateToEgp}, not FLAT 1,551.74 AED at 13.85`,
      );
    }
    if (
      leg2.costBasis !== 'PER_PIECE' ||
      !eq4(leg2.ratePerUnit, 20) ||
      num(leg2.chargeablePieces) !== 230 ||
      leg2.currency !== 'AED' ||
      !eq4(leg2.fxRateToEgp, 14) ||
      !eq2(leg2.amount, 4600)
    ) {
      bad.push(
        `leg 2 is ${leg2.costBasis} ${leg2.ratePerUnit} × ${leg2.chargeablePieces} = ${leg2.amount} ${leg2.currency} at ${leg2.fxRateToEgp}, not PER_PIECE 20 × 230 = 4,600 AED at 14`,
      );
    }
    for (const [leg, day] of [
      [leg1, '2026-08-10'],
      [leg2, '2026-09-09'],
    ] as const) {
      if (leg.departures.length !== 1)
        bad.push(
          `leg ${leg.sequence} has ${leg.departures.length} departures, not 1`,
        );
      else if (sumQty(leg.departures[0].lines) !== 230)
        bad.push(
          `leg ${leg.sequence}'s departure carried ${sumQty(leg.departures[0].lines)}, not 230`,
        );
      if (leg.deliveries.length !== 1)
        bad.push(
          `leg ${leg.sequence} has ${leg.deliveries.length} deliveries, not 1`,
        );
      else {
        const d = leg.deliveries[0];
        if (d.day !== day)
          bad.push(`leg ${leg.sequence}'s delivery is on ${d.day}, not ${day}`);
        if (sumQty(d.lines) !== 230)
          bad.push(
            `leg ${leg.sequence}'s delivery brought ${sumQty(d.lines)}, not 230`,
          );
      }
    }
    const fromLeg2 = new Set(
      leg2.deliveries.flatMap((d) => d.lines.map((l) => l.id)),
    );
    const received = s.batches.filter(
      (b) => b.sourceDeliveryLineId && fromLeg2.has(b.sourceDeliveryLineId),
    );
    if (s.batches.length !== 5 || received.length !== 5) {
      bad.push(
        `${s.batches.length} batches on the cycle, ${received.length} from leg 2's delivery — not 5 and 5`,
      );
    }
  }
  if (s.losses > 0) bad.push(`${s.losses} losses recorded on the cycle`);
  if (s.standingTransfers > 0)
    bad.push(`${s.standingTransfers} stock transfers stand on the cycle`);
  if (s.standingSettlements > 0)
    bad.push(`${s.standingSettlements} settlements stand on the cycle`);

  const standing = s.financings.filter((f) => !f.removed);
  const ahmad = standing.filter((f) => f.lender === LENDER_NAME);
  if (standing.length !== 1 || ahmad.length !== 1) {
    bad.push(
      `${standing.length} friends' payments stand on the cycle (${ahmad.length} of ${LENDER_NAME}), not exactly his one`,
    );
  } else {
    const f = ahmad[0];
    if (po && f.purchaseOrderId !== po.id)
      bad.push(`${LENDER_NAME}'s payment is not on ${PO_REFERENCE}`);
    if (
      f.currency !== 'AED' ||
      !eq2(f.amount, OLD_FINANCING.amount) ||
      !eq4(f.fxRateToEgp, OLD_FINANCING.fxRateToEgp) ||
      f.paidOn !== OLD_FINANCING.paidOn
    ) {
      bad.push(
        `${LENDER_NAME}'s payment is ${f.amount} ${f.currency} at ${f.fxRateToEgp} on ${f.paidOn}, not 8,302.60 AED at 13.85 on 2026-07-15`,
      );
    }
    if (f.repayments.length > 0)
      bad.push(
        `${LENDER_NAME} already has ${f.repayments.length} standing repayments`,
      );
  }
  if (!eq2(s.bankFeesEgp, 3338.82))
    bad.push(`bank_fees on the cycle total ${s.bankFeesEgp} EGP, not 3,338.82`);

  const core = s.contributions.filter((p) => p.type === 'CORE_PARTNER');
  const amounts = core.map((p) => Number(p.amount).toFixed(2)).sort();
  if (
    s.contributions.length !== 3 ||
    amounts.join('/') !== [...OLD_CONTRIBUTIONS].sort().join('/')
  ) {
    bad.push(
      `contributions are ${s.contributions.map((p) => `${p.type} ${p.amount}`).join(', ')}, not 21,466.99 / 21,466.99 / 21,467 for three core partners`,
    );
  }
  if (s.categoriesPresent.length > 0)
    bad.push(`categories already exist: ${s.categoriesPresent.join(', ')}`);
  if (s.productsPresent.length > 0)
    bad.push(`products already exist: ${s.productsPresent.join(', ')}`);
  return bad;
}

// ─── How far a run got ──────────────────────────────────────────────────

export const STEPS = [
  'categories',
  'products',
  'orderLines',
  'received',
  'leg2Cost',
  'financing',
  'repayments',
  'contributions',
] as const;
export type Step = (typeof STEPS)[number];

/** Which steps the database shows done. */
export function stepsDone(s: CorrectionState): Record<Step, boolean> {
  const po = s.orders.find((o) => o.reference === PO_REFERENCE);
  const newLines = (po?.items ?? []).filter((i) =>
    EXTRAS.some((e) => e.name === i.productName),
  );
  const newLineIds = new Set(newLines.map((l) => l.id));
  const leg2 = s.legs.find((l) => l.sequence === 2);
  const ahmad = s.financings.filter(
    (f) => !f.removed && f.lender === LENDER_NAME,
  );
  const corrected = ahmad.find(
    (f) =>
      eq2(f.amount, FINANCING.amount) &&
      eq4(f.fxRateToEgp, FINANCING.fxRateToEgp),
  );
  return {
    categories: NEW_CATEGORIES.every((c) =>
      s.categoriesPresent.includes(c.name),
    ),
    products: EXTRAS.every((e) => s.productsPresent.includes(e.name)),
    orderLines: newLines.length === EXTRAS.length,
    received:
      newLines.length > 0 &&
      newLines.every((l) => s.batches.some((b) => b.sourcePoItemId === l.id)) &&
      s.batches.filter(
        (b) => b.sourcePoItemId && newLineIds.has(b.sourcePoItemId),
      ).length === EXTRAS.length,
    leg2Cost:
      !!leg2 &&
      leg2.costBasis === LEG2_COST.costBasis &&
      eq2(leg2.amount, LEG2_COST.amount) &&
      leg2.currency === LEG2_COST.currency &&
      eq4(leg2.fxRateToEgp, LEG2_COST.fxRateToEgp),
    financing: !!corrected,
    repayments:
      !!corrected &&
      REPAYMENTS.every((r) =>
        corrected.repayments.some((x) => x.paidOn === r.paidOn),
      ),
    contributions:
      s.contributions.length > 0 &&
      s.contributions.every((p) => eq2(p.amount, CONTRIBUTION_EGP)),
  };
}

export type RunDecision =
  | { action: 'fresh' }
  | { action: 'resume'; done: Step[] }
  | { action: 'refuse'; reason: string };

/**
 * What this run may do. A database with nothing of the correction is checked
 * against every starting fact; one where it is complete is refused (a second
 * run); one where it stopped part way resumes only with `--resume`, and only
 * when the steps done are the first ones in order.
 */
export function decideRun(
  s: CorrectionState,
  argv: readonly string[],
): RunDecision {
  const done = stepsDone(s);
  const doneSteps = STEPS.filter((k) => done[k]);
  if (doneSteps.length === STEPS.length) {
    return {
      action: 'refuse',
      reason: `The correction is already applied to ${CYCLE_CODE}: every step is done. Nothing to do.`,
    };
  }
  const touched =
    doneSteps.length > 0 ||
    s.categoriesPresent.length > 0 ||
    s.productsPresent.length > 0;
  if (!touched) {
    const bad = startingFactMismatches(s);
    return bad.length === 0
      ? { action: 'fresh' }
      : {
          action: 'refuse',
          reason: `The data is not what the correction was written for:\n  - ${bad.join('\n  - ')}`,
        };
  }
  const prefix = STEPS.slice(0, doneSteps.length);
  if (doneSteps.some((k, i) => k !== prefix[i])) {
    return {
      action: 'refuse',
      reason: `Steps done out of order (${doneSteps.join(', ')}); look at the data before going on.`,
    };
  }
  if (!argv.includes('--resume')) {
    return {
      action: 'refuse',
      reason: `A run already started on ${CYCLE_CODE} (done: ${doneSteps.join(', ') || 'part of the first step'}). Pass --resume to continue it, or look at the data first.`,
    };
  }
  return { action: 'resume', done: doneSteps };
}
