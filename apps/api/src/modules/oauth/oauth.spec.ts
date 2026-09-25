import {
  Controller,
  Get,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
// The fake database must fail the way Postgres does, with Prisma's own class.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a test double raising Prisma's P2002
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { API_PREFIX, OUTSIDE_API_PREFIX } from '../../common/api-prefix';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { SurfaceGuard } from '../../common/guards/surface.guard';
import { Surface } from '../../common/surface';
import { validationRefusal } from '../../common/validation-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AssistantConnectionsController } from './assistant-connections.controller';
import { OAuthController, WellKnownController } from './oauth.controller';
import { hashToken, s256 } from './oauth.pure';
import { OAUTH_CLOCK, OAuthService } from './oauth.service';

/**
 * The OAuth door over real HTTP: the routes, the prefix exclusion, the global
 * pipe and filter, SurfaceGuard — everything `main.ts` puts in front of it —
 * with an in-memory database and a clock the tests move.
 *
 * Driven the way Claude drives it: register, open the page, post the login,
 * follow the redirect, redeem the code, refresh. Assertions are on what the
 * client receives — the status, the Location header, the RFC 6749 `error`.
 */

const SECRET = 'oauth-spec-secret-that-is-long-enough-000';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const DESKTOP_CB = 'http://localhost:6274/callback';

// ------------------------------------------------------------ fake database

interface FakeUser {
  id: string;
  email: string;
  role: string;
  status: string;
  passwordHash: string;
  partner: { displayName: string } | null;
}
interface FakeClient {
  id: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: Date;
}
interface FakeRefresh {
  id: string;
  userId: string;
  clientId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
}

type Where = Record<string, unknown>;
/** Equality, plus Prisma's `{ in: [...] }` — the one operator the service uses. */
const matches = (row: object, where: Where) =>
  Object.entries(where).every(([k, v]) => {
    const value = (row as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && 'in' in v) {
      return (v as { in: unknown[] }).in.includes(value);
    }
    return value === v;
  });

/** Lets the event loop run, so concurrent requests really interleave. */
const tick = () => new Promise((r) => setImmediate(r));

function fakeDb(clock: () => Date) {
  const users: FakeUser[] = [];
  const clients: FakeClient[] = [];
  const refresh: FakeRefresh[] = [];
  const nonces = new Map<string, { kind: string; expiresAt: Date }>();

  const models = (created?: FakeRefresh[]) => ({
    user: {
      findUnique: async ({ where }: { where: Where }) => {
        await tick();
        return users.find((u) => matches(u, where)) ?? null;
      },
    },
    oAuthClient: {
      create: async ({
        data,
      }: {
        data: Omit<FakeClient, 'id' | 'createdAt'>;
      }) => {
        await tick();
        const row = { id: randomUUID(), createdAt: clock(), ...data };
        clients.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Where }) => {
        await tick();
        return clients.find((c) => matches(c, where)) ?? null;
      },
    },
    oAuthRefreshToken: {
      create: async ({ data }: { data: Partial<FakeRefresh> }) => {
        await tick();
        const row: FakeRefresh = {
          id: randomUUID(),
          createdAt: clock(),
          lastUsedAt: null,
          revokedAt: null,
          replacedById: null,
          ...(data as Pick<
            FakeRefresh,
            'userId' | 'clientId' | 'tokenHash' | 'expiresAt'
          >),
        };
        refresh.push(row);
        created?.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: Where }) => {
        await tick();
        return refresh.find((r) => matches(r, where)) ?? null;
      },
      /** The client joined in, as a `select: { client: … }` would. */
      findMany: async ({ where }: { where: Where }) => {
        await tick();
        return refresh
          .filter((r) => matches(r, where))
          .map((r) => ({
            ...r,
            client: {
              clientName:
                clients.find((c) => c.id === r.clientId)?.clientName ?? null,
            },
          }));
      },
      updateMany: async ({ where, data }: { where: Where; data: object }) => {
        await tick();
        const hit = refresh.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    usedNonce: {
      create: async ({
        data,
      }: {
        data: { jti: string; kind: string; expiresAt: Date };
      }) => {
        await tick();
        if (nonces.has(data.jti)) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['jti'] },
            },
          );
        }
        nonces.set(data.jti, data);
        return data;
      },
    },
  });

  const db = {
    ...models(),
    /** Rows created inside a failed transaction are removed, as a rollback would. */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const created: FakeRefresh[] = [];
      try {
        return await fn(models(created));
      } catch (err) {
        for (const row of created) refresh.splice(refresh.indexOf(row), 1);
        throw err;
      }
    },
  };
  return { db, users, clients, refresh, nonces };
}

