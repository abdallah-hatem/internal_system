import type { PrismaService } from '../../prisma/prisma.service';

/**
 * What an audit row is about, in the words the business uses for it.
 *
 * `entityId` is a database UUID. On the audit log it read `3f2a91c0...`, which
 * tells the owner nothing (2026-10-18). Each row is given the record's own
 * name or number instead — an order's ORD-2026-00003, a cycle's code, a shop's
 * name — and, where the office app has a page for it, the address of that page.
 *
 * One query per record type on the page, never one per row: a page of fifty
 * sale orders is one `saleOrder.findMany`.
 *
 * A record that no longer exists, or a type this file does not know, gets no
 * label at all. The screen then shows the type's own name ("Category") and no
 * link. It never falls back to the id.
 */
export interface AuditEntityLabel {
  /** The name or number, as stored: "ORD-2026-00003", "Nile Motors". */
  label: string | null;
  /** The Arabic name, for records that keep one (products, categories). */
  labelAr?: string | null;
  /** The office app's page for the record, without the locale prefix. */
  href?: string | null;
  /** The sum the record is about, for money that has no number of its own. */
  amount?: { value: string; currency: string } | null;
}

export interface AuditLabelled {
  entityLabel: string | null;
  entityLabelAr: string | null;
  entityHref: string | null;
  entityAmount: { value: string; currency: string } | null;
}

/** The part of Prisma this file reads. */
type Db = Pick<
  PrismaService,
  | 'saleOrder'
  | 'saleReturn'
  | 'payment'
  | 'paymentPlan'
  | 'purchaseOrder'
  | 'purchaseOrderItem'
  | 'product'
  | 'customer'
  | 'importCycle'
  | 'cycleParticipant'
  | 'inventoryBatch'
  | 'settlement'
  | 'financialTransaction'
  | 'supplier'
  | 'supplierRefund'
  | 'provider'
  | 'category'
  | 'lender'
  | 'lenderFinancing'
  | 'lenderRepayment'
  | 'lenderPlan'
  | 'shippingLeg'
  | 'shipmentDeparture'
  | 'shipmentDelivery'
  | 'shipmentLoss'
  | 'stockTransfer'
  | 'user'
>;

interface Row {
  entityType: string;
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}

type Labels = Map<string, AuditEntityLabel>;
type Resolver = (db: Db, ids: string[], rows: Row[]) => Promise<Labels>;

/** Prisma's Decimal, or a plain figure: anything that prints as a number. */
type Figure = { toString(): string } | number | string | null | undefined;

const money = (value: Figure, currency: string) =>
  value == null ? null : { value: value.toString(), currency };

const cycleHref = (cycleId: string | null | undefined) =>
  cycleId ? `/cycles/${cycleId}/details` : null;

const legLabel = (leg: {
  origin: string;
  destination: string;
  cycle: { code: string } | null;
}) =>
  [leg.cycle?.code, `${leg.origin} → ${leg.destination}`]
    .filter(Boolean)
    .join(' · ');

const legSelect = {
  cycleId: true,
  origin: true,
  destination: true,
  cycle: { select: { code: true } },
} as const;

function keyed<T extends { id: string }>(
  rows: T[],
  f: (r: T) => AuditEntityLabel,
): Labels {
  return new Map(rows.map((r) => [r.id, f(r)]));
}

const asIn = (ids: string[]) => ({ where: { id: { in: ids } } });

/**
 * One entry per `entityType` the services write (`grep -rn "entityType: '"
 * apps/api/src`). Suppliers, providers and categories live in lists with no
 * page of their own, so they are named and not linked.
 */
