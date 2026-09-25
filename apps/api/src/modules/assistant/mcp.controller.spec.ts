import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { SurfaceGuard } from '../../common/guards/surface.guard';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantServer, ASSISTANT_SERVER_NAME } from './assistant-server';
import { ConfirmationService } from './confirmation.service';
import { McpController } from './mcp.controller';

/**
 * `/mcp` over real HTTP: the global SurfaceGuard, the controller's challenge
 * filter, the SDK's stateless transport. Only the database is fake.
 */

const SECRET = 'a-test-secret-that-is-long-enough-to-pass-the-check';
const jwt = new JwtService({ secret: SECRET });

const USERS: Record<string, { role: string; status: string }> = {
  partner: { role: 'CORE_PARTNER', status: 'ACTIVE' },
  investor: { role: 'TEMP_INVESTOR', status: 'ACTIVE' },
};

const prisma = {
  user: {
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(
        USERS[where.id]
          ? {
              id: where.id,
              email: `${where.id}@motoparts.test`,
              partner: null,
              ...USERS[where.id],
            }
          : null,
      ),
  },
  usedNonce: { create: jest.fn() },
};

let config: Record<string, string | undefined> = {};

const mcpToken = (sub: string) =>
  jwt.sign({ sub }, { audience: 'mcp', expiresIn: '1h' });

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
};

let app: INestApplication<App>;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [McpController],
    providers: [
      AssistantServer,
      ConfirmationService,
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: prisma },
      {
        provide: ConfigService,
        useValue: { get: (key: string) => config[key] },
      },
      { provide: APP_GUARD, useClass: SurfaceGuard },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
});

afterAll(() => app.close());

beforeEach(() => {
  config = { PUBLIC_BASE_URL: 'https://api.motoparts.example/' };
});

const post = (token?: string) => {
  const req = request(app.getHttpServer())
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

/** The two bodies `/mcp` answers with: the API's refusal, or JSON-RPC. */
interface Body {
  error: { code: string };
  result: { serverInfo: { name: string }; instructions: string };
}
const body = (res: { body: unknown }) => res.body as Body;

const CHALLENGE =
  'Bearer resource_metadata="https://api.motoparts.example/.well-known/oauth-protected-resource"';

describe('POST /mcp — who gets in', () => {
  it('no token is 401 with the resource-metadata header', async () => {
    const res = await post().send(INITIALIZE);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(CHALLENGE);
    expect(body(res).error.code).toBe('AUTH_REQUIRED');
  });

  it('without PUBLIC_BASE_URL the header names the forwarded host', async () => {
    config = {};
    const res = await post()
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'motoparts-api.vercel.app')
      .send(INITIALIZE);

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://motoparts-api.vercel.app/.well-known/oauth-protected-resource"',
    );
  });

  it('an invalid or expired token is 401 with the header, so the client signs in again', async () => {
    const forged = new JwtService({
      secret: 'not-the-secret-not-the-secret-not-the-secret',
    }).sign({ sub: 'partner' }, { audience: 'mcp' });
    const expired = jwt.sign(
      { sub: 'partner', exp: Math.floor(Date.now() / 1000) - 60 },
      { audience: 'mcp' },
    );

    for (const token of [forged, expired, 'not-a-jwt']) {
      const res = await post(token).send(INITIALIZE);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(CHALLENGE);
      expect(body(res).error.code).toBe('SESSION_INVALID');
    }
  });

  it("the office app's token is 403 WRONG_SURFACE, with no sign-in challenge", async () => {
    const office = jwt.sign({ sub: 'partner' }, { audience: 'internal' });

    const res = await post(office).send(INITIALIZE);

    expect(res.status).toBe(403);
    expect(body(res).error.code).toBe('WRONG_SURFACE');
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('a confirmation token is not an access token', async () => {
    const { token } = new ConfirmationService(
      jwt,
      prisma as unknown as PrismaService,
    ).issue('partner', 'create_purchase_order', {});

    const res = await post(token).send(INITIALIZE);

    expect(res.status).toBe(403);
    expect(body(res).error.code).toBe('WRONG_SURFACE');
  });

  it('an investor with a genuine mcp token is refused', async () => {
    const res = await post(mcpToken('investor')).send(INITIALIZE);

    expect(res.status).toBe(403);
    expect(body(res).error.code).toBe('ASSISTANT_PARTNERS_ONLY');
  });
});

describe('POST /mcp — a core partner', () => {
  it('initializes a stateless server with the receipt workflow in its instructions', async () => {
    const res = await post(mcpToken('partner')).send(INITIALIZE);

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(body(res).result.serverInfo.name).toBe(ASSISTANT_SERVER_NAME);
    const instructions: string = body(res).result.instructions;
    expect(instructions).toContain('match_receipt');
    expect(instructions).toContain('confirmationToken');
    expect(instructions).toContain('not stored');
  });

  it('answers a request with no initialize before it — nothing is kept between requests', async () => {
    const res = await post(mcpToken('partner'))
      .set('Mcp-Protocol-Version', '2025-06-18')
      .send({ jsonrpc: '2.0', id: 7, method: 'ping' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('a malformed body is a JSON-RPC error, not a 500', async () => {
    const res = await post(mcpToken('partner')).send({ hello: 'world' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(body(res).error).toBeDefined();
  });

  it('GET is 405 — a stateless server has no stream to open', async () => {
    const res = await request(app.getHttpServer())
      .get('/mcp')
      .set('Accept', 'text/event-stream')
      .set('Authorization', `Bearer ${mcpToken('partner')}`);

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST, DELETE');
  });

  it('GET without a token is still the 401 challenge', async () => {
    const res = await request(app.getHttpServer()).get('/mcp');

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(CHALLENGE);
  });
});