// --------------------------------------------------------------- the app

/** A route under the prefix, to prove the exclusion did not remove it. */
@Surface('public')
@Controller('probe')
class ProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/** An office route: declares nothing, so it is internal and wants a token. */
@Controller('office')
class OfficeProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

let app: INestApplication;
let base: string;
let now: Date;
let store: ReturnType<typeof fakeDb>;
// JwtStrategy reads the secret when it is built, so it is set before that.
const config: Record<string, string | undefined> = { JWT_SECRET: SECRET };
const jwt = new JwtService({ secret: SECRET });

const PASSWORD = 'correct horse battery';

async function addUser(role: string, status = 'ACTIVE') {
  const user: FakeUser = {
    id: randomUUID(),
    email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.local`,
    role,
    status,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    partner: role === 'CORE_PARTNER' ? { displayName: 'Partner' } : null,
  };
  store.users.push(user);
  return user;
}

beforeAll(async () => {
  now = new Date('2026-09-19T10:00:00Z');
  store = fakeDb(() => now);

  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule],
    controllers: [
      WellKnownController,
      OAuthController,
      AssistantConnectionsController,
      ProbeController,
      OfficeProbeController,
    ],
    providers: [
      OAuthService,
      AuthService,
      JwtStrategy,
      { provide: PrismaService, useValue: store.db },
      { provide: JwtService, useValue: jwt },
      { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      { provide: OAUTH_CLOCK, useValue: () => now },
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
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  now = new Date('2026-09-19T10:00:00Z');
  delete config.PUBLIC_BASE_URL;
});

// ----------------------------------------------------------- the client

const form = (fields: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(fields).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );

async function register(redirect_uris: unknown, extra: object = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris, client_name: 'Claude', ...extra }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function newClient(uri = CLAUDE_CB): Promise<string> {
  const { status, body } = await register([uri]);
  expect(status).toBe(201);
  return body.client_id as string;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier) };
}

function authorizeFields(
  clientId: string,
  challenge: string,
  overrides: Record<string, string | undefined> = {},
) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123 /+=&?',
    resource: 'https://api.example.com/mcp',
    ...overrides,
  };
}

async function openPage(fields: Record<string, string | undefined>) {
  const res = await fetch(
    `${base}/oauth/authorize?${form(fields).toString()}`,
    {
      redirect: 'manual',
    },
  );
  return {
    status: res.status,
    location: res.headers.get('location'),
    html: await res.text(),
  };
}

async function signIn(
  fields: Record<string, string | undefined>,
  email: string,
  password = PASSWORD,
) {
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ ...fields, email, password }),
    redirect: 'manual',
  });
  return {
    status: res.status,
    location: res.headers.get('location'),
    html: await res.text(),
  };
}

async function tokenCall(fields: Record<string, string | undefined>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(fields),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, string>,
  };
}

/** A partner signed in through the page: the code, and what redeems it. */
async function codeFor(email: string, clientId?: string) {
  const client = clientId ?? (await newClient());
  const { verifier, challenge } = pkce();
  const res = await signIn(authorizeFields(client, challenge), email);
  expect(res.status).toBe(302);
  const code = new URL(res.location!).searchParams.get('code')!;
  return { client, verifier, code };
}

const redeem = (
  c: { client: string; verifier: string; code: string },
  overrides = {},
) =>
  tokenCall({
    grant_type: 'authorization_code',
    code: c.code,
    code_verifier: c.verifier,
    client_id: c.client,
    redirect_uri: CLAUDE_CB,
    ...overrides,
  });

async function tokensFor(email: string) {
  const c = await codeFor(email);
  const res = await redeem(c);
  expect(res.status).toBe(200);
  return {
    client: c.client,
    access_token: res.body.access_token,
    refresh_token: res.body.refresh_token,
  };
}

const refreshCall = (client: string, refresh_token: string) =>
  tokenCall({ grant_type: 'refresh_token', client_id: client, refresh_token });

// ================================================================ register

describe('POST /oauth/register', () => {
  it('Register with https://evil.example/cb → 400 invalid_redirect_uri', async () => {
    const res = await register(['https://evil.example/cb']);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(
      store.clients.some((c) =>
        c.redirectUris.includes('https://evil.example/cb'),
      ),
    ).toBe(false);
  });

  it('Register with https://claude.ai/api/mcp/auth_callback → 201 with a client_id', async () => {
    const res = await register([CLAUDE_CB]);
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.redirect_uris).toEqual([CLAUDE_CB]);
  });

  it('Register with http://localhost:6274/callback → accepted', async () => {
    const res = await register([DESKTOP_CB]);
    expect(res.status).toBe(201);
  });

  it('one bad URI among good ones refuses the whole registration', async () => {
    const before = store.clients.length;
    const res = await register([CLAUDE_CB, 'https://evil.example/cb']);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(store.clients.length).toBe(before);
  });

  it('an empty or missing redirect list is refused', async () => {
    expect((await register([])).body.error).toBe('invalid_redirect_uri');
    expect((await register(undefined)).body.error).toBe('invalid_redirect_uri');
    expect((await register('https://claude.ai/cb')).body.error).toBe(
      'invalid_redirect_uri',
    );
    expect((await register([42])).body.error).toBe('invalid_redirect_uri');
  });

  it('a huge redirect list is refused', async () => {
    const res = await register(
      Array.from({ length: 11 }, (_, i) => `http://localhost:${6000 + i}/cb`),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('an over-long client name is refused as client metadata', async () => {
    const res = await register([CLAUDE_CB], { client_name: 'x'.repeat(201) });
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('unknown registration fields are ignored, not a validation error', async () => {
    const res = await register([CLAUDE_CB], {
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp',
    });
    expect(res.status).toBe(201);
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });
});

