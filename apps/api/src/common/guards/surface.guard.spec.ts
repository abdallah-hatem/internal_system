import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { SurfaceGuard } from './surface.guard';
import { SURFACE_KEY } from '../surface';
import type { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../modules/auth/auth.service';

/**
 * The decision table of the fence.
 *
 * Asserted on the thrown code rather than the message: a message is English,
 * and `CLAUDE.md` rule 9 exists because branching on English is how a check
 * stops working the moment the reader is on Arabic. The code is the contract.
 */
const SECRET = 'test-secret';

interface FakeRequest {
  headers: Record<string, string>;
  surface?: string;
  user?: unknown;
}

interface FakeUser {
  id: string;
  email: string;
  role: string;
  status: string;
  partner: { displayName: string } | null;
}

function ctx(surface: string | undefined, token?: string) {
  const request: FakeRequest = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  return {
    request,
    context: {
      getHandler: () => 'handler',
      getClass: () => 'class',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
    reflector: {
      getAllAndOverride: (key: string) =>
        key === SURFACE_KEY ? surface : undefined,
    } as unknown as Reflector,
  };
}

/** What the guard threw: its status and the code a client translates. */
function refusalOf(e: unknown): { status: number; code: string } {
  const err = e as HttpException;
  return {
    status: err.getStatus(),
    code: (err.getResponse() as { code: string }).code,
  };
}

describe('SurfaceGuard', () => {
  const jwt = new JwtService({ secret: SECRET });
  const internal = jwt.sign(
    { sub: 'u1', role: 'CORE_PARTNER' },
    { audience: 'internal' },
  );
  const portal = jwt.sign(
    { sub: 'u2', role: 'SHOP_OWNER_PORTAL' },
    { audience: 'portal' },
  );
  const noAudience = jwt.sign({ sub: 'u3', role: 'CORE_PARTNER' });

  /** Users the guard can load, by id. Only `mcp` routes ever ask. */
  let users: Record<string, FakeUser> = {};
  const findUnique = jest.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve(users[where.id] ?? null),
  );
  const prisma = { user: { findUnique } } as unknown as PrismaService;

  const guard = (c: ReturnType<typeof ctx>) =>
    new SurfaceGuard(c.reflector, jwt, prisma);

  /** The coded refusal, or null if it was allowed through. */
  const refusal = async (c: ReturnType<typeof ctx>): Promise<string | null> => {
    try {
      await guard(c).canActivate(c.context);
      return null;
    } catch (e) {
      return refusalOf(e).code;
    }
  };

  it('lets an internal token through a route that declares nothing', async () => {
    expect(await refusal(ctx(undefined, internal))).toBeNull();
  });

  it('refuses a portal token on a route that declares nothing', async () => {
    // The whole point: a controller written later is fenced by default, before
    // anyone remembers to fence it.
    expect(await refusal(ctx(undefined, portal))).toBe('WRONG_SURFACE');
  });

  it('refuses an internal token on a portal route', async () => {
    expect(await refusal(ctx('portal', internal))).toBe('WRONG_SURFACE');
  });

  it('lets a portal token through a portal route', async () => {
    expect(await refusal(ctx('portal', portal))).toBeNull();
  });

  it('treats a token issued before audiences existed as a stale session', async () => {
    // Every token in circulation the day this ships. SESSION_INVALID rather
    // than WRONG_SURFACE on purpose: the web app redirects to the login page
    // on 401 and does nothing at all on 403, so a forbidden here would strand
    // everyone already signed in on a screen of errors with no way back.
    expect(await refusal(ctx(undefined, noAudience))).toBe('SESSION_INVALID');
  });

  it('refuses a request carrying no token at all', async () => {
    expect(await refusal(ctx(undefined))).toBe('AUTH_REQUIRED');
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = new JwtService({ secret: 'not-the-secret' }).sign(
      { sub: 'x', role: 'CORE_PARTNER' },
      { audience: 'internal' },
    );
    expect(await refusal(ctx(undefined, forged))).toBe('SESSION_INVALID');
  });

  it('refuses an expired token', async () => {
    const expired = jwt.sign(
      { sub: 'u1' },
      { audience: 'internal', expiresIn: '-1s' },
    );
    expect(await refusal(ctx(undefined, expired))).toBe('SESSION_INVALID');
  });

  describe('a public route', () => {
    it('is open with no token', async () => {
      expect(await refusal(ctx('public'))).toBeNull();
    });

    it('is open to a shop that is already signed in', async () => {
      // Browsing while signed in is the common case, and the token is not
      // inspected here — a portal token must not be refused on the catalogue.
      expect(await refusal(ctx('public', portal))).toBeNull();
    });

    it('is open even to a token that would be refused anywhere else', async () => {
      // Nothing about a public route depends on the token, including whether
      // it is valid. Verifying it here would make the catalogue fail for a
      // visitor whose session merely went stale.
      expect(await refusal(ctx('public', 'not.a.token'))).toBeNull();
    });
  });

  it('leaves the surface on the request for later guards to read', async () => {
    const c = ctx('portal', portal);
    await guard(c).canActivate(c.context);
    expect(c.request.surface).toBe('portal');
  });

  describe('an mcp route', () => {
    // Minted exactly as the API mints it, so these tests break if the token
    // AuthService issues ever stops fitting the guard.
    const auth = new AuthService({} as PrismaService, jwt);
    const assistant = (id = 'p1') => auth.issueAssistantToken({ id });
    const partner: FakeUser = {
      id: 'p1',
      email: 'partner@example.com',
      role: 'CORE_PARTNER',
      status: 'ACTIVE',
      partner: { displayName: 'P' },
    };

    beforeEach(() => {
      users = { p1: { ...partner } };
      findUnique.mockClear();
    });

    /** The full refusal, status included: 401 and 403 mean different things. */
    const thrown = async (c: ReturnType<typeof ctx>) => {
      try {
        await guard(c).canActivate(c.context);
      } catch (e) {
        return refusalOf(e);
      }
      throw new Error('expected a refusal, and the guard let it through');
    };

    it('internal token on an mcp route → WRONG_SURFACE', async () => {
      expect(await refusal(ctx('mcp', internal))).toBe('WRONG_SURFACE');
    });

    it('portal token on an mcp route → WRONG_SURFACE', async () => {
      expect(await refusal(ctx('mcp', portal))).toBe('WRONG_SURFACE');
    });

    it('mcp token on a route that declares nothing → WRONG_SURFACE', async () => {
      // The other half of the fence: every REST route is internal by default,
      // so the assistant reaches none of them.
      expect(await refusal(ctx(undefined, assistant()))).toBe('WRONG_SURFACE');
    });

    it('mcp token on a portal route → WRONG_SURFACE', async () => {
      expect(await refusal(ctx('portal', assistant()))).toBe('WRONG_SURFACE');
    });

    it('mcp token for a user whose role changed from core partner → ASSISTANT_PARTNERS_ONLY', async () => {
      const token = assistant();
      users.p1.role = 'TEMP_INVESTOR';
      expect(await refusal(ctx('mcp', token))).toBe('ASSISTANT_PARTNERS_ONLY');
    });

    it('mcp token for a core partner whose account is inactive → ASSISTANT_PARTNERS_ONLY', async () => {
      const token = assistant();
      users.p1.status = 'INACTIVE';
      expect(await refusal(ctx('mcp', token))).toBe('ASSISTANT_PARTNERS_ONLY');
    });

    it('mcp token for a suspended core partner → ASSISTANT_PARTNERS_ONLY', async () => {
      const token = assistant();
      users.p1.status = 'SUSPENDED';
      expect(await refusal(ctx('mcp', token))).toBe('ASSISTANT_PARTNERS_ONLY');
    });

    it('mcp token for a user who no longer exists → ASSISTANT_PARTNERS_ONLY', async () => {
      const token = assistant();
      users = {};
      expect(await refusal(ctx('mcp', token))).toBe('ASSISTANT_PARTNERS_ONLY');
    });

    it('mcp token for a shop owner → ASSISTANT_PARTNERS_ONLY', async () => {
      users.s1 = { ...partner, id: 's1', role: 'SHOP_OWNER_PORTAL' };
      expect(await refusal(ctx('mcp', assistant('s1')))).toBe(
        'ASSISTANT_PARTNERS_ONLY',
      );
    });

    it('mcp token with no subject → ASSISTANT_PARTNERS_ONLY', async () => {
      const token = jwt.sign({}, { audience: 'mcp' });
      expect(await refusal(ctx('mcp', token))).toBe('ASSISTANT_PARTNERS_ONLY');
    });

    it('expired mcp token → 401', async () => {
      const expired = jwt.sign(
        { sub: 'p1' },
        { audience: 'mcp', expiresIn: '-1s' },
      );
      expect(await thrown(ctx('mcp', expired))).toEqual({
        status: 401,
        code: 'SESSION_INVALID',
      });
    });

    it('token with no audience on an mcp route → 401 SESSION_INVALID', async () => {
      expect(await thrown(ctx('mcp', noAudience))).toEqual({
        status: 401,
        code: 'SESSION_INVALID',
      });
    });

    it('a partner refused the assistant gets a 403, not a sign-in prompt', async () => {
      // Signing in again would not help a demoted partner, so it must not be
      // the 401 that sends the client back to the login page.
      users.p1.role = 'TEMP_INVESTOR';
      expect(await thrown(ctx('mcp', assistant()))).toEqual({
        status: 403,
        code: 'ASSISTANT_PARTNERS_ONLY',
      });
    });

    it('no token on an mcp route → AUTH_REQUIRED', async () => {
      expect(await refusal(ctx('mcp'))).toBe('AUTH_REQUIRED');
    });

    it('valid mcp token for an active core partner on an mcp route → allowed', async () => {
      const c = ctx('mcp', assistant());
      expect(await guard(c).canActivate(c.context)).toBe(true);
      expect(c.request.surface).toBe('mcp');
      // Where a controller reads it, in the shape passport would have left.
      expect(c.request.user).toEqual({
        id: 'p1',
        email: 'partner@example.com',
        role: 'CORE_PARTNER',
        partner: { displayName: 'P' },
        customerId: undefined,
      });
    });

    it('the assistant token lasts one hour and names its user', () => {
      const payload = jwt.verify<{
        aud: string;
        sub: string;
        iat: number;
        exp: number;
      }>(assistant());
      expect(payload.aud).toBe('mcp');
      expect(payload.sub).toBe('p1');
      expect(payload.exp - payload.iat).toBe(3600);
    });

    it('does not load the user for a token refused on its audience', async () => {
      await refusal(ctx('mcp', internal));
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('does not load a user on an internal route', async () => {
      // Every office request passes this guard; a query per request here
      // would be paid by all of them for the assistant's sake.
      await refusal(ctx(undefined, internal));
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
