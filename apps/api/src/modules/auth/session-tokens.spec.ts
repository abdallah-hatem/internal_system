import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import { hashToken, newRefreshToken } from '../../common/opaque-token';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { fakeSessionTable } from './session-tokens.fake-spec';
import {
  REFRESH_IDLE_MS,
  REUSE_GRACE_MS,
  SessionTokensService,
} from './session-tokens.service';

/**
 * Office refresh tokens (owner, 2026-10-17: "why do I have to log in every
 * time I open it"). BUSINESS_LOGIC §23.
 *
 * Each test tries to make a sign-in last longer, reach further or survive
 * something it should not: a spent token presented again, a token from
 * another door, a partner switched off, day thirty-one.
 */

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'session-tokens-spec-secret-long-enough-000';

interface FakeUser {
  id: string;
  email: string;
  role: string;
  status: string;
  partner: { displayName: string } | null;
}

let now: Date;
let users: FakeUser[];
let table: ReturnType<typeof fakeSessionTable>;
let db: Record<string, unknown>;
let sessions: SessionTokensService;

function addUser(over: Partial<FakeUser> = {}): FakeUser {
  const u: FakeUser = {
    id: randomUUID(),
    email: `p-${randomUUID().slice(0, 6)}@test.local`,
    role: 'CORE_PARTNER',
    status: 'ACTIVE',
    partner: { displayName: 'Partner' },
    ...over,
  };
  users.push(u);
  return u;
}

/** The refusal's code, or a failure if it did not refuse. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  throw new Error('expected a refusal, got a result');
}

const live = (familyOrUser: { familyId?: string; userId?: string }) =>
  table.rows.filter(
    (r) =>
      !r.revokedAt &&
      (familyOrUser.familyId ? r.familyId === familyOrUser.familyId : true) &&
      (familyOrUser.userId ? r.userId === familyOrUser.userId : true),
  );

const rowOf = (token: string) =>
  table.rows.find((r) => r.tokenHash === hashToken(token))!;

beforeEach(() => {
  now = new Date('2026-10-17T09:00:00Z');
  users = [];
  table = fakeSessionTable();
  db = {
    sessionRefreshToken: table.sessionRefreshToken,
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(users.find((u) => u.id === where.id) ?? null),
    },
  };
  db.$transaction = table.transaction(db);
  sessions = new SessionTokensService(
    db as unknown as PrismaService,
    () => now,
  );
});

describe('rotation', () => {
  it('spends the token, hands back a successor in the same sign-in', async () => {
    const u = addUser();
    const first = await sessions.issue(u.id);

    const next = await sessions.rotate(first);

    expect(next.refreshToken).not.toBe(first);
    expect(next.user).toEqual({
      id: u.id,
      email: u.email,
      role: u.role,
      partner: { displayName: 'Partner' },
    });
    const spent = rowOf(first);
    const fresh = rowOf(next.refreshToken);
    expect(spent.replacedById).toBe(fresh.id);
    expect(spent.revokedAt).toEqual(now);
    expect(fresh.familyId).toBe(spent.familyId);
    expect(live({ familyId: spent.familyId })).toHaveLength(1);
  });

  it('stores only the hash, never the token', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    expect(JSON.stringify(table.rows)).not.toContain(token);
  });

  it('rolls: opening the app every 29 days keeps it signed in for months', async () => {
    const u = addUser();
    let token = await sessions.issue(u.id);
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 29 * DAY);
      token = (await sessions.rotate(token)).refreshToken;
    }
    expect(rowOf(token).expiresAt).toEqual(
      new Date(now.getTime() + REFRESH_IDLE_MS),
    );
  });

  it('two refreshes racing on one token both succeed, in the same sign-in, and it is spent once', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);

    const [a, b] = await Promise.all([
      sessions.rotate(token),
      sessions.rotate(token),
    ]);

    expect(a.refreshToken).not.toBe(b.refreshToken);
    const family = rowOf(token).familyId;
    expect(rowOf(a.refreshToken).familyId).toBe(family);
    expect(rowOf(b.refreshToken).familyId).toBe(family);
    expect(live({ familyId: family })).toHaveLength(2);
    // The original points at exactly one successor.
    expect([rowOf(a.refreshToken).id, rowOf(b.refreshToken).id]).toContain(
      rowOf(token).replacedById,
    );
  });

  it('a sign-out landing in the middle of a refresh: the refresh gets nothing', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    // The user is read between the token check and the write; sign out there.
    const users = db.user as { findUnique: (a: unknown) => Promise<unknown> };
    const read = users.findUnique;
    users.findUnique = async (a) => {
      await sessions.revokeFamilyOf(token);
      return read(a);
    };

    expect(await refusal(sessions.rotate(token))).toBe('SESSION_EXPIRED');
    expect(live({ userId: u.id })).toHaveLength(0);
  });

  it('a race that lands after a sign-out gets nothing', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    const { refreshToken: next } = await sessions.rotate(token);
    await sessions.revokeFamilyOf(next);

    expect(await refusal(sessions.rotate(token))).toBe('SESSION_EXPIRED');
    expect(live({ userId: u.id })).toHaveLength(0);
  });
});

describe('expiry', () => {
  it('thirty days without opening the app ends the sign-in', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    now = new Date(now.getTime() + 30 * DAY);

    expect(await refusal(sessions.rotate(token))).toBe('SESSION_EXPIRED');
    // Nothing was written for a refused refresh.
    expect(table.rows).toHaveLength(1);
  });

  it('a minute before the thirtieth day it still works', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    now = new Date(now.getTime() + 30 * DAY - 60_000);
    await expect(sessions.rotate(token)).resolves.toBeDefined();
  });
});

/** Past the window in which a spent token is still the same holder racing. */
const afterGrace = () => {
  now = new Date(now.getTime() + REUSE_GRACE_MS + 1000);
};