// =============================================================== authorize

describe('GET /oauth/authorize', () => {
  it('Authorize with an unknown client_id → error page, no redirect', async () => {
    const { challenge } = pkce();
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await openPage(authorizeFields(id, challenge));
      expect(res.status).toBe(400);
      expect(res.location).toBeNull();
      expect(res.html).toContain('data-error="unknown_client"');
    }
  });

  it('Authorize with a redirect_uri not registered to that client → error page, no redirect', async () => {
    const client = await newClient();
    const { challenge } = pkce();
    for (const uri of ['https://evil.example/cb', DESKTOP_CB, undefined]) {
      const res = await openPage(
        authorizeFields(client, challenge, { redirect_uri: uri }),
      );
      expect(res.status).toBe(400);
      expect(res.location).toBeNull();
      expect(res.html).toContain('data-error="unregistered_redirect"');
    }
  });

  it('Authorize without code_challenge, or with method plain → error (PKCE S256)', async () => {
    const client = await newClient();
    const { challenge } = pkce();
    for (const overrides of [
      { code_challenge: undefined },
      { code_challenge_method: 'plain' },
      { code_challenge_method: undefined },
      { code_challenge: 'too-short' },
    ]) {
      const res = await openPage(authorizeFields(client, challenge, overrides));
      expect(res.status).toBe(302);
      const back = new URL(res.location!);
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CB);
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('code')).toBeNull();
    }
    // …and the POST refuses the same, so the page cannot be skipped.
    const partner = await addUser('CORE_PARTNER');
    const res = await signIn(
      authorizeFields(client, challenge, { code_challenge_method: 'plain' }),
      partner.email,
    );
    expect(new URL(res.location!).searchParams.get('error')).toBe(
      'invalid_request',
    );
    expect(new URL(res.location!).searchParams.get('code')).toBeNull();
  });

  it('shows the sign-in page in English and in Arabic, with the request carried through', async () => {
    const client = await newClient();
    const { challenge } = pkce();
    const en = await openPage(authorizeFields(client, challenge));
    expect(en.status).toBe(200);
    expect(en.html).toContain('lang="en"');
    expect(en.html).toContain('Record or change sales, payments');
    expect(en.html).toContain(`value="${challenge}"`);
    const ar = await openPage(
      authorizeFields(client, challenge, { lang: 'ar' }),
    );
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain('ربط Claude');
  });

  it('echoes nothing unescaped from the request into the page', async () => {
    const client = await newClient();
    const { challenge } = pkce();
    const res = await openPage(
      authorizeFields(client, challenge, { state: '"><script>x()</script>' }),
    );
    expect(res.html).not.toContain('<script>x()');
    expect(res.html).toContain('&lt;script&gt;');
  });
});

