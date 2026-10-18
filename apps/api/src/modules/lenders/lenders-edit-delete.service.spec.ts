/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { LendersService } from './lenders.service';

/**
 * Editing and deleting a lender (owner, 2026-10-18). Deleting one who still
 * has a payment standing would erase a debt and the cost it carries on the
 * cycle, so it is refused; one added by mistake, or whose payments were all
 * removed, goes. He is hidden, not erased.
 */

const MISTAKE = '11111111-1111-4111-8111-111111111111';
const LENDING = '22222222-2222-4222-8222-222222222222';
const WAS_LENDING = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const PO = '44444444-4444-4444-8444-444444444444';

type Lender = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  deletedAt: Date | null;
};
type Financing = { lenderId: string; removedAt: Date | null };

function setup() {
  const lenders: Lender[] = [
    {
      id: MISTAKE,
      name: 'Typo Friend',
      phone: null,
      notes: null,
      deletedAt: null,
    },
    {
      id: LENDING,
      name: 'Ahmad Eraiby',
      phone: '010',
      notes: null,
      deletedAt: null,
    },
    {
      id: WAS_LENDING,
      name: 'Old Friend',
      phone: null,
      notes: null,
      deletedAt: null,
    },
  ];
  // Ahmad's payment stands; Old Friend's was removed — history, not a debt.
  const financings: Financing[] = [
    { lenderId: LENDING, removedAt: null },
    { lenderId: WAS_LENDING, removedAt: new Date('2026-10-10') },
  ];
  const matches = (l: Lender, where: any = {}) =>
    (where.id === undefined || where.id === l.id) &&
    (!('deletedAt' in where) ||
      (where.deletedAt === null ? l.deletedAt === null : true));
  const standingCount = (id: string, where: any) =>
    financings.filter(
      (f) =>
        f.lenderId === id &&
        (!where ||
          !('removedAt' in where) ||
          (f.removedAt === null) === (where.removedAt === null)),
    ).length;

  const prisma: any = {
    lender: {
      findUnique: async ({ where, include }: any) => {
        const l = lenders.find((x) => x.id === where.id);
        if (!l) return null;
        const out: any = { ...l, financings: [] };
        if (include?._count) {
          out._count = {
            financings: standingCount(
              l.id,
              include._count.select.financings.where,
            ),
          };
        }
        return out;
      },
      findFirst: async ({ where }: any) =>
        lenders.find((l) => matches(l, where)) ?? null,
      findMany: async ({ where }: any) =>
        lenders
          .filter((l) => matches(l, where))
          .map((l) => ({ ...l, financings: [] })),
      update: async ({ where, data }: any) => {
        const l = lenders.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return { ...l };
      },
    },
    purchaseOrder: {
      findUnique: async () => ({ id: PO, cycleId: 'c' }),
    },
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new LendersService(
    prisma as PrismaService,
    audit as unknown as AuditService,
    {} as NotificationsService,
    {} as any,
  );
  return { service, lenders, audit };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return e.getResponse().code as string;
  }
  return 'NO_ERROR';
};

describe('deleting a lender', () => {
  it('deletes one added by mistake, and he leaves the list and his page', async () => {
    const { service, lenders, audit } = setup();
    await service.remove(MISTAKE, 'actor');
    expect(lenders.find((l) => l.id === MISTAKE)!.deletedAt).toBeInstanceOf(
      Date,
    );
    const { data } = await service.list();
    expect(data.map((l) => l.id)).not.toContain(MISTAKE);
    expect(await code(service.findOne(MISTAKE))).toBe('NOT_FOUND');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DELETE', entityId: MISTAKE }),
    );
  });

  it('refuses one whose payment still stands, and changes nothing', async () => {
    const { service, lenders, audit } = setup();
    expect(await code(service.remove(LENDING, 'actor'))).toBe(
      'LENDER_HAS_FINANCINGS',
    );
    expect(lenders.find((l) => l.id === LENDING)!.deletedAt).toBeNull();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('deletes one whose payments were all removed — removed is history, not a debt', async () => {
    const { service, lenders } = setup();
    await service.remove(WAS_LENDING, 'actor');
    expect(lenders.find((l) => l.id === WAS_LENDING)!.deletedAt).toBeInstanceOf(
      Date,
    );
  });

  it('a second delete is a 404, not a second audit row', async () => {
    const { service, audit } = setup();
    await service.remove(MISTAKE, 'actor');
    expect(await code(service.remove(MISTAKE, 'actor'))).toBe('NOT_FOUND');
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('an id that is not a lender, or not an id at all, is a 404', async () => {
    const { service } = setup();
    expect(await code(service.remove(UNKNOWN, 'actor'))).toBe('NOT_FOUND');
    expect(await code(service.remove('not-a-uuid', 'actor'))).toBe('NOT_FOUND');
  });

  it('a deleted lender cannot be named on a new payment', async () => {
    const { service } = setup();
    await service.remove(MISTAKE, 'actor');
    expect(
      await code(
        service.finance(PO, { lenderId: MISTAKE, amount: 100 } as any, 'actor'),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('editing a lender', () => {
  it('corrects name, phone and notes, trimmed, and records before and after', async () => {
    const { service, lenders, audit } = setup();
    await service.update(
      LENDING,
      { name: '  Ahmad El Eraiby ', phone: ' ', notes: 'cousin' },
      'actor',
    );
    expect(lenders.find((l) => l.id === LENDING)).toMatchObject({
      name: 'Ahmad El Eraiby',
      phone: null,
      notes: 'cousin',
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        beforeJson: expect.objectContaining({ name: 'Ahmad Eraiby' }),
      }),
    );
  });

  it('refuses a blank name and keeps the old one', async () => {
    const { service, lenders } = setup();
    expect(await code(service.update(LENDING, { name: '   ' }, 'actor'))).toBe(
      'LENDER_NAME_REQUIRED',
    );
    expect(lenders.find((l) => l.id === LENDING)!.name).toBe('Ahmad Eraiby');
  });

  it('cannot edit a deleted lender back into view', async () => {
    const { service } = setup();
    await service.remove(MISTAKE, 'actor');
    expect(await code(service.update(MISTAKE, { name: 'Back' }, 'actor'))).toBe(
      'NOT_FOUND',
    );
  });
});