describe('reuse of a spent token', () => {
  it('within 30 seconds: the same app racing itself, given a pair in the same sign-in', async () => {
    const u = addUser();
    const first = await sessions.issue(u.id);
    const { refreshToken: winner } = await sessions.rotate(first);
    now = new Date(now.getTime() + REUSE_GRACE_MS);

    const late = await sessions.rotate(first);

    expect(rowOf(late.refreshToken).familyId).toBe(rowOf(first).familyId);
    // Neither copy was punished: both successors still work.
    await expect(sessions.rotate(winner)).resolves.toBeDefined();
    await expect(sessions.rotate(late.refreshToken)).resolves.toBeDefined();
  });

  it('ends the whole sign-in — the thief and the app both sign in again', async () => {
    const u = addUser();
    const stolen = await sessions.issue(u.id);
    const { refreshToken: appToken } = await sessions.rotate(stolen);
    afterGrace();

    expect(await refusal(sessions.rotate(stolen))).toBe('SESSION_EXPIRED');
    // The app's perfectly good successor is dead too.
    expect(await refusal(sessions.rotate(appToken))).toBe('SESSION_EXPIRED');
    expect(live({ familyId: rowOf(stolen).familyId })).toHaveLength(0);
  });

  it('a spent token reused after it expired still ends its family', async () => {
    const u = addUser();
    const stolen = await sessions.issue(u.id);
    const { refreshToken: appToken } = await sessions.rotate(stolen);
    now = new Date(now.getTime() + 31 * DAY);
    // The app's token expired too by now, but a reused token is the alarm.
    await refusal(sessions.rotate(stolen));
    expect(rowOf(appToken).revokedAt).toEqual(now);
  });

  it("leaves the same partner's other devices signed in", async () => {
    const u = addUser();
    const phone = await sessions.issue(u.id);
    const laptop = await sessions.issue(u.id);
    await sessions.rotate(phone);
    afterGrace();
    await refusal(sessions.rotate(phone));

    await expect(sessions.rotate(laptop)).resolves.toBeDefined();
  });
});