describe('POST /oauth/authorize — signing in', () => {
  it('Wrong password → page shown again with an error, no code', async () => {
    const partner = await addUser('CORE_PARTNER');
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(
      authorizeFields(client, challenge),
      partner.email,
      'wrong',
    );
    expect(res.status).toBe(401);
    expect(res.location).toBeNull();
    expect(res.html).toContain('data-error="wrong_credentials"');
    expect(res.html).toContain(`value="${partner.email}"`);
  });

  it('an email with no account gets the same answer as a wrong password', async () => {
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(
      authorizeFields(client, challenge),
      'nobody@test.local',
    );
    expect(res.status).toBe(401);
    expect(res.html).toContain('data-error="wrong_credentials"');
  });

  it('Investor signs in → refused on the page', async () => {
    const investor = await addUser('TEMP_INVESTOR');
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(
      authorizeFields(client, challenge),
      investor.email,
    );
    expect(res.status).toBe(403);
    expect(res.location).toBeNull();
    expect(res.html).toContain('data-error="partners_only"');
  });

  it('Shop owner signs in → refused on the page', async () => {
    const shop = await addUser('SHOP_OWNER_PORTAL');
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(authorizeFields(client, challenge), shop.email);
    expect(res.status).toBe(403);
    expect(res.location).toBeNull();
    expect(res.html).toContain('data-error="partners_only"');
  });

  it('an inactive core partner → refused on the page', async () => {
    const partner = await addUser('CORE_PARTNER', 'SUSPENDED');
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(authorizeFields(client, challenge), partner.email);
    expect(res.status).toBe(403);
    expect(res.html).toContain('data-error="inactive"');
  });

  it('Core partner signs in → 302 to the redirect URI with a code and the exact state', async () => {
    const partner = await addUser('CORE_PARTNER');
    const client = await newClient();
    const { challenge } = pkce();
    const fields = authorizeFields(client, challenge);
    const res = await signIn(fields, partner.email);
    expect(res.status).toBe(302);
    const back = new URL(res.location!);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CB);
    expect(back.searchParams.get('state')).toBe(fields.state);
    expect(back.searchParams.get('code')).toBeTruthy();
  });

  it('a redirect_uri swapped in the posted form is refused with no redirect', async () => {
    const partner = await addUser('CORE_PARTNER');
    const client = await newClient();
    const { challenge } = pkce();
    const res = await signIn(
      authorizeFields(client, challenge, {
        redirect_uri: 'https://evil.example/cb',
      }),
      partner.email,
    );
    expect(res.status).toBe(400);
    expect(res.location).toBeNull();
  });

  it('the authorization code is refused as a bearer token anywhere', async () => {
    const partner = await addUser('CORE_PARTNER');
    const { code } = await codeFor(partner.email);
    expect(jwt.decode<{ aud: string }>(code).aud).toBe('oauth_code');
    const office = (bearer: string) =>
      fetch(`${base}/api/v1/office`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
    expect((await office(code)).status).not.toBe(200);
    // Signed on the real clock (the one above is on the test's), so what is
    // refused is the audience and not the age: no surface is `oauth_code`.
    const fresh = jwt.sign({ sub: partner.id }, { audience: 'oauth_code' });
    const res = await office(fresh);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'WRONG_SURFACE',
    );
  });
});

// =================================================================== token

