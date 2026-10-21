import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { PrismaService } from '../../../prisma/prisma.service';
import { SALES_PARTNER_ROLES, SALES_ROLES } from '../../sales/sales-roles';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';

/**
 * The samples tools' roles (CLAUDE.md §12), without a database: a role the
 * office's sales endpoints refuse is refused before anything is read, so a
 * ModuleRef that hands out nothing proves no service was even asked.
 *
 * The full behaviour — previews, commits, every refusal — is
 * `samples.db.spec.ts`, against Postgres.
 */

const SAMPLE_TOOLS = [
  'leave_samples',
  'list_samples',
  'complete_samples_sale',
  'return_samples',
  'write_off_samples',
] as const;

const ARGS: Record<(typeof SAMPLE_TOOLS)[number], Record<string, unknown>> = {
  leave_samples: { customer: 'Delta Bikes', lines: [{ product: 'X', qty: 1 }] },
  list_samples: {},
  complete_samples_sale: { order: 'ORD-2026-00001' },
  return_samples: { order: 'ORD-2026-00001' },
  write_off_samples: { order: 'ORD-2026-00001' },
};

async function clientAs(role: UserRole) {
  const resolved: unknown[] = [];
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      {} as PrismaService,
    ),
    {
      get: (type: unknown) => {
        resolved.push(type);
        throw new Error('no service may be reached by a refused role');
      },
    } as unknown as ModuleRef,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await assistant
    .create({ id: 'u-1', email: 'u@motoparts.test', role, partner: null })
    .connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, resolved };
}

const codeOf = (r: CallToolResult) =>
  (r.structuredContent as { error?: { code: string } } | undefined)?.error
    ?.code;

describe("samples tools — roles are the office endpoints'", () => {
  it("the role lists are the sales controller's: sales roles, and core partners for a write-off", () => {
    expect([...SALES_ROLES]).toEqual(['CORE_PARTNER', 'ADMIN_SUPPORT']);
    expect([...SALES_PARTNER_ROLES]).toEqual(['CORE_PARTNER']);
  });

  it('every samples tool is registered', async () => {
    const { client } = await clientAs('CORE_PARTNER');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...SAMPLE_TOOLS]));
    await client.close();
  });

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'] as UserRole[])(
    '%s is refused every samples tool with ROLE_NOT_ALLOWED, before any service is reached',
    async (role) => {
      const { client, resolved } = await clientAs(role);
      for (const name of SAMPLE_TOOLS) {
        const r = (await client.callTool({
          name,
          arguments: ARGS[name],
        })) as CallToolResult;
        expect([name, codeOf(r)]).toEqual([name, 'ROLE_NOT_ALLOWED']);
      }
      expect(resolved).toEqual([]);
      await client.close();
    },
  );

  it('office support is refused only the write-off', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { client } = await clientAs('ADMIN_SUPPORT');
    const r = (await client.callTool({
      name: 'write_off_samples',
      arguments: ARGS.write_off_samples,
    })) as CallToolResult;
    expect(codeOf(r)).toBe('ROLE_NOT_ALLOWED');
    // Allowed past the role check: it reaches for a service (and the stub
    // refuses), which is the opposite of the refusal above.
    const left = (await client.callTool({
      name: 'return_samples',
      arguments: ARGS.return_samples,
    })) as CallToolResult;
    expect(codeOf(left)).toBe('INTERNAL_SERVER_ERROR');
    await client.close();
  });
});
