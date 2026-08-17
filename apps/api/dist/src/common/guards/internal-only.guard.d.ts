import { CanActivate, ExecutionContext } from '@nestjs/common';
export declare class InternalOnlyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean;
}