describe('POST /oauth/token — authorization_code', () => {
  it('issues an mcp access token and a refresh token for a good code', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const res = await redeem(c);
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.expires_in).toBe(3600);
    const claims = jwt.verify<{ aud: string; sub: string }>(
      res.body.access_token,
    );
    expect(claims.aud).toBe('mcp');
    expect(claims.sub).toBe(partner.id);
    // Stored hashed, never as the token.
    expect(
      store.refresh.some((r) => r.tokenHash === res.body.refresh_token),
    ).toBe(false);
    expect(
      store.refresh.some(
        (r) => r.tokenHash === hashToken(res.body.refresh_token),
      ),
    ).toBe(true);
  });

  it('Token with the wrong code_verifier → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const res = await redeem(c, { code_verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    // A wrong verifier does not burn the code for its rightful holder.
    expect((await redeem(c)).status).toBe(200);
  });

  it('a missing code_verifier → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const res = await redeem(c, { code_verifier: undefined });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('Code used twice → second invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    expect((await redeem(c)).status).toBe(200);
    const second = await redeem(c);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  it('a code replayed concurrently is redeemed exactly once', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const results = await Promise.all([redeem(c), redeem(c), redeem(c)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.body.error === 'invalid_grant'),
    ).toHaveLength(2);
  });

  it('Code older than 5 minutes → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    now = new Date(now.getTime() + 5 * 60 * 1000 + 1000);
    const res = await redeem(c);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a code at four minutes is still good', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    now = new Date(now.getTime() + 4 * 60 * 1000);
    expect((await redeem(c)).status).toBe(200);
  });

  it('redirect_uri at the token step differs from authorize → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    for (const redirect_uri of [DESKTOP_CB, undefined]) {
      const res = await redeem(c, { redirect_uri });
      expect(res.body.error).toBe('invalid_grant');
    }
  });

  it('Code issued to client A, redeemed by client B → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const other = await newClient();
    const res = await redeem(c, { client_id: other });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('an unknown client at the token step → 401 invalid_client', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    for (const client_id of [randomUUID(), 'nope', undefined]) {
      const res = await redeem(c, { client_id });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_client');
    }
  });

  it('an office token presented as a code → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const office = jwt.sign({ sub: partner.id }, { audience: 'internal' });
    const res = await redeem(c, { code: office });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a partner demoted between sign-in and redemption gets no tokens', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    partner.role = 'TEMP_INVESTOR';
    const res = await redeem(c);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('an unsupported grant type → unsupported_grant_type', async () => {
    const res = await tokenCall({
      grant_type: 'password',
      username: 'a',
      password: 'b',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('a JSON token request is read the same as a form', async () => {
    const partner = await addUser('CORE_PARTNER');
    const c = await codeFor(partner.email);
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: c.code,
        code_verifier: c.verifier,
        client_id: c.client,
        redirect_uri: CLAUDE_CB,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /oauth/token — refresh_token', () => {
  it('Refresh → new access and refresh tokens; the old refresh token then fails', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const res = await refreshCall(first.client, first.refresh_token);
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).not.toBe(first.refresh_token);
    expect(jwt.verify<{ aud: string }>(res.body.access_token).aud).toBe('mcp');

    const old = await refreshCall(first.client, first.refresh_token);
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('invalid_grant');
  });

  it('a spent refresh token presented again ends the connection', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const second = (await refreshCall(first.client, first.refresh_token)).body;
    await refreshCall(first.client, first.refresh_token); // the replay
    const res = await refreshCall(first.client, second.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('two refreshes racing on one token: exactly one wins', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const results = await Promise.all([
      refreshCall(first.client, first.refresh_token),
      refreshCall(first.client, first.refresh_token),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const live = store.refresh.filter(
      (r) => r.userId === partner.id && r.revokedAt === null,
    );
    expect(live.length).toBeLessThanOrEqual(1);
  });

  it('Refresh a revoked token → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    store.refresh
      .filter((r) => r.tokenHash === hashToken(first.refresh_token))
      .forEach((r) => (r.revokedAt = now));
    const res = await refreshCall(first.client, first.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('Refresh after the partner was demoted → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    partner.role = 'TEMP_INVESTOR';
    const res = await refreshCall(first.client, first.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
    // Restored, the connection stays ended: the demotion revoked it.
    partner.role = 'CORE_PARTNER';
    expect(
      (await refreshCall(first.client, first.refresh_token)).body.error,
    ).toBe('invalid_grant');
  });

  it('refresh after the partner was switched off → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    partner.status = 'INACTIVE';
    const res = await refreshCall(first.client, first.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('Refresh older than 30 days → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    now = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 + 1000);
    const res = await refreshCall(first.client, first.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a refresh on day 29 works, and the new token has thirty days of its own', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    now = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
    const second = await refreshCall(first.client, first.refresh_token);
    expect(second.status).toBe(200);
    now = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
    expect(
      (await refreshCall(first.client, second.body.refresh_token)).status,
    ).toBe(200);
  });

  it('a refresh token presented by another client → invalid_grant', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const other = await newClient();
    const res = await refreshCall(other, first.refresh_token);
    expect(res.body.error).toBe('invalid_grant');
    // The rightful client is unaffected.
    expect((await refreshCall(first.client, first.refresh_token)).status).toBe(
      200,
    );
  });

  it('a refresh token that was never issued → invalid_grant', async () => {
    const client = await newClient();
    const res = await refreshCall(client, 'made-up');
    expect(res.body.error).toBe('invalid_grant');
  });
});

// ================================================================== revoke

describe('POST /oauth/revoke', () => {
  it('/oauth/revoke → that refresh token no longer works', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const res = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: first.refresh_token, client_id: first.client }),
    });
    expect(res.status).toBe(200);
    expect(
      (await refreshCall(first.client, first.refresh_token)).body.error,
    ).toBe('invalid_grant');
  });

  it('revoking an old, rotated token ends its successor too', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const second = (await refreshCall(first.client, first.refresh_token)).body;
    await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: first.refresh_token }),
    });
    expect(
      (await refreshCall(first.client, second.refresh_token)).body.error,
    ).toBe('invalid_grant');
  });

  it('an unknown token is answered 200, telling the caller nothing', async () => {
    const res = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: 'never-issued' }),
    });
    expect(res.status).toBe(200);
  });

  it('another client cannot revoke a token that is not its own', async () => {
    const partner = await addUser('CORE_PARTNER');
    const first = await tokensFor(partner.email);
    const other = await newClient();
    const res = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: first.refresh_token, client_id: other }),
    });
    expect(res.status).toBe(400);
    expect((await refreshCall(first.client, first.refresh_token)).status).toBe(
      200,
    );
  });
});

