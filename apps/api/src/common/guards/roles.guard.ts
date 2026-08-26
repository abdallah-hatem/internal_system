import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden } from '../api-error';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => {
  return (target: any, key?: string, descriptor?: any) => {
    if (descriptor) {
      Reflect.defineMetadata(ROLES_KEY, roles, descriptor.value);
      return descriptor;
    }
    Reflect.defineMetadata(ROLES_KEY, roles, target);
    return target;
  };
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;
    const { user } = context.switchToHttp().getRequest();
    if (requiredRoles.some((role) => user?.role === role)) return true;

    // Thrown rather than returning false: Nest turns a false into a bare
    // "Forbidden resource" carrying no code, which the client cannot
    // translate and which tells the reader nothing about why.
    throw forbidden(
      'ROLE_NOT_ALLOWED',
      'Your role does not allow this action.',
      { role: user?.role ?? 'unknown' },
    );
  }
}
