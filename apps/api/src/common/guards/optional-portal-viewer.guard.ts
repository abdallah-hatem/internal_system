import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Notices a signed-in shop on a page that does not require one.
 *
 * The catalogue is public, so `SurfaceGuard` lets it through without looking at
 * a token — but a verified shop browsing it must see its own prices, not
 * retail. This fills in `request.user` when a valid portal token happens to be
 * there and does nothing at all when it is not.
 *
 * It never throws. A visitor whose session merely expired must still be able to
 * read the catalogue; turning a stale token into a locked shop window would be
 * a worse bug than showing them retail prices.
 */
@Injectable()
export class OptionalPortalViewerGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return true;

    try {
      const payload: any = this.jwt.verify(token);
      // Only a portal token identifies a shop. An office token on the
      // catalogue is simply an anonymous reader — a partner browsing the store
      // is not a customer and has no prices of their own.
      if (payload.aud === 'portal' && payload.customerId) {
        request.user = {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
          customerId: payload.customerId,
        };
      }
    } catch {
      // Expired or malformed. The reader stays anonymous.
    }

    return true;
  }
}