// ================================================================ metadata

describe('metadata', () => {
  it('Metadata carries absolute URLs on the public host', async () => {
    config.PUBLIC_BASE_URL = 'https://api.motoparts.example/';
    const as = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as.issuer).toBe('https://api.motoparts.example');
    expect(as.authorization_endpoint).toBe(
      'https://api.motoparts.example/oauth/authorize',
    );
    expect(as.token_endpoint).toBe('https://api.motoparts.example/oauth/token');
    expect(as.registration_endpoint).toBe(
      'https://api.motoparts.example/oauth/register',
    );
    expect(as.revocation_endpoint).toBe(
      'https://api.motoparts.example/oauth/revoke',
    );
    expect(as.code_challenge_methods_supported).toEqual(['S256']);

    for (const path of [
      'oauth-protected-resource',
      'oauth-protected-resource/mcp',
    ]) {
      const pr = (await (
        await fetch(`${base}/.well-known/${path}`)
      ).json()) as Record<string, unknown>;
      expect(pr.resource).toBe('https://api.motoparts.example/mcp');
      expect(pr.authorization_servers).toEqual([
        'https://api.motoparts.example',
      ]);
    }
  });

  it('without PUBLIC_BASE_URL, the forwarded host and protocol are used', async () => {
    const as = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`, {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'moto.example',
        },
      })
    ).json()) as Record<string, unknown>;
    expect(as.token_endpoint).toBe('https://moto.example/oauth/token');
  });

  it('the OAuth routes sit outside api/v1, and api/v1 routes stay inside it', async () => {
    expect(
      (await fetch(`${base}/api/v1/.well-known/oauth-authorization-server`))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/api/v1/oauth/token`, { method: 'POST' })).status,
    ).toBe(404);
    expect((await fetch(`${base}/api/v1/probe`)).status).toBe(200);
    expect((await fetch(`${base}/probe`)).status).toBe(404);
  });
});

describe('AuthService.checkPassword', () => {
  it('never hands back the password hash', async () => {
    const partner = await addUser('CORE_PARTNER');
    const auth = app.get(AuthService);
    const account = await auth.checkPassword(partner.email, PASSWORD);
    expect(account?.id).toBe(partner.id);
    expect(account).not.toHaveProperty('passwordHash');
    expect(await auth.checkPassword(partner.email, 'wrong')).toBeNull();
  });
});

// ============================================== Settings: Claude connections

/**
 * The office's view of the grants above: GET, DELETE one, DELETE all, under
 * `api/v1/auth/assistant-connections`. Connections are made through the real
 * door — sign in, redeem — so what is listed and ended is what Claude holds.
 */
