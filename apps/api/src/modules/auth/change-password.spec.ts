import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { API_PREFIX, OUTSIDE_API_PREFIX } from '../../common/api-prefix';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { SurfaceGuard } from '../../common/guards/surface.guard';
import { validationRefusal } from '../../common/validation-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { fakeSessionTable } from './session-tokens.fake-spec';
import { SESSION_CLOCK, SessionTokensService } from './session-tokens.service';

/**
 * Changing your own password, over real HTTP (owner, 2026-10-14).
 *
 * The office's Settings form sent `{ currentPassword, newPassword }` and the
 * controller read `body.oldPassword`, an inline type the global pipe never
 * looks at. bcrypt was handed `undefined`, so every change failed — and with
 * no rule on the new password either, it would have taken "1" had it worked.
 *
 * Driven the way the web app drives it: log in, post to /auth/change-password
 * with the bearer token, log in again. Everything `main.ts` puts in front of
 * the route is here — the prefix, the pipe with its whitelist, the filter,
 * SurfaceGuard — with an in-memory users table underneath.
 */

const SECRET = 'change-password-spec-secret-long-enough-0';
const START = 'password123';

interface FakeUser {
  id: string;
  email: string;
  role: string;
  status: string;
  passwordHash: string;
  lastLoginAt: Date | null;
  partner: { displayName: string } | null;
}

type Where = Record<string, unknown>;
const matches = (row: object, where: Where) =>
  Object.entries(where).every(
    ([k, v]) => (row as Record<string, unknown>)[k] === v,
  );

/** Lets the event loop run, as a real database call would. */
const tick = () => new Promise((r) => setImmediate(r));

function fakeDb() {
  const users: FakeUser[] = [];
  const user = {
    findUnique: async ({ where }: { where: Where }) => {
      await tick();
      return users.find((u) => matches(u, where)) ?? null;
    },
    update: async ({
      where,
      data,
    }: {
      where: Where;
      data: Partial<FakeUser>;
    }) => {
      await tick();
      const row = users.find((u) => matches(u, where));
      if (!row) throw new Error('no such user');
      Object.assign(row, data);
      return row;
    },
    create: async ({
      data,
    }: {
      data: Partial<FakeUser> & { partner?: unknown };
    }) => {
      await tick();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the nested create is not stored
      const { partner, ...rest } = data;
      const row: FakeUser = {
        id: randomUUID(),
        status: 'ACTIVE',
        lastLoginAt: null,
        partner: null,
        ...(rest as Partial<FakeUser>),
      } as FakeUser;
      users.push(row);
      return row;
    },
  };
  const sessions = fakeSessionTable();
  const db: Record<string, unknown> = {
    user,
    sessionRefreshToken: sessions.sessionRefreshToken,
  };
  db.$transaction = sessions.transaction(db);
  return { users, sessions, db };
}

let app: INestApplication;
let base: string;
let store: ReturnType<typeof fakeDb>;
const jwt = new JwtService({ secret: SECRET });

async function addUser(role = 'CORE_PARTNER', password = START) {
  const row: FakeUser = {
    id: randomUUID(),
    email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.local`,
    role,
    status: 'ACTIVE',
    passwordHash: await bcrypt.hash(password, 4),
    lastLoginAt: null,
    partner: role === 'CORE_PARTNER' ? { displayName: 'Partner' } : null,
  };
  store.users.push(row);
  return row;
}

beforeAll(async () => {
  store = fakeDb();
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [AuthController],
    providers: [
      AuthService,
      JwtStrategy,
      SessionTokensService,
      { provide: SESSION_CLOCK, useValue: () => new Date() },
      { provide: PrismaService, useValue: store.db },
      { provide: JwtService, useValue: jwt },
      {
        provide: ConfigService,
        useValue: {
          get: (k: string) => (k === 'JWT_SECRET' ? SECRET : undefined),
        },
      },
      { provide: APP_GUARD, useClass: SurfaceGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  // As main.ts does.
  app.setGlobalPrefix(API_PREFIX, { exclude: OUTSIDE_API_PREFIX });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: validationRefusal,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  base = `http://127.0.0.1:${port}/${API_PREFIX}`;
});

