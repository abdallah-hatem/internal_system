import { HttpException, Logger, type Type } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Partner, UserRole } from '@prisma/client';
import { z } from 'zod';

import type { ApiErrorBody } from '../../common/api-error';
import {
  CONFIRMATION_TTL_SECONDS,
  type ConfirmationService,
} from './confirmation.service';

/**
 * What every assistant tool is built from. The tool files (`tools/*.ts`) call
 * `readTool` and `writeTool` and nothing else from the SDK, so the rules below
 * — refusals keep their code, writes need a confirmed preview — cannot be
 * forgotten by a tool written later.
 */

/** The signed-in partner, as `SurfaceGuard` left them on the request. */
export interface AssistantUser {
  id: string;
  email: string;
  role: UserRole;
  partner: Partner | null;
}

/** Handed to every `register…Tools`: who is asking, and the services. */
export interface AssistantContext {
  user: AssistantUser;
  confirmations: ConfirmationService;
  /**
   * Any provider in the application — `ctx.resolve(PurchasesService)`. Tools
   * call the same services the office app's controllers call, so the assistant
   * is refused whatever the office app would be refused (CLAUDE.md rule 3).
   */
  resolve<T>(type: Type<T>): T;
}

/** What a tool's own code returns: a sentence for the partner, and the facts. */
export interface ToolOutcome {
  summary: string;
  data?: unknown;
}

type Shape = z.ZodRawShape;
type Input<S extends Shape> = z.output<z.ZodObject<S>>;

interface ToolConfig<S extends Shape> {
  title: string;
  description: string;
  inputSchema: S;
}

const logger = new Logger('Assistant');

/**
 * A refusal the model can act on.
 *
 * A service throws the same `{ code, message, params }` it throws at the office
 * app. Left to the SDK, that would reach the model as Nest's bare message with
 * the code gone; an unexpected error would reach it with Prisma's internals in
 * the text. Both become an ordinary tool error here — never a transport crash,
 * never a 500 — carrying the code and the English message.
 */
export function refusalResult(err: unknown): CallToolResult {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    const body: ApiErrorBody =
      typeof res === 'object' && res !== null && 'code' in res
        ? (res as ApiErrorBody)
        : {
            code: 'ERROR',
            message: typeof res === 'string' ? res : err.message,
          };
    return {
      isError: true,
      content: [{ type: 'text', text: `${body.code}: ${body.message}` }],
      structuredContent: {
        error: {
          code: body.code,
          message: body.message,
          ...(body.params ? { params: body.params } : {}),
        },
      },
    };
  }

  logger.error(
    `tool failed — ${err instanceof Error ? err.message : String(err)}`,
    err instanceof Error ? err.stack : undefined,
  );
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: 'INTERNAL_SERVER_ERROR: An unexpected error occurred',
      },
    ],
    structuredContent: {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      },
    },
  };
}

function outcomeResult(
  outcome: ToolOutcome,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    content: [{ type: 'text', text: outcome.summary }],
    structuredContent: { ...extra, data: outcome.data ?? null },
  };
}

/** A tool that only reads. Clients may run it without asking. */
export function readTool<S extends Shape>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  run: (input: Input<S>) => Promise<ToolOutcome>,
): void {
  // Widened on purpose: the SDK cannot infer a callback type through a generic
  // shape, so it is given the plain one and the callback narrows it back.
  const inputSchema: Shape = config.inputSchema;
  server.registerTool(
    name,
    {
      ...config,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // The SDK has already parsed the arguments against `inputSchema`, which is
    // S; it only loses that type through the widened shape above.
    async (args) => {
      try {
        return outcomeResult(await run(args as Input<S>));
      } catch (err) {
        return refusalResult(err);
      }
    },
  );
}

export interface WriteHandlers<S extends Shape> {
  /**
   * Validates exactly as the write will — the same service checks, the same
   * refusals — and writes nothing. Returns what the partner will be shown.
   */
  preview(input: Input<S>): Promise<ToolOutcome>;
  /** Makes the change. Runs only after a matching confirmation was spent. */
  commit(input: Input<S>): Promise<ToolOutcome>;
}

/**
 * A tool that changes something, in two calls.
 *
 * Without `confirmationToken` it previews and returns a token bound to this
 * partner, this tool and this exact input. With it, the token is spent and the
 * change is made — if and only if the input is the one previewed. The token is
 * not part of what is hashed; everything else the tool accepts is.
 */
export function writeTool<S extends Shape>(
  server: McpServer,
  ctx: AssistantContext,
  name: string,
  config: ToolConfig<S>,
  handlers: WriteHandlers<S>,
): void {
  const inputSchema: Shape = {
    ...config.inputSchema,
    confirmationToken: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Leave out to get a preview. After the partner confirms that preview, call again with the same arguments and the token it returned.',
      ),
  };

  server.registerTool(
    name,
    {
      ...config,
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    // Parsed by the SDK against `inputSchema` — S plus the optional token.
    async (args) => {
      const { confirmationToken, ...rest } = args as Input<S> & {
        confirmationToken?: string;
      };
      const input = rest as Input<S>;
      try {
        if (!confirmationToken) {
          const preview = await handlers.preview(input);
          const issued = ctx.confirmations.issue(ctx.user.id, name, input);
          return {
            content: [
              {
                type: 'text',
                text:
                  `${preview.summary}\n\n` +
                  'Nothing has been saved yet. Show this preview to the partner and ask them to confirm. ' +
                  `If they say yes, call ${name} again with exactly the same arguments and ` +
                  `confirmationToken "${issued.token}" — it works once, within ${CONFIRMATION_TTL_SECONDS / 60} minutes. ` +
                  `If they change anything, call ${name} without a token for a new preview.`,
              },
            ],
            structuredContent: {
              status: 'preview',
              confirmationToken: issued.token,
              expiresAt: issued.expiresAt,
              data: preview.data ?? null,
            },
          } satisfies CallToolResult;
        }

        await ctx.confirmations.redeem(
          confirmationToken,
          ctx.user.id,
          name,
          input,
        );
        return outcomeResult(await handlers.commit(input), {
          status: 'committed',
        });
      } catch (err) {
        return refusalResult(err);
      }
    },
  );
}
