import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ModuleRef } from '@nestjs/core';
// The nonce write fails with Prisma's own error class, so the fake must build one.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the test fakes a P2002 from the database
import { Prisma } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PrismaService } from '../../prisma/prisma.service';
import { badRequest, conflict } from '../../common/api-error';
import { AssistantServer } from './assistant-server';
import {
  CONFIRMATION_AUDIENCE,
  CONFIRMATION_TTL_SECONDS,
  ConfirmationService,
} from './confirmation.service';
import { writeTool, type AssistantUser } from './tool-kit';

/**
 * The confirmation pattern, driven through a real McpServer and the SDK's own
 * client — the path Claude takes — rather than by calling the helper directly.
 *
 * BUSINESS_LOGIC §16: nothing is written without a confirmed preview, and what
 * is written is what was previewed. Every case here is an attempt to write
 * something other than that.
 *
 * The tools below exist only in this file. Production has no write tool yet
 * (T7 and T8 add them), and the helper must be proven before they rely on it.
 */

const SECRET = 'a-test-secret-that-is-long-enough-to-pass-the-check';
const jwt = new JwtService({ secret: SECRET });

function user(id: string): AssistantUser {
  return {
    id,
    email: `${id}@motoparts.test`,
    role: 'CORE_PARTNER',
    partner: null,
  };
}
const partnerA = user('partner-a');
const partnerB = user('partner-b');

/** UsedNonce with its primary key: a second insert of one jti fails, atomically. */
let spent: Map<string, unknown>;
const prisma = {
  usedNonce: {
    create: jest.fn(({ data }: { data: { jti: string } }) => {
      if (spent.has(data.jti)) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`jti`)',
            { code: 'P2002', clientVersion: 'test', meta: { target: ['jti'] } },
          ),
        );
      }
      spent.set(data.jti, data);
      return Promise.resolve(data);
    }),
  },
} as unknown as PrismaService;

const confirmations = new ConfirmationService(jwt, prisma);
const assistant = new AssistantServer(confirmations, {
  get: jest.fn(),
} as unknown as ModuleRef);

/** What each test tool actually wrote. Empty means nothing reached a database. */
let written: Array<{ tool: string; input: unknown }>;

const widgetShape = {
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  cycle: z.object({ code: z.string(), route: z.string() }).optional(),
};

/** A write tool whose service refuses or fails on request, by name. */
function registerTestTools(server: McpServer, u: AssistantUser) {
  const ctx = assistant.contextFor(u);
  for (const tool of ['record_widget', 'record_gadget']) {
    writeTool(
      server,
      ctx,
      tool,
      {
        title: tool,
        description: 'test only',
        inputSchema: widgetShape,
      },
      {
        preview: (input) => {
          if (input.name === 'short') {
            return Promise.reject(
              badRequest('NOT_ENOUGH_STOCK', 'Only 2 of Widget is in stock.', {
                available: 2,
                product: 'Widget',
              }),
            );
          }
          return Promise.resolve({
            summary: `${input.quantity} × ${input.name}`,
            data: { quantity: input.quantity },
          });
        },
        commit: (input) => {
          if (input.name === 'taken') {
            return Promise.reject(
              conflict('DUPLICATE_SUPPLIER_INVOICE', 'Already recorded.'),
            );
          }
          if (input.name === 'crash') {
            return Promise.reject(
              new Error('connect ECONNREFUSED 10.0.0.7:5432 — db password xyz'),
            );
          }
          written.push({ tool, input });
          return Promise.resolve({
            summary: `Recorded ${input.name}`,
            data: { id: 'w1' },
          });
        },
      },
    );
  }
}