afterAll(async () => {
  await app.close();
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { accessToken?: string; refreshToken?: string };
    error?: { code: string; message: string; params?: Record<string, unknown> };
  };
  return { status: res.status, body: json };
}

async function login(email: string, password: string) {
  return post('/auth/login', { email, password });
}

async function signedIn(role = 'CORE_PARTNER') {
  const user = await addUser(role);
  const res = await login(user.email, START);
  expect(res.status).toBe(200);
  return {
    user,
    token: res.body.data!.accessToken!,
    refresh: res.body.data!.refreshToken!,
  };
}

const change = (token: string | undefined, body: unknown) =>
  post('/auth/change-password', body, token);

describe('POST /auth/change-password', () => {
  it('changes the password: the old one then fails to log in and the new one works', async () => {
    const { user, token } = await signedIn();
    const before = user.passwordHash;

    const res = await change(token, {
      currentPassword: START,
      newPassword: 'StrongPassword@123',
    });
    expect(res.status).toBe(200);

    // Re-hashed, not stored as typed.
    expect(user.passwordHash).not.toBe(before);
    expect(user.passwordHash).not.toContain('StrongPassword@123');
    expect(await bcrypt.compare('StrongPassword@123', user.passwordHash)).toBe(
      true,
    );

    const old = await login(user.email, START);
    expect(old.status).toBe(401);
    expect(old.body.error?.code).toBe('INVALID_CREDENTIALS');
    const fresh = await login(user.email, 'StrongPassword@123');
    expect(fresh.status).toBe(200);
  });

  it('signs out every other device, and keeps this one signed in', async () => {
    const { user, token, refresh: thisDevice } = await signedIn();
    const laptop = (await login(user.email, START)).body.data!.refreshToken!;

    const res = await change(token, {
      currentPassword: START,
      newPassword: 'Another1pass',
    });
    expect(res.status).toBe(200);
    const handedBack = (res.body.data as { refreshToken?: string })
      .refreshToken!;
    expect(handedBack).toBeTruthy();

    // Both earlier sign-ins are over, this device's old token included…
    for (const old of [laptop, thisDevice]) {
      const r = await post('/auth/refresh', { refreshToken: old });
      expect(r.status).toBe(401);
      expect(r.body.error?.code).toBe('SESSION_EXPIRED');
    }
    // …and the one handed back carries on.
    expect(
      (await post('/auth/refresh', { refreshToken: handedBack })).status,
    ).toBe(200);
  });

  it('a refused change ends nobody', async () => {
    const { token, refresh } = await signedIn();
    const res = await change(token, {
      currentPassword: 'notMyPassword9',
      newPassword: 'StrongPassword@123',
    });
    expect(res.status).toBe(400);
    expect(
      (await post('/auth/refresh', { refreshToken: refresh })).status,
    ).toBe(200);
  });

  it('keeps the session: the token that changed the password still works afterwards', async () => {
    const { token } = await signedIn();
    expect(
      (
        await change(token, {
          currentPassword: START,
          newPassword: 'Another1pass',
        })
      ).status,
    ).toBe(200);

    const profile = await fetch(`${base}/auth/profile`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(profile.status).toBe(200);
  });

  it('refuses a wrong current password with its code, and changes nothing', async () => {
    const { user, token } = await signedIn();
    const before = user.passwordHash;

    const res = await change(token, {
      currentPassword: 'notMyPassword9',
      newPassword: 'StrongPassword@123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('WRONG_CURRENT_PASSWORD');
    expect(user.passwordHash).toBe(before);
    expect((await login(user.email, START)).status).toBe(200);
  });

  it.each([
    ['too short', 'abc12'],
    ['seven characters', 'abcde12'],
    ['letters only', 'onlyletters'],
    ['digits only', '1234567890'],
    ['symbols and digits, no letter', '!!!!1234'],
  ])(
    'refuses a weak new password (%s) with PASSWORD_TOO_WEAK',
    async (_label, weak) => {
      const { user, token } = await signedIn();
      const before = user.passwordHash;

      const res = await change(token, {
        currentPassword: START,
        newPassword: weak,
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('PASSWORD_TOO_WEAK');
      expect(res.body.error?.params).toEqual({ min: 8 });
      expect(res.body.error?.message).toBeTruthy();
      expect(user.passwordHash).toBe(before);
    },
  );

  it('accepts exactly eight characters with a letter and a digit', async () => {
    const { token } = await signedIn();
    expect(
      (await change(token, { currentPassword: START, newPassword: 'abcdefg1' }))
        .status,
    ).toBe(200);
  });

  it('refuses a new password equal to the current one', async () => {
    const { user, token } = await signedIn();
    const before = user.passwordHash;

    const res = await change(token, {
      currentPassword: START,
      newPassword: START,
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PASSWORD_SAME_AS_CURRENT');
    expect(user.passwordHash).toBe(before);
  });

  it.each([
    ['an empty body', {}],
    ['no new password', { currentPassword: START }],
    ['no current password', { newPassword: 'StrongPassword@123' }],
    ['empty strings', { currentPassword: '', newPassword: '' }],
    // The pipe's implicit conversion turns these into the strings '12345678'
    // and '87654321'; the second has no letter, so the rule refuses it.
    [
      'numbers instead of text',
      { currentPassword: 12345678, newPassword: 87654321 },
      'PASSWORD_TOO_WEAK',
    ],
    // The shape the controller used to read. It must be refused, not half-read.
    [
      'the old field name',
      { oldPassword: START, newPassword: 'StrongPassword@123' },
    ],
    [
      'an unknown extra field',
      {
        currentPassword: START,
        newPassword: 'StrongPassword@123',
        role: 'CORE_PARTNER',
      },
    ],
    [
      'a new password longer than the field',
      { currentPassword: START, newPassword: `a1${'x'.repeat(199)}` },
    ],
  ] as [string, object, string?][])(
    'answers %s with a coded 400, never a 500',
    async (_label, body, code = 'VALIDATION_FAILED') => {
      const { user, token } = await signedIn();
      const before = user.passwordHash;

      const res = await change(token, body);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(code);
      expect(user.passwordHash).toBe(before);
    },
  );

  it('refuses a request without a token', async () => {
    const res = await change(undefined, {
      currentPassword: START,
      newPassword: 'StrongPassword@123',
    });
    expect(res.status).toBe(401);
  });

  it('refuses a forged token', async () => {
    const forged = new JwtService({
      secret: 'some-other-secret-entirely-000000000',
    }).sign({ sub: randomUUID() }, { audience: 'internal' });
    const res = await change(forged, {
      currentPassword: START,
      newPassword: 'StrongPassword@123',
    });
    expect(res.status).toBe(401);
  });

  it('changes only the caller’s own password', async () => {
    const { token } = await signedIn();
    const other = await addUser();
    const before = other.passwordHash;

    // There is no field naming whose password it is; one sent is refused.
    const res = await change(token, {
      currentPassword: START,
      newPassword: 'StrongPassword@123',
      userId: other.id,
    });
    expect(res.status).toBe(400);
    expect(other.passwordHash).toBe(before);

    expect(
      (
        await change(token, {
          currentPassword: START,
          newPassword: 'StrongPassword@123',
        })
      ).status,
    ).toBe(200);
    expect(other.passwordHash).toBe(before);
  });

  it('the second time: the same request again fails, because the current password has moved', async () => {
    const { user, token } = await signedIn();
    const body = { currentPassword: START, newPassword: 'StrongPassword@123' };
    expect((await change(token, body)).status).toBe(200);

    const again = await change(token, body);
    expect(again.status).toBe(400);
    expect(again.body.error?.code).toBe('WRONG_CURRENT_PASSWORD');

    // And changing onward from the new one works.
    expect(
      (
        await change(token, {
          currentPassword: 'StrongPassword@123',
          newPassword: 'Third1time',
        })
      ).status,
    ).toBe(200);
    expect((await login(user.email, 'Third1time')).status).toBe(200);
  });
});

describe('POST /auth/refresh and /auth/logout (owner, 2026-10-17)', () => {
  it('signing in hands out a refresh token; refreshing gives a working pair', async () => {
    const { refresh } = await signedIn();
    const r = await post('/auth/refresh', { refreshToken: refresh });
    expect(r.status).toBe(200);
    const { accessToken, refreshToken } = r.body.data!;
    expect(refreshToken).not.toBe(refresh);

    const profile = await fetch(`${base}/auth/profile`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(profile.status).toBe(200);

    // Short-lived: an hour, not JWT_EXPIRATION's day.
    const claims = jwt.decode<{ exp: number; iat: number; aud: string }>(
      accessToken!,
    );
    expect(claims.exp - claims.iat).toBe(3600);
    expect(claims.aud).toBe('internal');
  });

  it('needs no access token: it works after the access token has expired', async () => {
    const { refresh } = await signedIn();
    const expired = jwt.sign(
      { sub: randomUUID() },
      { audience: 'internal', expiresIn: -10 },
    );
    const r = await post('/auth/refresh', { refreshToken: refresh }, expired);
    expect(r.status).toBe(200);
  });

  it('the new token carries the role as it is now, not as it was at sign-in', async () => {
    const { user, refresh } = await signedIn();
    user.role = 'ADMIN_SUPPORT';
    const r = await post('/auth/refresh', { refreshToken: refresh });
    expect(jwt.decode<{ role: string }>(r.body.data!.accessToken!).role).toBe(
      'ADMIN_SUPPORT',
    );
  });

  it('a spent token presented again is refused with a code', async () => {
    const { refresh } = await signedIn();
    expect(
      (await post('/auth/refresh', { refreshToken: refresh })).status,
    ).toBe(200);
    const again = await post('/auth/refresh', { refreshToken: refresh });
    expect(again.status).toBe(401);
    expect(again.body.error?.code).toBe('SESSION_EXPIRED');
  });

  it.each([
    ['an empty body', {}],
    ['an empty token', { refreshToken: '' }],
    ['a number', { refreshToken: 5 }],
    ['an extra field', { refreshToken: 'x', userId: randomUUID() }],
  ] as [string, object][])(
    'answers %s with a coded 4xx, never a 500',
    async (_l, body) => {
      const r = await post('/auth/refresh', body);
      expect([400, 401]).toContain(r.status);
      expect(r.body.error?.code).toBeTruthy();
    },
  );

  it('logging out ends the sign-in on the server', async () => {
    const { refresh } = await signedIn();
    const out = await post('/auth/logout', { refreshToken: refresh });
    expect(out.status).toBe(200);
    const r = await post('/auth/refresh', { refreshToken: refresh });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe('SESSION_EXPIRED');
    // Again, harmlessly.
    expect((await post('/auth/logout', { refreshToken: refresh })).status).toBe(
      200,
    );
  });
});

describe('POST /auth/register uses the same rule', () => {
  it('refuses a weak password with PASSWORD_TOO_WEAK', async () => {
    const { token } = await signedIn('CORE_PARTNER');
    const res = await post(
      '/auth/register',
      {
        email: `new-${randomUUID().slice(0, 6)}@test.local`,
        password: 'abcdef',
        displayName: 'New One',
        role: 'ADMIN_SUPPORT',
      },
      token,
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PASSWORD_TOO_WEAK');
  });

  it('accepts a password that meets it', async () => {
    const { token } = await signedIn('CORE_PARTNER');
    const res = await post(
      '/auth/register',
      {
        email: `new-${randomUUID().slice(0, 6)}@test.local`,
        password: 'password123',
        displayName: 'New One',
        role: 'ADMIN_SUPPORT',
      },
      token,
    );
    expect(res.status).toBe(201);
  });
});
