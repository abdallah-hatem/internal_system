import { Prisma } from '@prisma/client';
import { businessToday } from '../../../common/dates';
import {
  SIMILARITY_THRESHOLD,
  invoiceKey,
  nameKey,
  nameTokens,
  similarity,
  skuKey,
  supplierKey,
  tokensWithin,
} from './name-matching';
import type {
  LineAnalysis,
  Numeric,
  ProductCandidate,
  QuestionKind,
  QuestionOption,
  ReceiptAnalysis,
  ReceiptExtraction,
  ReceiptFindings,
  ReceiptLineExtraction,
  ReceiptQuestion,
  ReceiptSnapshot,
  SnapshotProduct,
  SupplierAnalysis,
  SupplierCandidate,
} from './receipt.types';

/**
 * Read a receipt against what the business already knows.
 *
 * Claude does the reading; this does the knowing. It decides — deterministically,
 * from plain data — what is settled and what must be asked, and returns each
 * unsettled point as a question with a stable id. It writes nothing and refuses
 * nothing: a receipt that cannot become a purchase order yet comes back with
 * blocking questions, so the model can ask them rather than hit a wall.
 *
 * A receipt with no lines is the one exception to "match what you can": there
 * is nothing to match, so the analysis is a single blocking RECEIPT_NO_LINES
 * question and nothing else. It is a question rather than a throw because the
 * usual cause is a misread page, and the model's job is then to look again.
 *
 * Money is Prisma.Decimal throughout. A line total is quantity × unit price less
 * its percentage discount, rounded half-up to 2 dp per line, as an invoice
 * prints it; the subtotal is the sum of those rounded lines.
 */