/** A Claude-shaped client, connected to the server a request from `u` gets. */
async function clientFor(u: AssistantUser): Promise<Client> {
  const server = assistant.create(u);
  registerTestTools(server, u);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const structured = (r: CallToolResult) =>
  r.structuredContent as {
    status?: string;
    confirmationToken?: string;
    error?: { code: string; message: string; params?: unknown };
  };

const codeOf = (r: CallToolResult) => structured(r).error?.code;

async function previewToken(
  client: Client,
  args: Record<string, unknown>,
  tool = 'record_widget',
): Promise<string> {
  const r = await call(client, tool, args);
  expect(r.isError).toBeFalsy();
  return structured(r).confirmationToken!;
}

const WIDGET = { name: 'Brake pad', quantity: 2 };

let a: Client;
let b: Client;

beforeEach(async () => {
  spent = new Map();
  written = [];
  jest.restoreAllMocks();
  a = await clientFor(partnerA);
  b = await clientFor(partnerB);
});

afterEach(async () => {
  await a.close();
  await b.close();
});

describe('A write tool through the confirmation pattern', () => {
  it('write tool without a token returns a preview and writes nothing', async () => {
    const r = await call(a, 'record_widget', WIDGET);

    expect(r.isError).toBeFalsy();
    expect(structured(r).status).toBe('preview');
    expect(structured(r).confirmationToken).toEqual(expect.any(String));
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('2 × Brake pad');
    expect(text).toContain('Nothing has been saved');
    expect(written).toEqual([]);
    expect(spent.size).toBe(0);
  });

  it('with a valid token commits once', async () => {
    const token = await previewToken(a, WIDGET);

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(r.isError).toBeFalsy();
    expect(structured(r).status).toBe('committed');
    expect(written).toEqual([{ tool: 'record_widget', input: WIDGET }]);
    expect(spent.size).toBe(1);
  });

  it('the same token twice is CONFIRMATION_USED', async () => {
    const token = await previewToken(a, WIDGET);
    await call(a, 'record_widget', { ...WIDGET, confirmationToken: token });

    const again = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(again.isError).toBe(true);
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(written).toHaveLength(1);
  });

  it('the same token twice at once commits only once', async () => {
    const token = await previewToken(a, WIDGET);

    const results = await Promise.all([
      call(a, 'record_widget', { ...WIDGET, confirmationToken: token }),
      call(a, 'record_widget', { ...WIDGET, confirmationToken: token }),
    ]);

    expect(results.map(codeOf).sort()).toEqual([
      'CONFIRMATION_USED',
      undefined,
    ]);
    expect(written).toHaveLength(1);
  });

  it('a token from a different tool is CONFIRMATION_MISMATCH', async () => {
    const token = await previewToken(a, WIDGET, 'record_gadget');

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(written).toEqual([]);
  });

  it('the token with one input changed is CONFIRMATION_MISMATCH, and the preview still commits', async () => {
    const token = await previewToken(a, WIDGET);

    const changed = await call(a, 'record_widget', {
      ...WIDGET,
      quantity: 3,
      confirmationToken: token,
    });
    expect(changed.isError).toBe(true);
    expect(codeOf(changed)).toBe('CONFIRMATION_MISMATCH');
    expect(written).toEqual([]);

    // The refusal did not spend it: what was previewed can still be confirmed.
    const same = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });
    expect(same.isError).toBeFalsy();
    expect(written).toEqual([{ tool: 'record_widget', input: WIDGET }]);
  });

  it('a field added after the preview is CONFIRMATION_MISMATCH', async () => {
    const token = await previewToken(a, WIDGET);

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      cycle: { code: 'CY-2', route: 'CN-UAE-EG' },
      confirmationToken: token,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(written).toEqual([]);
  });

  it("partner A's token presented by partner B is CONFIRMATION_MISMATCH", async () => {
    const token = await previewToken(a, WIDGET);

    const r = await call(b, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(written).toEqual([]);
  });

  it('a token older than 15 minutes is CONFIRMATION_EXPIRED', async () => {
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(issuedAt);
    const token = await previewToken(a, WIDGET);

    clock.mockReturnValue(issuedAt + (CONFIRMATION_TTL_SECONDS + 1) * 1000);
    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_EXPIRED');
    expect(written).toEqual([]);
  });

  it('a token just under 15 minutes old still commits', async () => {
    // The other side of the line: an expiry that refused everything would
    // pass the test above.
    const issuedAt = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(issuedAt);
    const token = await previewToken(a, WIDGET);

    clock.mockReturnValue(issuedAt + (CONFIRMATION_TTL_SECONDS - 5) * 1000);
    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: token,
    });

    expect(r.isError).toBeFalsy();
    expect(written).toHaveLength(1);
  });

  it('the input with its keys in another order still matches', async () => {
    const token = await previewToken(a, {
      name: 'Chain',
      quantity: 1,
      cycle: { code: 'CY-1', route: 'CN-EG' },
    });

    const r = await call(a, 'record_widget', {
      confirmationToken: token,
      cycle: { route: 'CN-EG', code: 'CY-1' },
      quantity: 1,
      name: 'Chain',
    });

    expect(r.isError).toBeFalsy();
    expect(written).toHaveLength(1);
  });

  it('a tampered token is CONFIRMATION_INVALID', async () => {
    const token = await previewToken(a, WIDGET);
    const [head, , signature] = token.split('.');
    // Re-point the claims at a different input, keeping the old signature.
    const claims = jwt.decode<Record<string, unknown>>(token);
    const forgedBody = Buffer.from(
      JSON.stringify({ ...claims, input: 'someone-elses-hash' }),
    ).toString('base64url');

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: `${head}.${forgedBody}.${signature}`,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_INVALID');
    expect(written).toEqual([]);
  });

  it('an unsigned token is CONFIRMATION_INVALID', async () => {
    const token = await previewToken(a, WIDGET);
    const claims = jwt.decode<Record<string, unknown>>(token);
    const b64 = (v: object) =>
      Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: unsigned,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_INVALID');
    expect(written).toEqual([]);
  });

  it('a token signed with another secret is CONFIRMATION_INVALID', async () => {
    const token = await previewToken(a, WIDGET);
    const claims = jwt.decode<Record<string, unknown>>(token);
    const forged = new JwtService({
      secret: 'not-the-secret-not-the-secret-not-the-secret',
    }).sign(claims);

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: forged,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_INVALID');
  });

  it("the partner's own access token is not a confirmation", async () => {
    const access = jwt.sign(
      { sub: partnerA.id },
      { audience: 'mcp', expiresIn: '1h' },
    );

    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: access,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_INVALID');
    expect(written).toEqual([]);
  });

  it('a made-up token is CONFIRMATION_INVALID', async () => {
    const r = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: 'yes',
    });

    expect(codeOf(r)).toBe('CONFIRMATION_INVALID');
    expect(written).toEqual([]);
  });

  it('a service refusal is a tool error with the code, not a 500', async () => {
    const r = await call(a, 'record_widget', { name: 'short', quantity: 5 });

    expect(r.isError).toBe(true);
    expect(structured(r).error).toEqual({
      code: 'NOT_ENOUGH_STOCK',
      message: 'Only 2 of Widget is in stock.',
      params: { available: 2, product: 'Widget' },
    });
    expect((r.content[0] as { text: string }).text).toBe(
      'NOT_ENOUGH_STOCK: Only 2 of Widget is in stock.',
    );
    // A refused preview hands out no token to confirm it with.
    expect(structured(r).confirmationToken).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('a service refusal at commit is a tool error with the code', async () => {
    const token = await previewToken(a, { name: 'taken', quantity: 1 });

    const r = await call(a, 'record_widget', {
      name: 'taken',
      quantity: 1,
      confirmationToken: token,
    });

    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('DUPLICATE_SUPPLIER_INVOICE');
  });

  it('an unexpected failure is a tool error that leaks nothing', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const token = await previewToken(a, { name: 'crash', quantity: 1 });

    const r = await call(a, 'record_widget', {
      name: 'crash',
      quantity: 1,
      confirmationToken: token,
    });

    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|password/);
    // Hidden from the model, not from whoever reads the logs.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('ECONNREFUSED'),
      expect.any(String),
    );
  });

  it("input that fails the tool's schema is a tool error, not a crash", async () => {
    const bad = await call(a, 'record_widget', {
      name: 'Brake pad',
      quantity: -1,
    });
    expect(bad.isError).toBe(true);

    const missing = await call(a, 'record_widget', { quantity: 'two' });
    expect(missing.isError).toBe(true);

    // The server is still answering afterwards.
    const ok = await call(a, 'record_widget', WIDGET);
    expect(ok.isError).toBeFalsy();
    expect(written).toEqual([]);
  });

  it('a zero or empty input is refused by the schema before any preview', async () => {
    const zero = await call(a, 'record_widget', { name: 'Chain', quantity: 0 });
    const empty = await call(a, 'record_widget', { name: '', quantity: 1 });
    const emptyToken = await call(a, 'record_widget', {
      ...WIDGET,
      confirmationToken: '',
    });

    expect([zero, empty, emptyToken].map((r) => r.isError)).toEqual([
      true,
      true,
      true,
    ]);
    expect(written).toEqual([]);
  });
});