describe('Settings → Claude connections', () => {
  const CONNECTIONS = '/api/v1/auth/assistant-connections';

  interface Listed {
    id: string;
    clientName: string | null;
    connectedAt: string;
    lastRefreshedAt: string | null;
  }
  interface Answer {
    status: number;
    body: {
      data?: unknown;
      error?: { code: string; params?: Record<string, unknown> };
    };
  }

  /** The office's own login, as `AuthService.login` signs it. */
  const officeToken = (user: FakeUser) =>
    jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      { audience: 'internal' },
    );

  async function call(
    token: string,
    method: 'GET' | 'DELETE',
    path = '',
  ): Promise<Answer> {
    const res = await fetch(`${base}${CONNECTIONS}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Answer['body'] };
  }

  const list = async (user: FakeUser) => {
    const res = await call(officeToken(user), 'GET');
    expect(res.status).toBe(200);
    return res.body.data as Listed[];
  };

  /** A partner signing one Claude app in; on the given client when there is one. */
  async function connect(user: FakeUser, clientId?: string) {
    const c = await codeFor(user.email, clientId);
    const res = await redeem(c);
    expect(res.status).toBe(200);
    return { client: c.client, refresh_token: res.body.refresh_token };
  }

  it('No connections → an empty list, not an error', async () => {
    const partner = await addUser('CORE_PARTNER');
    expect(await list(partner)).toEqual([]);
  });

  it('A partner sees only their own connections', async () => {
    const a = await addUser('CORE_PARTNER');
    const b = await addUser('CORE_PARTNER');
    const mine = await connect(a);
    const theirs = await connect(b);
    // One Claude app signed in by both: each sees only their own grant on it.
    const shared = await newClient();
    await connect(a, shared);
    await connect(b, shared);

    const seen = (await list(a)).map((c) => c.id).sort();
    expect(seen).toEqual([mine.client, shared].sort());
    expect(seen).not.toContain(theirs.client);
  });

  it("Disconnecting another partner's connection id → 404", async () => {
    const a = await addUser('CORE_PARTNER');
    const b = await addUser('CORE_PARTNER');
    const theirs = await connect(b);

    const res = await call(officeToken(a), 'DELETE', `/${theirs.client}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(res.body.error?.params).toEqual({ entity: 'assistantConnection' });

    // And nothing of B's was touched.
    expect(
      (await refreshCall(theirs.client, theirs.refresh_token)).status,
    ).toBe(200);
  });

  it("disconnecting a Claude app two partners share ends only the caller's grant", async () => {
    const a = await addUser('CORE_PARTNER');
    const b = await addUser('CORE_PARTNER');
    const shared = await newClient();
    const aGrant = await connect(a, shared);
    const bGrant = await connect(b, shared);

    expect((await call(officeToken(a), 'DELETE', `/${shared}`)).status).toBe(
      200,
    );
    expect((await refreshCall(shared, aGrant.refresh_token)).body.error).toBe(
      'invalid_grant',
    );
    expect((await refreshCall(shared, bGrant.refresh_token)).status).toBe(200);
    expect((await list(b)).map((c) => c.id)).toEqual([shared]);
  });

  it("Disconnect all → only this partner's tokens revoked", async () => {
    const a = await addUser('CORE_PARTNER');
    const b = await addUser('CORE_PARTNER');
    const phone = await connect(a);
    const laptop = await connect(a);
    const theirs = await connect(b);

    const res = await call(officeToken(a), 'DELETE');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ disconnected: 2 });

    expect(await list(a)).toEqual([]);
    for (const grant of [phone, laptop]) {
      expect(
        (await refreshCall(grant.client, grant.refresh_token)).body.error,
      ).toBe('invalid_grant');
    }
    expect((await list(b)).map((c) => c.id)).toEqual([theirs.client]);
    expect(
      (await refreshCall(theirs.client, theirs.refresh_token)).status,
    ).toBe(200);
  });

  it('Disconnect all with nothing connected → 200, nothing ended', async () => {
    const partner = await addUser('CORE_PARTNER');
    const res = await call(officeToken(partner), 'DELETE');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ disconnected: 0 });
  });

  it('Two Claude apps signed in by one partner → two separate connections, each disconnectable alone', async () => {
    const partner = await addUser('CORE_PARTNER');
    const phone = await connect(partner);
    const laptop = await connect(partner);

    const both = await list(partner);
    expect(both.map((c) => c.id).sort()).toEqual(
      [phone.client, laptop.client].sort(),
    );
    expect(both.every((c) => c.clientName === 'Claude')).toBe(true);

    expect(
      (await call(officeToken(partner), 'DELETE', `/${phone.client}`)).status,
    ).toBe(200);
    expect((await list(partner)).map((c) => c.id)).toEqual([laptop.client]);
    // The laptop was left alone and still refreshes.
    expect(
      (await refreshCall(laptop.client, laptop.refresh_token)).status,
    ).toBe(200);
  });

  it('After disconnecting, refresh fails', async () => {
    const partner = await addUser('CORE_PARTNER');
    const grant = await connect(partner);
    // Refreshed once, so the live token is not the one first issued: the
    // disconnect has to reach the successor, not only the original.
    const next = (await refreshCall(grant.client, grant.refresh_token)).body;

    expect(
      (await call(officeToken(partner), 'DELETE', `/${grant.client}`)).status,
    ).toBe(200);
    const res = await refreshCall(grant.client, next.refresh_token);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('a refreshed app is still one connection, dated from its sign-in', async () => {
    const partner = await addUser('CORE_PARTNER');
    const signedInAt = new Date(now);
    const grant = await connect(partner);

    let [only] = await list(partner);
    expect(only.connectedAt).toBe(signedInAt.toISOString());
    expect(only.lastRefreshedAt).toBeNull();

    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const second = (await refreshCall(grant.client, grant.refresh_token)).body;
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    await refreshCall(grant.client, second.refresh_token);

    const after = await list(partner);
    expect(after).toHaveLength(1);
    [only] = after;
    expect(only.connectedAt).toBe(signedInAt.toISOString());
    expect(only.lastRefreshedAt).toBe(now.toISOString());
  });

  it('an app unused for thirty days is no longer listed', async () => {
    const partner = await addUser('CORE_PARTNER');
    await connect(partner);
    now = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await list(partner)).toEqual([]);
  });

  it('disconnecting twice → the second is 404, not 500', async () => {
    const partner = await addUser('CORE_PARTNER');
    const grant = await connect(partner);
    const token = officeToken(partner);

    expect((await call(token, 'DELETE', `/${grant.client}`)).status).toBe(200);
    const again = await call(token, 'DELETE', `/${grant.client}`);
    expect(again.status).toBe(404);
    expect(again.body.error?.code).toBe('NOT_FOUND');
  });

  it('a non-uuid id → a coded 404, not a 500', async () => {
    const partner = await addUser('CORE_PARTNER');
    await connect(partner);
    const res = await call(officeToken(partner), 'DELETE', '/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(await list(partner)).toHaveLength(1);
  });

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', 'ADMIN_SUPPORT'])(
    'a %s office token → refused with ROLE_NOT_ALLOWED, on every route',
    async (role) => {
      const user = await addUser(role);
      const token = officeToken(user);
      for (const [method, path] of [
        ['GET', ''],
        ['DELETE', ''],
        ['DELETE', `/${randomUUID()}`],
      ] as const) {
        const res = await call(token, method, path);
        expect(res.status).toBe(403);
        expect(res.body.error?.code).toBe('ROLE_NOT_ALLOWED');
      }
    },
  );

  it('a shop-owner portal token → refused with WRONG_SURFACE', async () => {
    const shop = await addUser('SHOP_OWNER_PORTAL');
    const token = jwt.sign(
      { sub: shop.id, role: shop.role, customerId: randomUUID() },
      { audience: 'portal' },
    );
    const res = await call(token, 'GET');
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('WRONG_SURFACE');
  });

  it("the assistant's own mcp token → WRONG_SURFACE: Claude cannot see or end its grants", async () => {
    const partner = await addUser('CORE_PARTNER');
    const grant = await connect(partner);
    const mcp = app.get(AuthService).issueAssistantToken(partner);

    for (const [method, path] of [
      ['GET', ''],
      ['DELETE', ''],
      ['DELETE', `/${grant.client}`],
    ] as const) {
      const res = await call(mcp, method, path);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('WRONG_SURFACE');
    }
    expect((await list(partner)).map((c) => c.id)).toEqual([grant.client]);
  });

  it('no token → 401 AUTH_REQUIRED', async () => {
    const res = await fetch(`${base}${CONNECTIONS}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Answer['body'];
    expect(body.error?.code).toBe('AUTH_REQUIRED');
  });
});
