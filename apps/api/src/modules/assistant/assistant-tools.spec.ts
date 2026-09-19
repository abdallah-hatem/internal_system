import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PrismaService } from '../../prisma/prisma.service';
import { AssistantServer } from './assistant-server';
import { ConfirmationService } from './confirmation.service';
import { readTool, writeTool, type AssistantUser } from './tool-kit';

/**
 * BUSINESS_LOGIC §16 — the receipt image is not kept.
 *
 * Two ways that could stop being true: a tool that accepts the image (a
 * base64 field, a file, an attachment), or a tool that writes a stored file.
 * This walks every tool the production server registers, so a tool added by a
 * later task is checked without anyone remembering to add it here.
 */

const partner: AssistantUser = {
  id: 'partner-a',
  email: 'a@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

const assistant = new AssistantServer(
  new ConfirmationService(
    new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
    {} as PrismaService,
  ),
  { get: jest.fn() } as unknown as ModuleRef,
);

async function toolsOf(server: McpServer): Promise<Tool[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    // A server with no tools registered does not offer the capability at all.
    if (!client.getServerCapabilities()?.tools) return [];
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

const FILE_NAMES =
  /image|photo|picture|file|attachment|upload|base64|blob|bytes|binary|pdf/i;
const FILE_FORMATS = /^(binary|byte|base64|data-url)$/i;

/** Every place a schema would take file or image content, as a path. */
function fileInputs(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];

  if (node.contentEncoding || node.contentMediaType) found.push(path);
  if (typeof node.format === 'string' && FILE_FORMATS.test(node.format)) {
    found.push(path);
  }

  const props = node.properties as Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(props ?? {})) {
    if (FILE_NAMES.test(key)) found.push(`${path}.${key}`);
    found.push(...fileInputs(child, `${path}.${key}`));
  }
  for (const key of ['items', 'additionalProperties', 'not']) {
    found.push(...fileInputs(node[key], `${path}[${key}]`));
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const list = node[key];
    if (Array.isArray(list)) {
      list.forEach((s, i) =>
        found.push(...fileInputs(s, `${path}.${key}[${i}]`)),
      );
    }
  }
  return found;
}

describe('No assistant tool keeps the receipt image', () => {
  it("no tool's input schema accepts file or image content", async () => {
    const tools = await toolsOf(assistant.create(partner));

    const offending = tools.flatMap((t) =>
      fileInputs(t.inputSchema).map((p) => `${t.name} ${p}`),
    );
    expect(offending).toEqual([]);
  });

  it('the check finds an image field when one is there', async () => {
    // Without this the test above would pass on a walker that looks at nothing
    // — and today, before the tool tasks land, there is nothing to look at.
    const server = assistant.create(partner);
    const ctx = assistant.contextFor(partner);
    readTool(
      server,
      'read_receipt',
      {
        title: 'x',
        description: 'x',
        inputSchema: {
          supplier: z.string(),
          photo: z.string(),
          pages: z.array(z.object({ content: z.base64() })),
        },
      },
      () => Promise.resolve({ summary: '' }),
    );
    writeTool(
      server,
      ctx,
      'save_receipt',
      {
        title: 'x',
        description: 'x',
        inputSchema: { scan: z.object({ data: z.base64() }).optional() },
      },
      {
        preview: () => Promise.resolve({ summary: '' }),
        commit: () => Promise.resolve({ summary: '' }),
      },
    );

    const tools = await toolsOf(server);
    const offending = tools.flatMap((t) =>
      fileInputs(t.inputSchema).map((p) => `${t.name} ${p}`),
    );

    expect(offending).toEqual(
      expect.arrayContaining([
        'read_receipt $.photo',
        expect.stringMatching(/^read_receipt \$\.pages\[items\]\.content/),
        expect.stringMatching(/^save_receipt \$\.scan\.data/),
      ]),
    );
  });

  it('no assistant tool writes a stored file', () => {
    // The only ways this API stores a file: the files module and Vercel Blob.
    // Nothing the assistant ships may reach for either, or for the disk.
    const STORES =
      /@vercel\/blob|modules\/files|files\.service|FilesService|writeFile|createWriteStream/;
    const source = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return source(p);
        return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
      });

    const files = source(__dirname);
    expect(files.length).toBeGreaterThan(5);
    const offending = files.filter((f) => STORES.test(readFileSync(f, 'utf8')));
    expect(offending).toEqual([]);
  });
});

describe('Tool annotations', () => {
  it('a write tool is marked as neither read-only nor destructive, so clients ask first', async () => {
    const server = assistant.create(partner);
    writeTool(
      server,
      assistant.contextFor(partner),
      'record_widget',
      { title: 'x', description: 'x', inputSchema: { name: z.string() } },
      {
        preview: () => Promise.resolve({ summary: '' }),
        commit: () => Promise.resolve({ summary: '' }),
      },
    );
    readTool(
      server,
      'find_widgets',
      { title: 'x', description: 'x', inputSchema: {} },
      () => Promise.resolve({ summary: '' }),
    );

    const tools = await toolsOf(server);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.record_widget.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName.record_widget.inputSchema.properties).toHaveProperty(
      'confirmationToken',
    );
    expect(byName.record_widget.inputSchema.required ?? []).not.toContain(
      'confirmationToken',
    );
    expect(byName.find_widgets.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });
});
