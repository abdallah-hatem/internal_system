import type { Prisma } from '@prisma/client';

import { OPEN_FOR_PURCHASING } from '../../purchases/purchase-rules';
import type { ReceiptSnapshot } from './receipt.types';

type Db = Pick<
  Prisma.TransactionClient,
  'supplier' | 'product' | 'importCycle' | 'purchaseOrder' | 'currencyRate'
>;

/**
 * What the business already knows, in the plain shape `analyzeReceipt` reads.
 *
 * Which cycles can take an order is the purchases service's rule, imported
 * rather than restated, so the assistant never offers a cycle the service
 * would then refuse. Every recorded invoice number is loaded, not only this
 * receipt's: the analysis compares numbers its own way, and a narrower query
 * here would be a second definition of "the same invoice".
 */
export async function loadReceiptSnapshot(db: Db): Promise<ReceiptSnapshot> {
  const [suppliers, products, cycles, drafts, rates, recorded] =
    await Promise.all([
      db.supplier.findMany({
        select: { id: true, name: true, country: true },
        orderBy: { name: 'asc' },
      }),
      db.product.findMany({
        select: { id: true, name: true, sku: true },
        orderBy: { name: 'asc' },
      }),
      db.importCycle.findMany({
        where: { status: { in: [...OPEN_FOR_PURCHASING] } },
        select: {
          id: true,
          code: true,
          originType: true,
          currency: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.purchaseOrder.findMany({
        where: {
          status: 'DRAFT',
          cycle: { status: { in: [...OPEN_FOR_PURCHASING] } },
        },
        select: { id: true, reference: true, cycleId: true, supplierId: true },
      }),
      db.currencyRate.findMany({ select: { code: true, rateToEgp: true } }),
      db.purchaseOrder.findMany({
        where: { supplierInvoiceRef: { not: null } },
        select: {
          supplierId: true,
          supplierInvoiceRef: true,
          reference: true,
          cycle: { select: { code: true } },
        },
      }),
    ]);

  return {
    suppliers,
    products,
    openCycles: cycles,
    draftOrders: drafts,
    fxRates: Object.fromEntries(
      rates.map((r) => [
        r.code,
        r.rateToEgp === null ? null : r.rateToEgp.toString(),
      ]),
    ),
    recordedInvoices: recorded.map((r) => ({
      supplierId: r.supplierId,
      invoiceRef: r.supplierInvoiceRef ?? '',
      purchaseOrderReference: r.reference,
      cycleCode: r.cycle.code,
    })),
  };
}