export function analyzeReceipt(
  extraction: ReceiptExtraction,
  snapshot: ReceiptSnapshot,
  today: Date,
): ReceiptAnalysis {
  const questions: ReceiptQuestion[] = [];
  const ask = (q: Omit<ReceiptQuestion, 'id'> & { line?: number }) => {
    const { line, ...rest } = q;
    questions.push({ id: line ? `${q.kind}:${line}` : q.kind, ...rest });
  };

  const currency = (extraction.currency ?? '').trim().toUpperCase();
  const invoiceNumber = invoiceKey(extraction.invoiceNumber) || null;

  if (!extraction.lines?.length) {
    ask({
      kind: 'RECEIPT_NO_LINES',
      blocking: true,
      text: 'No item lines were read from this receipt. A purchase order needs at least one — read the receipt again, or ask for a clearer copy.',
    });
    return {
      supplier: { status: 'unknown' },
      lines: [],
      computedSubtotal: null,
      findings: emptyFindings(invoiceNumber, currency),
      questions,
      blocked: true,
    };
  }

  // ── Date ────────────────────────────────────────────────────────────────
  if (extraction.date) {
    const date = extraction.date.trim();
    if (!isCalendarDate(date)) {
      ask({
        kind: 'DATE_UNREADABLE',
        blocking: true,
        text: `The receipt date "${date}" is not a real calendar date. What date is printed on it?`,
        context: { date },
      });
    } else {
      const todayDay = businessToday(today);
      if (date > todayDay) {
        ask({
          kind: 'FUTURE_DATE',
          blocking: true,
          text: `The receipt is dated ${date}, which has not happened yet (today is ${todayDay}). A purchase cannot be recorded in the future — what is the correct date?`,
          context: { date, today: todayDay },
        });
      }
    }
  }

  // ── Supplier and duplicate invoice ──────────────────────────────────────
  const supplier = matchSupplier(extraction.supplierName, snapshot);
  const recordedFor = (supplierId: string) =>
    invoiceNumber
      ? snapshot.recordedInvoices.find(
          (r) =>
            r.supplierId === supplierId &&
            invoiceKey(r.invoiceRef) === invoiceNumber,
        )
      : undefined;

  const newSupplierOption: QuestionOption = {
    value: 'new',
    label: 'None of these — a new supplier',
  };
  if (supplier.status === 'unknown') {
    ask({
      kind: 'SUPPLIER_NEW',
      blocking: true,
      text: `"${extraction.supplierName}" is not a supplier on file. Should it be added as a new supplier, and which country is it in?`,
      context: { name: extraction.supplierName, needs: ['country'] },
    });
  } else if (supplier.status === 'candidates') {
    const alreadyRecorded = supplier.candidates!.flatMap((c) => {
      const r = recordedFor(c.id);
      return r
        ? [
            {
              supplierId: c.id,
              purchaseOrderReference: r.purchaseOrderReference,
            },
          ]
        : [];
    });
    ask({
      kind: 'SUPPLIER_WHICH',
      blocking: true,
      text: `"${extraction.supplierName}" is close to more than one name on file, or to one that is not quite the same. Which supplier is it?`,
      options: [
        ...supplier.candidates!.map((c) => ({
          value: c.id,
          label: `${c.name} (${c.country})`,
        })),
        newSupplierOption,
      ],
      context: {
        name: extraction.supplierName,
        ...(alreadyRecorded.length ? { alreadyRecorded } : {}),
      },
    });
  }

  let duplicateOf: ReceiptFindings['duplicateOf'];
  if (supplier.status === 'matched') {
    const recorded = recordedFor(supplier.match!.id);
    if (recorded) {
      duplicateOf = {
        purchaseOrderReference: recorded.purchaseOrderReference,
        cycleCode: recorded.cycleCode,
      };
      ask({
        kind: 'DUPLICATE_INVOICE',
        blocking: true,
        text: `Invoice ${invoiceNumber} from ${supplier.match!.name} is already recorded as purchase order ${recorded.purchaseOrderReference} on cycle ${recorded.cycleCode}. The same invoice cannot be recorded twice. Is the invoice number misread, or is this receipt already in?`,
        options: [
          {
            value: 'correct_number',
            label: 'The number was misread — correct it',
          },
          {
            value: 'already_recorded',
            label: 'It is already recorded — stop here',
          },
        ],
        context: { invoiceNumber, ...duplicateOf },
      });
    }
  }

  // ── Currency ────────────────────────────────────────────────────────────
  const fx = resolveFx(currency, snapshot.fxRates);
  if (!/^[A-Z]{3}$/.test(currency)) {
    ask({
      kind: 'CURRENCY_UNREADABLE',
      blocking: true,
      text: `The currency "${extraction.currency ?? ''}" is not a currency code. Which currency is the receipt in?`,
      context: { currency: extraction.currency ?? '' },
    });
  } else if (fx.source === 'none') {
    ask({
      kind: 'FX_RATE_NEEDED',
      blocking: true,
      text: `There is no exchange rate on file for ${currency}. What rate to EGP was actually paid?`,
      context: { currency },
    });
  } else if (fx.source === 'stored') {
    ask({
      kind: 'FX_RATE_CONFIRM',
      blocking: false,
      text: `The rate on file for ${currency} is ${fx.rate} EGP. Use it, or the rate actually paid?`,
      options: [
        { value: 'stored', label: `Use ${fx.rate}` },
        { value: 'other', label: 'A different rate was paid' },
      ],
      context: { currency, rate: fx.rate },
    });
  }

  // ── Cycle and draft orders ──────────────────────────────────────────────
  const open = snapshot.openCycles;
  const suggested = open.length === 1 ? open[0] : null;
  if (open.length === 0) {
    ask({
      kind: 'CYCLE_NEW',
      blocking: true,
      text: 'No cycle is open for purchasing. Start a new cycle for this order — shipped from China, or bought in the UAE?',
      options: [
        { value: 'CHINA', label: 'China — China to UAE, then UAE to Egypt' },
        { value: 'UAE_DIRECT', label: 'UAE direct — UAE to Egypt' },
      ],
    });
  } else if (suggested) {
    ask({
      kind: 'CYCLE_CONFIRM',
      blocking: false,
      text: `Cycle ${suggested.code} is the one open for purchasing. Add this order to it?`,
      options: [
        { value: suggested.id, label: suggested.code },
        { value: 'new', label: 'Start a new cycle instead' },
      ],
      context: { cycleId: suggested.id, cycleCode: suggested.code },
    });
  } else {
    ask({
      kind: 'CYCLE_WHICH',
      blocking: true,
      text: 'Several cycles are open for purchasing. Which one does this order belong to?',
      options: open.map((c) => ({
        value: c.id,
        label: `${c.code} (${c.originType})`,
      })),
    });
  }

  const openIds = new Map(open.map((c) => [c.id, c.code]));
  const drafts =
    supplier.status === 'matched'
      ? snapshot.draftOrders
          .filter(
            (d) =>
              d.supplierId === supplier.match!.id && openIds.has(d.cycleId),
          )
          .map((d) => ({
            id: d.id,
            reference: d.reference,
            cycleId: d.cycleId,
            cycleCode: openIds.get(d.cycleId)!,
          }))
      : [];
  if (drafts.length) {
    ask({
      kind: 'ADD_OR_SEPARATE',
      blocking: true,
      text: `There is already a draft order from ${supplier.match!.name} on an open cycle (${drafts.map((d) => `${d.reference} on ${d.cycleCode}`).join(', ')}). Add these lines to it, or record a separate order?`,
      options: [
        ...drafts.map((d) => ({
          value: d.id,
          label: `Add to ${d.reference} (${d.cycleCode})`,
        })),
        { value: 'separate', label: 'A separate order' },
      ],
    });
  }

  // ── Lines ───────────────────────────────────────────────────────────────
  const lines = extraction.lines.map((input, i) =>
    analyzeLine(input, i + 1, snapshot.products, ask),
  );
  const allPriced = lines.every((l) => l.lineTotal !== null);
  const computedSubtotal = allPriced
    ? lines.reduce((sum, l) => sum.plus(l.lineTotal!), new Prisma.Decimal(0))
    : null;

  // ── Charges ─────────────────────────────────────────────────────────────
  const charges = (extraction.charges ?? []).map((c) => ({
    kind: c.kind,
    label: c.label,
    amount: toDecimal(c.amount),
  }));
  const chargesTotal = charges.reduce(
    (sum, c) => (c.amount ? sum.plus(c.amount) : sum),
    new Prisma.Decimal(0),
  );
  if (charges.length) {
    ask({
      kind: 'CHARGES_WHERE',
      blocking: false,
      text: `The receipt also charges ${charges.map((c) => `${c.label} ${c.amount ? money(c.amount) : '(unreadable)'}`).join(', ')}. These are not goods, so they are not purchase order lines. Leave them off, or record them on a shipping leg?`,
      options: [
        { value: 'leave_off', label: 'Leave them off' },
        { value: 'shipping_leg', label: 'Record them on a shipping leg' },
      ],
      context: { total: money(chargesTotal), currency },
    });
  }

  // ── Totals ──────────────────────────────────────────────────────────────
  // Checked against the stated subtotal when there is one. Without it, against
  // the stated total less the non-goods charges — but only if every charge was
  // readable, or the difference would be the unread charge, not the lines.
  // Skipped while any line cannot be priced: its own question comes first.
  const statedSubtotal = toDecimal(extraction.statedSubtotal);
  const statedTotal = toDecimal(extraction.statedTotal);
  let difference: Prisma.Decimal | null = null;
  let checkedAgainst: 'subtotal' | 'total' | null = null;
  if (computedSubtotal) {
    if (statedSubtotal) {
      checkedAgainst = 'subtotal';
      difference = computedSubtotal.minus(statedSubtotal);
    } else if (statedTotal && charges.every((c) => c.amount)) {
      checkedAgainst = 'total';
      difference = computedSubtotal.plus(chargesTotal).minus(statedTotal);
    }
  }
  if (difference && difference.abs().greaterThan(TOLERANCE)) {
    const stated =
      checkedAgainst === 'subtotal' ? statedSubtotal! : statedTotal!;
    const computed =
      checkedAgainst === 'subtotal'
        ? computedSubtotal!
        : computedSubtotal!.plus(chargesTotal);
    ask({
      kind: 'TOTALS_MISMATCH',
      blocking: true,
      text: `The lines add up to ${money(computed)} ${currency}, but the receipt's ${checkedAgainst} says ${money(stated)}. Is there a discount on the whole receipt, or was a line misread?`,
      options: [
        { value: 'receipt_discount', label: 'A discount on the whole receipt' },
        { value: 'misread_line', label: 'A line was misread — correct it' },
      ],
      context: {
        computed: money(computed),
        stated: money(stated),
        difference: money(difference),
        checkedAgainst,
      },
    });
  }

  return {
    supplier,
    lines,
    computedSubtotal: computedSubtotal ? money(computedSubtotal) : null,
    findings: {
      invoiceNumber,
      ...(duplicateOf ? { duplicateOf } : {}),
      totals: {
        computedSubtotal: computedSubtotal ? money(computedSubtotal) : null,
        statedSubtotal: statedSubtotal ? money(statedSubtotal) : null,
        statedTotal: statedTotal ? money(statedTotal) : null,
        chargesTotal: money(chargesTotal),
        difference: difference ? money(difference) : null,
        checkedAgainst,
      },
      charges: charges.map((c) => ({
        kind: c.kind,
        label: c.label,
        amount: c.amount ? money(c.amount) : null,
      })),
      fx,
      cycles: {
        suggested: suggested
          ? { id: suggested.id, code: suggested.code }
          : null,
        open: open.map((c) => ({
          id: c.id,
          code: c.code,
          originType: c.originType,
        })),
      },
      draftOrders: drafts,
    },
    questions,
    blocked: questions.some((q) => q.blocking),
  };
}

