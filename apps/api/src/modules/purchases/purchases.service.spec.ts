import type { HttpException } from '@nestjs/common';
// The service catches Prisma's own error class, so the test must build one.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Prisma } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';

/**
 * The second of two simultaneous sends of one receipt.
 *
 * Both pass the "already recorded?" check before either commits, so the
 * database is what stops the second. Over HTTP the requests never quite
 * overlap — the e2e race test passed with this path switched off — so it is
 * forced here: the check finds nothing, the write fails on a unique index,
 * and by then the first order is recorded.
 *
 * Both indexes are tried because the two sends also compute the same PO
 * reference, and Postgres reports whichever it checks first.
 */

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function refusalOf(e: unknown): { status: number; code: string } {
  const err = e as HttpException;
  return {
    status: err.getStatus(),
    code: (err.getResponse() as { code: string }).code,
  };
}

const body = (supplierInvoiceRef?: string): CreatePurchaseOrderDto => ({
  supplierId: 's1',
  currency: 'CNY',
  fxRateToEgp: 7,
  orderedOn: '2026-01-10',
  supplierInvoiceRef,
  items: [{ productId: 'p1', orderedQty: 2, unitPrice: 10 }],
});

/**
 * `recordedAfterWrite` is what the invoice lookup finds once the write has
 * failed — the first send's order, or nothing when the collision was
 * something else entirely.
 */
function service(
  writeError: unknown,
  recordedAfterWrite: { reference: string } | null,
) {
  const invoiceLookups: Array<{ reference: string } | null> = [
    null, // the check before the write: nobody has recorded it yet
    recordedAfterWrite,
  ];
  const prisma = {
    importCycle: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'c1',
        code: 'C-1',
        status: 'PURCHASING',
      }),
    },
    supplier: {
      findUnique: jest.fn().mockResolvedValue({ id: 's1', name: 'Yiwu Parts' }),
    },
    product: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', name: 'Brake pad' }),
    },
    purchaseOrder: {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          'supplierInvoiceRef' in args.where ? invoiceLookups.shift() : null,
        ),
      ),
    },
    $transaction: jest.fn().mockRejectedValue(writeError),
  };
  return new PurchasesService(
    prisma as unknown as PrismaService,
    { log: jest.fn() } as unknown as AuditService,
    {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService,
  );
}

describe('PurchasesService.create — a receipt sent twice at once', () => {
  it('the invoice index stops the second send: DUPLICATE_SUPPLIER_INVOICE, not a 500', async () => {
    const svc = service(
      uniqueViolation(['supplier_id', 'supplier_invoice_ref']),
      { reference: 'PO-2026-0007' },
    );

    const err: unknown = await svc
      .create('c1', body('inv-race'), 'u1')
      .catch((e: unknown) => e);

    expect(refusalOf(err)).toEqual({
      status: 400,
      code: 'DUPLICATE_SUPPLIER_INVOICE',
    });
    expect((err as HttpException).getResponse()).toMatchObject({
      params: {
        ref: 'INV-RACE',
        supplier: 'Yiwu Parts',
        purchaseOrder: 'PO-2026-0007',
      },
    });
  });

  it('the PO-reference index stops it instead: still DUPLICATE_SUPPLIER_INVOICE', async () => {
    const svc = service(uniqueViolation(['reference']), {
      reference: 'PO-2026-0007',
    });

    const err: unknown = await svc
      .create('c1', body('INV-RACE'), 'u1')
      .catch((e: unknown) => e);

    expect(refusalOf(err).code).toBe('DUPLICATE_SUPPLIER_INVOICE');
  });

  it('a collision that is not this invoice is not dressed up as one', async () => {
    // Another order took the same PO reference, but this receipt's number is
    // still unrecorded — calling it a duplicate invoice would be a lie.
    const collision = uniqueViolation(['reference']);
    const svc = service(collision, null);

    const err: unknown = await svc
      .create('c1', body('INV-RACE'), 'u1')
      .catch((e: unknown) => e);

    expect(err).toBe(collision);
  });

  it('a receipt with no number is never refused as a duplicate invoice', async () => {
    const collision = uniqueViolation(['reference']);
    const svc = service(collision, { reference: 'PO-2026-0007' });

    const err: unknown = await svc
      .create('c1', body(undefined), 'u1')
      .catch((e: unknown) => e);

    expect(err).toBe(collision);
  });

  it('an error that is not a unique violation passes through untouched', async () => {
    const down = new Error('connection reset');
    const svc = service(down, { reference: 'PO-2026-0007' });

    const err: unknown = await svc
      .create('c1', body('INV-RACE'), 'u1')
      .catch((e: unknown) => e);

    expect(err).toBe(down);
  });
});