describe('The token itself', () => {
  it('carries its own audience, the partner, the tool and a 15-minute life', () => {
    const { token } = confirmations.issue(partnerA.id, 'record_widget', WIDGET);
    const claims = jwt.decode<Record<string, unknown>>(token);

    expect(claims.aud).toBe(CONFIRMATION_AUDIENCE);
    expect(claims.sub).toBe(partnerA.id);
    expect(claims.tool).toBe('record_widget');
    expect(claims.jti).toEqual(expect.any(String));
    expect((claims.exp as number) - (claims.iat as number)).toBe(
      CONFIRMATION_TTL_SECONDS,
    );
  });

  it('matches the same input with its keys in another order, at every depth', async () => {
    // Through MCP the SDK re-parses arguments in schema order, which hides
    // this; the helper must not depend on that, so it is checked directly.
    const { token } = confirmations.issue(partnerA.id, 'record_widget', {
      name: 'Chain',
      lines: [{ qty: 1, sku: 'C-1' }],
      cycle: { code: 'CY-1', route: 'CN-EG' },
    });

    await expect(
      confirmations.redeem(token, partnerA.id, 'record_widget', {
        cycle: { route: 'CN-EG', code: 'CY-1' },
        lines: [{ sku: 'C-1', qty: 1 }],
        name: 'Chain',
        note: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not treat reordered lines as the same input', async () => {
    const { token } = confirmations.issue(partnerA.id, 'record_widget', {
      lines: [{ sku: 'A' }, { sku: 'B' }],
    });

    await expect(
      confirmations.redeem(token, partnerA.id, 'record_widget', {
        lines: [{ sku: 'B' }, { sku: 'A' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_MISMATCH' },
    });
  });

  it('is spent with kind confirmation and its own expiry', async () => {
    const { token } = confirmations.issue(partnerA.id, 'record_widget', WIDGET);
    const claims = jwt.decode<{ jti: string; exp: number }>(token);

    await confirmations.redeem(token, partnerA.id, 'record_widget', WIDGET);

    expect(spent.get(claims.jti)).toEqual({
      jti: claims.jti,
      kind: 'confirmation',
      expiresAt: new Date(claims.exp * 1000),
    });
  });
});