/** Lines may disagree with the stated figure by rounding, and by no more. */
const TOLERANCE = new Prisma.Decimal('0.01');
const MAX_CANDIDATES = 5;

type Ask = (q: Omit<ReceiptQuestion, 'id'> & { line?: number }) => void;

function analyzeLine(
  input: ReceiptLineExtraction,
  line: number,
  products: SnapshotProduct[],
  ask: Ask,
): LineAnalysis {
  const quantity = toDecimal(input.quantity);
  const unitPrice = toDecimal(input.unitPrice);
  const hasDiscount =
    input.discountPercent !== undefined &&
    input.discountPercent !== null &&
    input.discountPercent !== '';
  const discount = hasDiscount
    ? toDecimal(input.discountPercent)
    : new Prisma.Decimal(0);
  const label = `Line ${line} ("${input.description}")`;
  const invalid = (
    kind: QuestionKind,
    text: string,
    context: Record<string, unknown>,
  ) => ask({ kind, line, blocking: true, text, context: { line, ...context } });

  // Fractional quantities are real (a metre of hose, half a carton); zero and
  // negative are not purchases.
  if (!quantity || quantity.lessThanOrEqualTo(0)) {
    invalid(
      'LINE_QTY_INVALID',
      `${label} has quantity "${String(input.quantity)}". A purchase needs a quantity above zero — what does the receipt say?`,
      { quantity: String(input.quantity) },
    );
  }
  // Zero is allowed — a free sample is still stock received.
  if (!unitPrice || unitPrice.isNegative()) {
    invalid(
      'LINE_PRICE_INVALID',
      `${label} has unit price "${String(input.unitPrice)}". A price cannot be negative — what does the receipt say?`,
      { unitPrice: String(input.unitPrice) },
    );
  }
  // More than 100% off would make the line — and the order — worth less than
  // nothing, which is how a sale once totalled −9,899.
  if (!discount || discount.isNegative() || discount.greaterThan(100)) {
    invalid(
      'LINE_DISCOUNT_INVALID',
      `${label} has a discount of "${String(input.discountPercent)}%". A discount must be between 0% and 100% of the line — what does the receipt say?`,
      { discountPercent: String(input.discountPercent) },
    );
  }

  const priceable =
    quantity &&
    quantity.greaterThan(0) &&
    unitPrice &&
    !unitPrice.isNegative() &&
    discount &&
    !discount.isNegative() &&
    !discount.greaterThan(100);
  const lineTotal = priceable
    ? quantity
        .times(unitPrice)
        .times(new Prisma.Decimal(100).minus(discount))
        .dividedBy(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : null;

  const base = {
    line,
    description: input.description,
    lineTotal: lineTotal ? money(lineTotal) : null,
  };
  const matched = matchProduct(input, products);
  const newProductOption: QuestionOption = {
    value: 'new',
    label: 'None of these — a new product',
  };
  const optionsFor = (cs: ProductCandidate[]) => [
    ...cs.map((c) => ({
      value: c.id,
      label: c.sku ? `${c.name} (${c.sku})` : c.name,
    })),
    newProductOption,
  ];

  if (matched.status === 'matched')
    return { ...base, status: 'matched', match: matched.match };
  if (matched.status === 'several') {
    ask({
      kind: 'LINE_WHICH',
      line,
      blocking: true,
      text: `${label} could be any of several products on file. Which one is it?`,
      options: optionsFor(matched.candidates),
      context: { line },
    });
    return { ...base, status: 'candidates', candidates: matched.candidates };
  }
  ask({
    kind: 'LINE_NEW_OR_EXISTING',
    line,
    blocking: true,
    text: matched.candidates.length
      ? `${label} is not an exact match for any product on file, but is close to ${matched.candidates[0].name}. Is it that product, or a new one?`
      : `${label} matches no product on file. Is it a new product, or an existing one under another name?`,
    options: optionsFor(matched.candidates),
    context: { line },
  });
  return matched.candidates.length
    ? { ...base, status: 'candidates', candidates: matched.candidates }
    : { ...base, status: 'unknown' };
}

type ProductMatch =
  | { status: 'matched'; match: ProductCandidate }
  | { status: 'several'; candidates: ProductCandidate[] }
  | { status: 'weak'; candidates: ProductCandidate[] };

/**
 * A line is settled by, in order:
 *   1. its SKU equal to exactly one product's (case, spaces, dashes ignored);
 *   2. its description equal to exactly one product's name;
 *   3. exactly one product whose name of two or more words appears whole in
 *      the description ("Brake pad front" in "Brake pad front, ceramic").
 * Several at any of those steps is "which one?". Otherwise products that are
 * similar, or whose name is a broader phrase containing the description, are
 * offered — never assumed.
 */
function matchProduct(
  input: ReceiptLineExtraction,
  products: SnapshotProduct[],
): ProductMatch {
  const candidate = (
    p: SnapshotProduct,
    via: ProductCandidate['via'],
    score: number,
  ): ProductCandidate => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    via,
    score: round2(score),
  });
  const decide = (found: ProductCandidate[]): ProductMatch | null =>
    found.length === 1
      ? { status: 'matched', match: found[0] }
      : found.length > 1
        ? { status: 'several', candidates: found.slice(0, MAX_CANDIDATES) }
        : null;

  const sku = skuKey(input.sku);
  if (sku) {
    const bySku = decide(
      products
        .filter((p) => skuKey(p.sku) === sku)
        .map((p) => candidate(p, 'sku', 1)),
    );
    if (bySku) return bySku;
  }

  const key = nameKey(input.description);
  const tokens = nameTokens(input.description);
  if (!key) return { status: 'weak', candidates: [] };

  const exact = decide(
    products
      .filter((p) => nameKey(p.name) === key)
      .map((p) => candidate(p, 'name', 1)),
  );
  if (exact) return exact;

  const contained = products.filter((p) => {
    const pt = nameTokens(p.name);
    return pt.length >= 2 && tokensWithin(pt, tokens);
  });
  const byContainment = decide(
    contained.map((p) =>
      candidate(p, 'name-contains', similarity(nameKey(p.name), key)),
    ),
  );
  if (byContainment) return byContainment;

  const weak = products
    .map((p) => {
      const pk = nameKey(p.name);
      const pt = nameTokens(p.name);
      const score = similarity(pk, key);
      const related =
        score >= SIMILARITY_THRESHOLD ||
        tokensWithin(tokens, pt) ||
        tokensWithin(pt, tokens);
      return related ? candidate(p, 'name-similar', score) : null;
    })
    .filter((c): c is ProductCandidate => c !== null)
    .sort(byScore)
    .slice(0, MAX_CANDIDATES);
  return weak.length > 1
    ? { status: 'several', candidates: weak }
    : { status: 'weak', candidates: weak };
}

