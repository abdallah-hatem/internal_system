import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ProductsController } from './products.controller';
import { productListWhere } from './product-list-where';

/**
 * `GET /products/summary`, the Products tab's cards (owner 2026-10-28): who
 * may read it, and the one `where` it shares with the table. Its figures
 * against a real database are in products-summary.db.spec.
 */

describe('GET /products/summary — who may read it (rule 12)', () => {
  const guard = new RolesGuard(new Reflector());
  const h = Object.getOwnPropertyDescriptor(
    ProductsController.prototype,
    'summary',
  )!.value as object;
  const as = (role: string | undefined) =>
    ({
      getHandler: () => h,
      getClass: () => ProductsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  // Stock is the office's: an investor's view of the catalogue carries none.
  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', undefined])(
    '%s is refused with 403 ROLE_NOT_ALLOWED',
    (role) => {
      let e: unknown;
      try {
        guard.canActivate(as(role));
      } catch (err) {
        e = err;
      }
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(403);
      expect((e as HttpException).getResponse()).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    },
  );

  it.each(['CORE_PARTNER', 'ADMIN_SUPPORT'])('%s is let through', (role) => {
    expect(guard.canActivate(as(role))).toBe(true);
  });

  it('the route carries the RolesGuard', () => {
    const guards = Reflect.getMetadata('__guards__', h) as unknown[];
    expect(guards).toContain(RolesGuard);
  });
});

describe('the Products list’s where (one for the table and the cards)', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return ((e as HttpException).getResponse() as { code: string }).code;
    }
    return 'accepted';
  };

  it('no filter is every product', () => {
    expect(productListWhere({})).toEqual({});
    expect(
      productListWhere({ categoryId: '', status: '', search: '' }),
    ).toEqual({});
  });

  it('a category is that category alone, not its subcategories', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(productListWhere({ categoryId: id })).toEqual({ categoryId: id });
  });

  it('Inactive is anything not on', () => {
    expect(productListWhere({ status: 'ACTIVE' })).toEqual({
      status: 'ACTIVE',
    });
    expect(productListWhere({ status: 'INACTIVE' })).toEqual({
      status: { not: 'ACTIVE' },
    });
  });

  it('refuses what the list does not offer, with the list’s codes', () => {
    expect(code(() => productListWhere({ status: 'active' }))).toBe(
      'LIST_FILTER_INVALID',
    );
    expect(code(() => productListWhere({ categoryId: 'Brakes' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(() => productListWhere({ search: 'x'.repeat(101) }))).toBe(
      'LIST_SEARCH_TOO_LONG',
    );
    expect(code(() => productListWhere({ categoryId: ['a'] }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