const RESOLVERS: Record<string, Resolver> = {
  SaleOrder: async (db, ids) =>
    keyed(
      await db.saleOrder.findMany({
        ...asIn(ids),
        select: { id: true, orderNo: true },
      }),
      // /sales has no page per order; its invoice is the page that shows one.
      (o) => ({ label: o.orderNo, href: `/sales/${o.id}/invoice` }),
    ),
  SaleReturn: async (db, ids) =>
    keyed(
      await db.saleReturn.findMany({
        ...asIn(ids),
        select: {
          id: true,
          reference: true,
          refundEgp: true,
          saleOrder: { select: { customerId: true } },
        },
      }),
      (r) => ({
        label: r.reference,
        href: `/customers/${r.saleOrder.customerId}`,
        amount: money(r.refundEgp, 'EGP'),
      }),
    ),
  Payment: async (db, ids) =>
    keyed(
      await db.payment.findMany({
        ...asIn(ids),
        select: {
          id: true,
          reference: true,
          amount: true,
          currency: true,
          customerId: true,
          customer: { select: { displayName: true } },
        },
      }),
      (p) => ({
        // A payment's reference is optional; the shop it came from is not.
        label: p.reference || p.customer.displayName,
        href: `/customers/${p.customerId}`,
        amount: money(p.amount, p.currency),
      }),
    ),
  PaymentPlan: async (db, ids) =>
    keyed(
      await db.paymentPlan.findMany({
        ...asIn(ids),
        select: { id: true, reference: true, totalEgp: true, customerId: true },
      }),
      (p) => ({
        label: p.reference,
        href: `/customers/${p.customerId}`,
        amount: money(p.totalEgp, 'EGP'),
      }),
    ),
  PurchaseOrder: async (db, ids) =>
    keyed(
      await db.purchaseOrder.findMany({
        ...asIn(ids),
        select: { id: true, reference: true, cycleId: true },
      }),
      (p) => ({ label: p.reference, href: cycleHref(p.cycleId) }),
    ),
  PurchaseOrderItem: async (db, ids) =>
    keyed(
      await db.purchaseOrderItem.findMany({
        ...asIn(ids),
        select: {
          id: true,
          purchaseOrder: { select: { reference: true, cycleId: true } },
          product: { select: { name: true, nameAr: true } },
        },
      }),
      (i) => ({
        label: `${i.purchaseOrder.reference} · ${i.product.name}`,
        labelAr: i.product.nameAr
          ? `${i.purchaseOrder.reference} · ${i.product.nameAr}`
          : null,
        href: cycleHref(i.purchaseOrder.cycleId),
      }),
    ),
  Product: async (db, ids) =>
    keyed(
      await db.product.findMany({
        ...asIn(ids),
        select: { id: true, sku: true, name: true, nameAr: true },
      }),
      (p) => ({
        label: `${p.name} (${p.sku})`,
        labelAr: p.nameAr ? `${p.nameAr} (${p.sku})` : null,
        href: `/products/${p.id}`,
      }),
    ),
  Customer: async (db, ids) =>
    keyed(
      await db.customer.findMany({
        ...asIn(ids),
        select: { id: true, displayName: true },
      }),
      (c) => ({ label: c.displayName, href: `/customers/${c.id}` }),
    ),
  ImportCycle: async (db, ids) =>
    keyed(
      await db.importCycle.findMany({
        ...asIn(ids),
        select: { id: true, code: true },
      }),
      (c) => ({ label: c.code, href: cycleHref(c.id) }),
    ),
  CycleParticipant: async (db, ids) =>
    keyed(
      await db.cycleParticipant.findMany({
        ...asIn(ids),
        select: {
          id: true,
          cycleId: true,
          cycle: { select: { code: true } },
          partner: {
            select: { email: true, partner: { select: { displayName: true } } },
          },
          investor: { select: { email: true } },
        },
      }),
      (p) => {
        const who =
          p.partner?.partner?.displayName ??
          p.partner?.email ??
          p.investor?.email ??
          null;
        return {
          label: [p.cycle.code, who].filter(Boolean).join(' · '),
          href: cycleHref(p.cycleId),
        };
      },
    ),
  // VERIFY_STOCK writes the *cycle's* id under this type (inventory.service),
  // one row for the whole receipt. A batch id is looked for too, so a future
  // row about one batch is named rather than dropped.
  InventoryBatch: async (db, ids) => {
    const [cycles, batches] = await Promise.all([
      db.importCycle.findMany({
        ...asIn(ids),
        select: { id: true, code: true },
      }),
      db.inventoryBatch.findMany({
        ...asIn(ids),
        select: {
          id: true,
          cycleId: true,
          cycle: { select: { code: true } },
          product: { select: { name: true, nameAr: true } },
        },
      }),
    ]);
    return new Map([
      ...keyed(batches, (b) => ({
        label: `${b.cycle.code} · ${b.product.name}`,
        labelAr: b.product.nameAr
          ? `${b.cycle.code} · ${b.product.nameAr}`
          : null,
        href: cycleHref(b.cycleId),
      })),
      ...keyed(cycles, (c) => ({ label: c.code, href: cycleHref(c.id) })),
    ]);
  },
  Settlement: async (db, ids) =>
    keyed(
      await db.settlement.findMany({
        ...asIn(ids),
        select: { id: true, cycleId: true, cycle: { select: { code: true } } },
      }),
      (s) => ({ label: s.cycle.code, href: cycleHref(s.cycleId) }),
    ),
  FinancialTransaction: async (db, ids) =>
    keyed(
      await db.financialTransaction.findMany({
        ...asIn(ids),
        select: {
          id: true,
          amount: true,
          currency: true,
          cycleId: true,
          cycle: { select: { code: true } },
        },
      }),
      // A ledger entry has no number of its own: its cycle, if any, and its sum.
      (f) => ({
        label: f.cycle?.code ?? null,
        href: cycleHref(f.cycleId),
        amount: money(f.amount, f.currency),
      }),
    ),
  Supplier: async (db, ids) =>
    keyed(
      await db.supplier.findMany({
        ...asIn(ids),
        select: { id: true, name: true },
      }),
      (s) => ({ label: s.name }),
    ),
  SupplierRefund: async (db, ids) =>
    keyed(
      await db.supplierRefund.findMany({
        ...asIn(ids),
        select: {
          id: true,
          amount: true,
          currency: true,
          purchaseOrder: { select: { reference: true, cycleId: true } },
        },
      }),
      (r) => ({
        label: r.purchaseOrder.reference,
        href: cycleHref(r.purchaseOrder.cycleId),
        amount: money(r.amount, r.currency),
      }),
    ),
  Provider: async (db, ids) =>
    keyed(
      await db.provider.findMany({
        ...asIn(ids),
        select: { id: true, name: true },
      }),
      (p) => ({ label: p.name }),
    ),
  Category: async (db, ids) =>
    keyed(
      await db.category.findMany({
        ...asIn(ids),
        select: { id: true, name: true, nameAr: true },
      }),
      (c) => ({ label: c.name, labelAr: c.nameAr }),
    ),
  Lender: async (db, ids) =>
    keyed(
      await db.lender.findMany({
        ...asIn(ids),
        select: { id: true, name: true },
      }),
      (l) => ({ label: l.name, href: `/lenders/${l.id}` }),
    ),
  LenderFinancing: async (db, ids) =>
    keyed(
      await db.lenderFinancing.findMany({
        ...asIn(ids),
        select: {
          id: true,
          amount: true,
          currency: true,
          lenderId: true,
          lender: { select: { name: true } },
        },
      }),
      (f) => ({
        label: f.lender.name,
        href: `/lenders/${f.lenderId}`,
        amount: money(f.amount, f.currency),
      }),
    ),
  LenderRepayment: async (db, ids) =>
    keyed(
      await db.lenderRepayment.findMany({
        ...asIn(ids),
        select: {
          id: true,
          amountEgp: true,
          financing: {
            select: { lenderId: true, lender: { select: { name: true } } },
          },
        },
      }),
      (r) => ({
        label: r.financing.lender.name,
        href: `/lenders/${r.financing.lenderId}`,
        amount: money(r.amountEgp, 'EGP'),
      }),
    ),
  LenderPlan: async (db, ids) =>
    keyed(
      await db.lenderPlan.findMany({
        ...asIn(ids),
        select: {
          id: true,
          financing: {
            select: { lenderId: true, lender: { select: { name: true } } },
          },
        },
      }),
      (p) => ({
        label: p.financing.lender.name,
        href: `/lenders/${p.financing.lenderId}`,
      }),
    ),
  ShippingLeg: async (db, ids) =>
    keyed(
      await db.shippingLeg.findMany({
        ...asIn(ids),
        select: { id: true, ...legSelect },
      }),
      (l) => ({ label: legLabel(l), href: cycleHref(l.cycleId) }),
    ),
  ShipmentDeparture: async (db, ids) =>
    keyed(
      await db.shipmentDeparture.findMany({
        ...asIn(ids),
        select: { id: true, leg: { select: legSelect } },
      }),
      (d) => ({ label: legLabel(d.leg), href: cycleHref(d.leg.cycleId) }),
    ),
  ShipmentDelivery: async (db, ids) =>
    keyed(
      await db.shipmentDelivery.findMany({
        ...asIn(ids),
        select: { id: true, leg: { select: legSelect } },
      }),
      (d) => ({ label: legLabel(d.leg), href: cycleHref(d.leg.cycleId) }),
    ),
  ShipmentLoss: async (db, ids) =>
    keyed(
      await db.shipmentLoss.findMany({
        ...asIn(ids),
        select: { id: true, costEgp: true, leg: { select: legSelect } },
      }),
      (l) => ({
        label: legLabel(l.leg),
        href: cycleHref(l.leg.cycleId),
        amount: money(l.costEgp, 'EGP'),
      }),
    ),
  StockTransfer: async (db, ids) =>
    keyed(
      await db.stockTransfer.findMany({
        ...asIn(ids),
        select: {
          id: true,
          fromCycleId: true,
          fromCycle: { select: { code: true } },
          toCycle: { select: { code: true } },
        },
      }),
      (s) => ({
        label: `${s.fromCycle.code} → ${s.toCycle.code}`,
        href: cycleHref(s.fromCycleId),
      }),
    ),
  User: async (db, ids) =>
    keyed(
      await db.user.findMany({
        ...asIn(ids),
        select: {
          id: true,
          email: true,
          partner: { select: { displayName: true } },
        },
      }),
      (u) => ({ label: u.partner?.displayName ?? u.email }),
    ),
  // The id is derived from the currency code (currency-rates.service), so
  // there is no row to read: the code is on the audit row itself.
  CurrencyRate: (_db, _ids, rows) => {
    const labels: Labels = new Map();
    for (const r of rows) {
      const code = codeIn(r.afterJson) ?? codeIn(r.beforeJson);
      if (code) labels.set(r.entityId, { label: code });
    }
    return Promise.resolve(labels);
  },
};
RESOLVERS.Cycle = RESOLVERS.ImportCycle;