/**
 * The supplier is settled only by one name equal to the receipt's, once case,
 * spacing, punctuation and legal-form words ("Co., Ltd.") are ignored. Two such
 * names, or any merely similar ones, are candidates to choose between.
 */
function matchSupplier(
  name: string,
  snapshot: ReceiptSnapshot,
): SupplierAnalysis {
  const key = supplierKey(name);
  if (!key) return { status: 'unknown' };
  const scored = snapshot.suppliers
    .map((s) => {
      const sk = supplierKey(s.name);
      return { supplier: s, exact: sk === key, score: similarity(sk, key) };
    })
    .filter((s) => s.exact || s.score >= SIMILARITY_THRESHOLD);
  const toCandidate = (s: (typeof scored)[number]): SupplierCandidate => ({
    id: s.supplier.id,
    name: s.supplier.name,
    country: s.supplier.country,
    score: s.exact ? 1 : Math.min(round2(s.score), 0.99),
  });
  const exact = scored.filter((s) => s.exact);
  if (exact.length === 1)
    return { status: 'matched', match: toCandidate(exact[0]) };
  if (scored.length)
    return {
      status: 'candidates',
      candidates: scored
        .map(toCandidate)
        .sort(byScore)
        .slice(0, MAX_CANDIDATES),
    };
  return { status: 'unknown' };
}

