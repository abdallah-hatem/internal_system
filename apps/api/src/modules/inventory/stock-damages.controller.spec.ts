import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolesGuard } from '../../common/guards/roles.guard';
import { StockDamagesController } from './stock-damages.controller';

/**
 * Being logged in is not being allowed (CLAUDE.md §12): marking goods
 * damaged and undoing it move a cycle's profit, so both are core partners'
 * only — and the guard says so with a code, both directions tested.
 */
describe('TC-DMG-11 who may mark goods damaged', () => {
  const guard = new RolesGuard(new Reflector());
  const contextFor = (handler: () => unknown, role: string) =>
    ({
      getHandler: () => handler,
      getClass: () => StockDamagesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;
  // The handlers as the guard sees them: looked up, never called here.
  const handlerOf = (name: 'mark' | 'undo') =>
    Object.getOwnPropertyDescriptor(StockDamagesController.prototype, name)!
      .value as () => unknown;
  const mark = handlerOf('mark');
  const undo = handlerOf('undo');

  it.each([
    ['mark', mark],
    ['undo', undo],
  ])('%s names CORE_PARTNER and nobody else', (_name, handler) => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['CORE_PARTNER']);
  });

  it.each(['TEMP_INVESTOR', 'ADMIN_SUPPORT', 'SHOP_OWNER_PORTAL'])(
    'a %s is refused with ROLE_NOT_ALLOWED',
    (role) => {
      for (const handler of [mark, undo]) {
        try {
          guard.canActivate(contextFor(handler, role));
          throw new Error('expected a refusal');
        } catch (e) {
          expect(e).toBeInstanceOf(HttpException);
          expect((e as HttpException).getStatus()).toBe(403);
          expect(
            ((e as HttpException).getResponse() as { code: string }).code,
          ).toBe('ROLE_NOT_ALLOWED');
        }
      }
    },
  );

  it('a core partner is let through', () => {
    for (const handler of [mark, undo]) {
      expect(guard.canActivate(contextFor(handler, 'CORE_PARTNER'))).toBe(true);
    }
  });
});
