import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditController } from './audit.controller';

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
