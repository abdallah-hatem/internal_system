import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { unauthorized } from '../api-error';

/**
 * The shop this request belongs to, from the signed token.
 *
 * Every portal endpoint takes it this way and none of them accept a customer
 * id as a parameter, a body field or a query filter. Ownership is checked far
 * less often than amounts, and the way not to forget it is to leave no route
 * on which a shop could name another shop in the first place.
 *
 * It throws rather than returning undefined. A portal route reached without a
 * shop on the token means the surface guard or the login let something through
 * that should not be here, and the loud version of that is the one that gets
 * noticed.
 */
export const CurrentShop = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest().user;
  if (!user?.customerId) {
    throw unauthorized('PORTAL_ACCOUNT_INCOMPLETE', 'This account is not linked to a shop yet.');
  }
  return user.customerId as string;
});