function resolveFx(
  currency: string,
  rates: ReceiptSnapshot['fxRates'],
): ReceiptFindings['fx'] {
  if (currency === 'EGP') return { currency, rate: '1', source: 'base' };
  const entry = Object.entries(rates ?? {}).find(
    ([code]) => code.trim().toUpperCase() === currency,
  );
  const rate = entry ? toDecimal(entry[1]) : null;
  // A rate of zero or less is not a rate; treat it as none on file.
  if (!rate || !rate.greaterThan(0))
    return { currency, rate: null, source: 'none' };
  return { currency, rate: rate.toString(), source: 'stored' };
}

function emptyFindings(
  invoiceNumber: string | null,
  currency: string,
): ReceiptFindings {
  return {
    invoiceNumber,
    totals: {
      computedSubtotal: null,
      statedSubtotal: null,
      statedTotal: null,
      chargesTotal: '0.00',
      difference: null,
      checkedAgainst: null,
    },
    charges: [],
    fx: { currency, rate: null, source: 'none' },
    cycles: { suggested: null, open: [] },
    draftOrders: [],
  };
}

/** A decimal from what the model sent, or null when it is not a finite number. */
function toDecimal(value: Numeric | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (!text) return null;
  try {
    const d = new Prisma.Decimal(text);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(2, Prisma.Decimal.ROUND_HALF_UP);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function byScore<T extends { score: number; name: string }>(
  a: T,
  b: T,
): number {
  return b.score - a.score || a.name.localeCompare(b.name);
}

/** yyyy-mm-dd naming a day that exists — 2026-02-30 does not. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}
