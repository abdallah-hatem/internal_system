import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

import { forbidden } from '../api-error';
@Injectable()
export class InternalOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw forbidden('AUTH_REQUIRED', 'Authentication required');
    if (user.role === 'SHOP_OWNER_PORTAL') {
      throw forbidden('INTERNAL_ONLY', 'Access denied: internal system only');
    }
    return true;
  }
}