function codeIn(json: unknown): string | null {
  if (json && typeof json === 'object' && 'code' in json) {
    const { code } = json;
    return typeof code === 'string' && code ? code : null;
  }
  return null;
}

/** The record types this file can name. */
export const LABELLED_ENTITY_TYPES = Object.keys(RESOLVERS);

/**
 * Each row with the name of what it is about. Rows are returned in the order
 * given; a record that cannot be found keeps nulls.
 */
export async function withEntityLabels<T extends Row>(
  db: Db,
  rows: T[],
): Promise<(T & AuditLabelled)[]> {
  const byType = new Map<string, T[]>();
  for (const r of rows) {
    if (!RESOLVERS[r.entityType] || !r.entityId) continue;
    const list = byType.get(r.entityType) ?? [];
    list.push(r);
    byType.set(r.entityType, list);
  }

  const resolved = new Map<string, Labels>();
  await Promise.all(
    [...byType].map(async ([type, typed]) => {
      const ids = [...new Set(typed.map((r) => r.entityId))];
      resolved.set(type, await RESOLVERS[type](db, ids, typed));
    }),
  );

  return rows.map((r) => {
    const found = resolved.get(r.entityType)?.get(r.entityId);
    return {
      ...r,
      entityLabel: found?.label ?? null,
      entityLabelAr: found?.labelAr ?? null,
      entityHref: found?.href ?? null,
      entityAmount: found?.amount ?? null,
    };
  });
}
