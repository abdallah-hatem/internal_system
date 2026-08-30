import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { unauthorized, forbidden } from '../api-error';
import { SURFACE_KEY, type Surface } from '../surface';

/**
 * The fence between the office and the shop.
 *
 * Registered globally, so it runs on every route before any controller-level
 * guard. That ordering is why it verifies the token itself rather than reading
 * `request.user`: passport's `AuthGuard('jwt')` is applied per controller and
 * has not run yet when this executes.
 *
 * It checks one thing — that the token was issued for the surface being asked
 * for. Roles are still checked afterwards by `RolesGuard`, and ownership by the
 * portal services themselves. This is the outermost of the three, and the only
 * one that cannot be forgotten when a new route is written.
 */
@Injectable()
export class SurfaceGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const declared =
      this.reflector.getAllAndOverride<Surface>(SURFACE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'internal';

    const request = context.switchToHttp().getRequest();
    request.surface = declared;

    // The catalogue and the login pages. A token may be present — a signed-in
    // shop still browses — and is neither required nor inspected here.
    if (declared === 'public') return true;

    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized('AUTH_REQUIRED', 'Authentication required');

    let payload: { aud?: string | string[] };
    try {
      payload = this.jwt.verify(token);
    } catch {
      // Expired, forged, or signed with a rotated secret. All the same to the
      // caller: sign in again.
      throw unauthorized('SESSION_INVALID', 'Your session is no longer valid');
    }

    const audience = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;

    if (!audience) {
      // A token issued before audiences existed. That is a stale session, not
      // an attempt to go somewhere forbidden — and the difference matters,
      // because the web app redirects to the login page on 401 and does
      // nothing at all on 403. Returning 403 here would leave everyone signed
      // in before this shipped stuck on a screen of errors with no way back.
      throw unauthorized('SESSION_INVALID', 'Your session is no longer valid');
    }

    if (audience !== declared) {
      // A real token for the other system. This one IS forbidden rather than
      // stale: signing in again would not help, because the account is not
      // meant to be here at all.
      throw forbidden(
        'WRONG_SURFACE',
        `This token is not valid for the ${declared} system.`,
        { surface: declared },
      );
    }

    return true;
  }
}
