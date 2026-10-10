import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CyclesController } from './cycles.controller';
import { CyclesService } from './cycles.service';

/**
 * GET /cycles/:id/shipment — the refusals (B1, plan 2026-10-10). The
 * arithmetic is tested in common/shipment-position.spec.ts; e2e for the same
 * cases is apps/web/tests/73-shipment-position.spec.ts.
 */

function makeService(findUnique: jest.Mock) {
  const prisma = { importCycle: { findUnique } };
  return new CyclesService(prisma as never, {} as never, {} as never);
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, unknown>,
    };
  }
  throw new Error('expected a refusal');
}

/** The handler the @Roles metadata sits on, read without detaching a method. */
const shipmentHandler: unknown = Object.getOwnPropertyDescriptor(
  CyclesController.prototype,
  'getShipment',
)!.value;

function contextFor(role: string): ExecutionContext {
  return {
    getHandler: () => shipmentHandler,
    getClass: () => CyclesController,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role } }) }),
  } as unknown as ExecutionContext;
}

describe('GET /cycles/:id/shipment', () => {
  it('for an unknown id → 404, not 500', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const r = await refusal(
      makeService(findUnique).getShipment(
        '00000000-0000-4000-8000-000000000000',
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual(
      expect.objectContaining({
        code: 'NOT_FOUND',
        params: { entity: 'cycle' },
      }),
    );
  });

  it('for an id that is not a uuid → 404 without asking the database (a cast failure would be a 500)', async () => {
    const findUnique = jest.fn();
    const r = await refusal(makeService(findUnique).getShipment('CYC-nope'));
    expect(r.status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('as an investor or shop → refused with a code', () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of [
      'TEMP_INVESTOR',
      'ADMIN_SUPPORT',
      'SHOP_OWNER_PORTAL',
    ]) {
      let thrown: HttpException | undefined;
      try {
        guard.canActivate(contextFor(role));
      } catch (e) {
        thrown = e as HttpException;
      }
      expect(thrown?.getStatus()).toBe(403);
      expect(thrown?.getResponse()).toEqual(
        expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
      );
    }
  });

  it('as a core partner → allowed (a guard that refuses everybody passes half a suite)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
  });

  it('returns the position for a real cycle, with each leg named', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 'c1',
      code: 'CYC-2026-0001',
      status: 'SELLING',
      shippingLegs: [
        {
          id: 'l1',
          sequence: 1,
          origin: 'Dubai, UAE',
          destination: 'Cairo, Egypt',
          departedOn: new Date('2026-09-01T00:00:00Z'),
          deliveries: [
            {
              id: 'd1',
              legId: 'l1',
              arrivedOn: new Date('2026-09-10T00:00:00Z'),
              note: null,
              lines: [{ id: 'dl1', purchaseOrderItemId: 'i1', qty: '15' }],
            },
          ],
          losses: [],
        },
      ],
      purchaseOrders: [
        {
          items: [
            {
              id: 'i1',
              orderedQty: '40',
              productId: 'p1',
              product: { name: 'Brake pad' },
            },
          ],
        },
      ],
      inventoryBatches: [
        {
          sourcePoItemId: 'i1',
          sourceDeliveryLineId: 'dl1',
          receivedQty: '14',
        },
      ],
    });
    const { data } = await makeService(findUnique).getShipment(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(data.accounted).toBe(false);
    expect(data.totals).toEqual({
      ordered: 40,
      received: 14,
      lost: 0,
      onTheWay: 25,
      waiting: 1,
    });
    expect(data.legs[0]).toEqual(
      expect.objectContaining({
        status: 'PARTLY_ARRIVED',
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
      }),
    );
    expect(data.lines[0].productName).toBe('Brake pad');
  });
});
