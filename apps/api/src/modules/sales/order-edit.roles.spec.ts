import 'reflect-metadata';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SalesController } from './sales.controller';

/**
 * Editing a confirmed order is a core partner's call (BUSINESS_LOGIC §4,
 * 2026-10-25; CLAUDE.md §12): the API called directly, without the office,
 * applies the same rule. Both directions — the wrong role refused with a code,
 * the right one let through — for the preview and the save.
 */
describe('who may edit a confirmed order', () => {
  const guard = new RolesGuard(new Reflector());
  // The handlers the guard reads its metadata from, by name.
  const handlers = (['previewEdit', 'editOrder'] as const).map(
    (name) =>
      Object.getOwnPropertyDescriptor(SalesController.prototype, name)!
        .value as unknown,
  );
  const context = (handler: unknown, role: string) =>
    ({
      getHandler: () => handler,
      getClass: () => SalesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it.each(['ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])(
    '%s is refused, coded',
    (role) => {
      for (const handler of handlers) {
        let thrown: unknown;
        try {
          guard.canActivate(context(handler, role));
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(HttpException);
        expect(
          ((thrown as HttpException).getResponse() as { code: string }).code,
        ).toBe('ROLE_NOT_ALLOWED');
      }
    },
  );

  it('a core partner is let through', () => {
    for (const handler of handlers) {
      expect(guard.canActivate(context(handler, 'CORE_PARTNER'))).toBe(true);
    }
  });
});