describe('a partner who may no longer come in', () => {
  it.each(['INACTIVE', 'SUSPENDED'])(
    'status %s: refused, and every sign-in they hold ends',
    async (status) => {
      const u = addUser();
      const phone = await sessions.issue(u.id);
      await sessions.issue(u.id);
      u.status = status;

      expect(await refusal(sessions.rotate(phone))).toBe('SESSION_INVALID');
      expect(live({ userId: u.id })).toHaveLength(0);
    },
  );

  it('an account that became a shop owner holds no office sign-in', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    u.role = 'SHOP_OWNER_PORTAL';
    expect(await refusal(sessions.rotate(token))).toBe('SESSION_INVALID');
  });

  it('a deleted user is refused, not a 500', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    users.length = 0;
    expect(await refusal(sessions.rotate(token))).toBe('SESSION_INVALID');
  });

  it('deactivating a user from Users revokes every sign-in they hold', async () => {
    const target = addUser();
    const other = addUser();
    await sessions.issue(target.id);
    await sessions.issue(target.id);
    const otherToken = await sessions.issue(other.id);
    const usersDb = {
      ...db,
      user: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(users.find((u) => u.id === where.id) ?? null),
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeUser>;
        }) => {
          const row = users.find((u) => u.id === where.id)!;
          for (const [k, v] of Object.entries(data)) {
            if (v !== undefined)
              (row as unknown as Record<string, unknown>)[k] = v;
          }
          return Promise.resolve({ ...row, passwordHash: 'x' });
        },
      },
    };
    const usersService = new UsersService(
      usersDb as unknown as PrismaService,
      {} as SettlementsService,
      sessions,
    );

    await usersService.deactivate(target.id);

    expect(live({ userId: target.id })).toHaveLength(0);
    await expect(sessions.rotate(otherToken)).resolves.toBeDefined();
  });

  it('editing an active user (a name change) leaves their sign-ins alone', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    const usersService = new UsersService(
      {
        ...db,
        user: {
          findUnique: () => Promise.resolve(u),
          update: () => Promise.resolve({ ...u, passwordHash: 'x' }),
        },
      } as unknown as PrismaService,
      {} as SettlementsService,
      sessions,
    );
    await usersService.update(u.id, { displayName: 'New name' });
    await expect(sessions.rotate(token)).resolves.toBeDefined();
  });
});

describe('tokens from another door', () => {
  const jwt = new JwtService({ secret: SECRET });

  it('an assistant (MCP) access token cannot be turned into an office sign-in', async () => {
    const u = addUser();
    const mcp = new AuthService(
      db as unknown as PrismaService,
      jwt,
      sessions,
    ).issueAssistantToken({ id: u.id });

    expect(await refusal(sessions.rotate(mcp))).toBe('SESSION_EXPIRED');
    expect(table.rows).toHaveLength(0);
  });

  it("the assistant's OAuth refresh token is not an office refresh token", async () => {
    const u = addUser();
    // Made exactly as OAuthService makes them, stored in its own table.
    const assistantRefresh = newRefreshToken();
    await sessions.issue(u.id); // the partner is signed in to the office too

    expect(await refusal(sessions.rotate(assistantRefresh))).toBe(
      'SESSION_EXPIRED',
    );
  });

  it('an office access token is not a refresh token either', async () => {
    const u = addUser();
    const access = jwt.sign({ sub: u.id }, { audience: 'internal' });
    expect(await refusal(sessions.rotate(access))).toBe('SESSION_EXPIRED');
  });

  it.each([undefined, null, '', 42, {}])(
    'nothing usable (%p) is refused',
    async (v) => {
      expect(await refusal(sessions.rotate(v))).toBe('SESSION_EXPIRED');
    },
  );
});

describe('signing out', () => {
  it('ends this sign-in, including the tokens it was refreshed into', async () => {
    const u = addUser();
    const first = await sessions.issue(u.id);
    const { refreshToken: current } = await sessions.rotate(first);
    const laptop = await sessions.issue(u.id);

    await sessions.revokeFamilyOf(current);

    expect(await refusal(sessions.rotate(current))).toBe('SESSION_EXPIRED');
    await expect(sessions.rotate(laptop)).resolves.toBeDefined();
  });

  it('twice, or with a token nobody issued, is quietly fine', async () => {
    const u = addUser();
    const token = await sessions.issue(u.id);
    await sessions.revokeFamilyOf(token);
    await expect(sessions.revokeFamilyOf(token)).resolves.toBeUndefined();
    await expect(
      sessions.revokeFamilyOf('nobody-issued-this'),
    ).resolves.toBeUndefined();
    await expect(sessions.revokeFamilyOf(undefined)).resolves.toBeUndefined();
  });

  it('everywhere: every family of this user, nobody else', async () => {
    const u = addUser();
    const other = addUser();
    await sessions.issue(u.id);
    await sessions.issue(u.id);
    const otherToken = await sessions.issue(other.id);

    expect(await sessions.revokeAllForUser(u.id)).toBe(2);
    expect(live({ userId: u.id })).toHaveLength(0);
    await expect(sessions.rotate(otherToken)).resolves.toBeDefined();
  });
});
