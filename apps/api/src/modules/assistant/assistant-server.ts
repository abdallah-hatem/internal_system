import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ConfirmationService } from './confirmation.service';
import { ASSISTANT_INSTRUCTIONS } from './instructions';
import type { AssistantContext, AssistantUser } from './tool-kit';
import { registerReadTools } from './tools/read';
import { registerReceiptTools } from './tools/receipt';
import { registerCycleTools } from './tools/cycle';

export const ASSISTANT_SERVER_NAME = 'motoparts';

/**
 * One MCP server per request, carrying the partner who made it.
 *
 * Stateless: no session id, nothing kept between requests. On serverless each
 * request may land on a different instance, so a session held in memory would
 * be a session lost; and building the server fresh means a tool can never
 * see another partner's context.
 */
@Injectable()
export class AssistantServer {
  private readonly logger = new Logger('Assistant');

  constructor(
    private readonly confirmations: ConfirmationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  create(user: AssistantUser): McpServer {
    const server = new McpServer(
      { name: ASSISTANT_SERVER_NAME, version: '1.0.0' },
      { instructions: ASSISTANT_INSTRUCTIONS },
    );
    const ctx = this.contextFor(user);
    registerReadTools(server, ctx);
    registerReceiptTools(server, ctx);
    registerCycleTools(server, ctx);
    return server;
  }

  contextFor(user: AssistantUser): AssistantContext {
    return {
      user,
      confirmations: this.confirmations,
      resolve: (type) => this.moduleRef.get(type, { strict: false }),
    };
  }

  /** Answers one HTTP request to `/mcp`. The transport writes the response. */
  async serve(
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
    user: AssistantUser,
  ): Promise<void> {
    if (req.method === 'GET') {
      // A GET opens the server's event stream. A stateless server has nothing
      // to push, and held open on serverless it would only run to the time
      // limit. The protocol's answer for "no stream here" is 405.
      res
        .writeHead(405, {
          Allow: 'POST, DELETE',
          'Content-Type': 'application/json',
        })
        .end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed.' },
            id: null,
          }),
        );
      return;
    }

    const server = this.create(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // One JSON answer per POST rather than an event stream: every tool
      // here answers once, and a plain response is what serverless does well.
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      this.logger.error(
        `mcp request failed — ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
  }
}
