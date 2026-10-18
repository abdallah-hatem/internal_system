import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditController } from './audit.controller';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Who may read the audit log (rule 12). Every row holds the full before/after
 * of a sale, a payment, a settlement — so it is the business's books in
 * another shape, and only the roles that may read those may read it.
 * Both directions: the wrong role is refused with a code, the right one gets in.
 */

/** The handler function itself — the guard reads `@Roles` metadata off it. */
const handler = (name: 'findAll' | 'findOne'): object =>
  Object.getOwnPropertyDescriptor(AuditController.prototype, name)!
    .value as object;

describe('Audit log — who may read it (rule 12)', () => {
  const guard = new RolesGuard(new Reflector());
  const routes = { list: handler('findAll'), one: handler('findOne') };
  const as = (role: string | undefined, h: object) =>
    ({
      getHandler: () => h,
      getClass: () => AuditController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  const refusal = (role: string | undefined, h: object) => {
    try {
      guard.canActivate(as(role, h));
    } catch (e) {
      if (e instanceof HttpException) {
        return { status: e.getStatus(), body: e.getResponse() };
      }
      throw e;
    }
    return undefined;
  };

  describe.each(Object.entries(routes))('%s', (_name, h) => {
    it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])(
      '%s is refused with 403 ROLE_NOT_ALLOWED',
      (role) => {
        const r = refusal(role, h);
        expect(r?.status).toBe(403);
        expect(r?.body).toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
      },
    );

    it('a role the app has never heard of is refused, not let through', () => {
      expect(refusal('SOMETHING_NEW', h)?.body).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    });

    it('a request with no user on it is refused', () => {
      expect(refusal(undefined, h)?.body).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    });

    it.each(['CORE_PARTNER', 'ADMIN_SUPPORT'])('%s is let through', (role) => {
      expect(guard.canActivate(as(role, h))).toBe(true);
    });
  });

  it('the guard is attached to the controller, not only the roles declared', () => {
    const guards = Reflect.getMetadata('__guards__', AuditController) as
      unknown[] | undefined;
    expect(guards).toContain(RolesGuard);
  });
});

/**
 * The "Who" filter and the actor's name (owner 2026-10-18: "filter by the 3
 * users, me, Fares & Shady"). The id arrives from the address bar, so it can be
 * anything: a wrong one is a coded 400 or 404, never a 500 from a uuid cast.
 */
describe('Audit log — filtering by who did it', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const SUPPORT = '22222222-2222-4222-8222-222222222222';
  const NOBODY = '99999999-9999-4999-8999-999999999999';

  const rows = [
    {
      id: 'a1',
      actorUserId: OWNER,
      action: 'CREATE',
      entityType: 'unknownType',
      entityId: 'e1',
      actor: {
        id: OWNER,
        email: 'owner@x.test',
        partner: { displayName: 'Abdallah' },
      },
    },
    {
      id: 'a2',
      actorUserId: null,
      action: 'UPDATE',
      entityType: 'unknownType',
      entityId: 'e2',
      actor: null,
    },
    {
      id: 'a3',
      actorUserId: SUPPORT,
      action: 'UPDATE',
      entityType: 'unknownType',
      entityId: 'e3',
      actor: { id: SUPPORT, email: 'support@x.test', partner: null },
    },
  ];

  const make = () => {
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            [OWNER, SUPPORT].includes(where.id) ? { id: where.id } : null,
          ),
        ),
      },
      auditLog: {
        findMany: jest.fn(() => Promise.resolve(rows)),
        findUnique: jest.fn(() => Promise.resolve(rows[0])),
      },
    };
    // A stub of the two models it reads.
    return {
      prisma,
      controller: new AuditController(prisma as unknown as PrismaService),
    };
  };

  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        return { status: e.getStatus(), body: e.getResponse() };
      }
      throw e;
    }
    throw new Error('expected a refusal');
  };

  type Query = Parameters<AuditController['findAll']>[0];
  const q = (v: Partial<Query>) => v as Query;

  it('passes the chosen person to the query, with the type filter', async () => {
    const { prisma, controller } = make();
    await controller.findAll(
      q({ actorUserId: OWNER, entityType: 'saleOrder' }),
    );
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorUserId: OWNER, entityType: 'saleOrder' },
      }),
    );
  });

  it('no person chosen: no actor condition at all (everyone)', async () => {
    const { prisma, controller } = make();
    await controller.findAll(q({}));
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('an id that is not an id → 400 VALIDATION_FAILED, and the query never runs', async () => {
    const { prisma, controller } = make();
    const r = await refusal(controller.findAll(q({ actorUserId: 'fares' })));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('an id that is nobody → 404 NOT_FOUND, not an empty list reading as "did nothing"', async () => {
    const { prisma, controller } = make();
    const r = await refusal(controller.findAll(q({ actorUserId: NOBODY })));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('each row names its actor by the partner’s name; no partner → null name; no actor → null', async () => {
    const { controller } = make();
    const { data } = await controller.findAll(q({}));
    expect(data.map((d) => d.actor)).toEqual([
      { id: OWNER, email: 'owner@x.test', displayName: 'Abdallah' },
      null,
      { id: SUPPORT, email: 'support@x.test', displayName: null },
    ]);
  });

  it('one row: the same name; an id that is not one → 404, not a 500', async () => {
    const { controller } = make();
    const { data } = await controller.findOne(
      '11111111-1111-4111-8111-aaaaaaaaaaaa',
    );
    expect(data.actor).toEqual({
      id: OWNER,
      email: 'owner@x.test',
      displayName: 'Abdallah',
    });
    const r = await refusal(controller.findOne('not-an-id'));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
