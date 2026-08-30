import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { SurfaceGuard } from './surface.guard';
import { SURFACE_KEY } from '../surface';

/**
 * The decision table of the fence.
 *
 * Asserted on the thrown code rather than the message: a message is English,
 * and `CLAUDE.md` rule 9 exists because branching on English is how a check
 * stops working the moment the reader is on Arabic. The code is the contract.
 */
const SECRET = 'test-secret';

function ctx(surface: string | undefined, token?: string) {
  const request: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  return {
    request,
    context: {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => request }),
    } as any,
    reflector: {
      getAllAndOverride: (key: string) => (key === SURFACE_KEY ? surface : undefined),
    } as unknown as Reflector,
  };
}

describe('SurfaceGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  const internal = jwt.sign({ sub: 'u1', role: 'CORE_PARTNER' }, { audience: 'internal' });
  const portal = jwt.sign({ sub: 'u2', role: 'SHOP_OWNER_PORTAL' }, { audience: 'portal' });
  const noAudience = jwt.sign({ sub: 'u3', role: 'CORE_PARTNER' });

  const guard = (c: ReturnType<typeof ctx>) => new SurfaceGuard(c.reflector, jwt);

  /** The coded refusal, or null if it was allowed through. */
  const refusal = (c: ReturnType<typeof ctx>): string | null => {
    try {
      guard(c).canActivate(c.context);
      return null;
    } catch (e: any) {
      return e.getResponse().code;
    }
  };

  it('lets an internal token through a route that declares nothing', () => {
    expect(refusal(ctx(undefined, internal))).toBeNull();
  });

  it('refuses a portal token on a route that declares nothing', () => {
    // The whole point: a controller written later is fenced by default, before
    // anyone remembers to fence it.
    expect(refusal(ctx(undefined, portal))).toBe('WRONG_SURFACE');
  });

  it('refuses an internal token on a portal route', () => {
    expect(refusal(ctx('portal', internal))).toBe('WRONG_SURFACE');
  });

  it('lets a portal token through a portal route', () => {
    expect(refusal(ctx('portal', portal))).toBeNull();
  });

  it('refuses a token issued before audiences existed', () => {
    // Every token in circulation today. Refused rather than grandfathered: one
    // that predates the fence has never been behind it.
    expect(refusal(ctx(undefined, noAudience))).toBe('WRONG_SURFACE');
  });

  it('refuses a request carrying no token at all', () => {
    expect(refusal(ctx(undefined))).toBe('AUTH_REQUIRED');
  });

  it('refuses a token signed with the wrong secret', () => {
    const forged = new JwtService({ secret: 'not-the-secret' }).sign(
      { sub: 'x', role: 'CORE_PARTNER' },
      { audience: 'internal' },
    );
    expect(refusal(ctx(undefined, forged))).toBe('SESSION_INVALID');
  });

  it('refuses an expired token', () => {
    const expired = jwt.sign({ sub: 'u1' }, { audience: 'internal', expiresIn: '-1s' });
    expect(refusal(ctx(undefined, expired))).toBe('SESSION_INVALID');
  });

  describe('a public route', () => {
    it('is open with no token', () => {
      expect(refusal(ctx('public'))).toBeNull();
    });

    it('is open to a shop that is already signed in', () => {
      // Browsing while signed in is the common case, and the token is not
      // inspected here — a portal token must not be refused on the catalogue.
      expect(refusal(ctx('public', portal))).toBeNull();
    });

    it('is open even to a token that would be refused anywhere else', () => {
      // Nothing about a public route depends on the token, including whether
      // it is valid. Verifying it here would make the catalogue fail for a
      // visitor whose session merely went stale.
      expect(refusal(ctx('public', 'not.a.token'))).toBeNull();
    });
  });

  it('leaves the surface on the request for later guards to read', () => {
    const c = ctx('portal', portal);
    guard(c).canActivate(c.context);
    expect(c.request.surface).toBe('portal');
  });
});
