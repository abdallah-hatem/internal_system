import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { badRequest, forbidden } from '../../../common/api-error';
import { businessToday, startOfBusinessDay } from '../../../common/dates';
import { AssistantServer } from '../assistant-server';
import type { AssistantUser } from '../tool-kit';
import { SAMPLES_AT_SHOP_NOTE, type ShopSamples } from '../tools/sales';
import {
  AiProvider,
  portableSchema,
  type ChatMessage,
  type ToolSpec,
} from './ai-provider';

/**
 * The office app's chat (owner 2026-10-20, built 2026-10-25): the assistant's
 * own tools — the same services, roles and preview/confirm as the MCP surface
 * (BUSINESS_LOGIC §16) — driven by a model the owner picks in the API's
 * environment (`ai-provider.ts`).
 *
 * The tools run in this process through the MCP client, so nothing about a
 * tool is copied here. One rule is added: **the model can only ask for a
 * preview.** A token it sends is dropped, and the preview it gets back says
 * the partner is shown a Confirm button. Only `confirm`, called by the
 * button, commits — with the token the preview issued for this partner.
 *
 * Nothing of the conversation is stored: the browser holds it and sends the
 * recent part each time. The audit log records each question's tools, which
 * is also how the day's allowance is counted across serverless instances.
 */

export const CHAT_AUDIT_ACTION = 'ASSISTANT_CHAT';

/** A request's history is trimmed to this, newest kept (input-token budget). */
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 16_000;
/** One question, at most. */
const QUESTION_CHARS = 2_000;
/** A tool's answer handed to the model, at most. */
const TOOL_RESULT_CHARS = 6_000;
/** Model turns for one question: tool calls and the answer. */
const MAX_STEPS = 6;

/**
 * The chat's own instructions, short on purpose: every question sends them
 * with every tool, and a free tier's minute allowance is small (Groq's: 8,000
 * tokens). The MCP surface keeps the long ones (`instructions.ts`); the rules
 * a tool needs are in its own description, which is sent too.
 */
const CHAT_INSTRUCTIONS = `You are the assistant inside S&F's office app — a motorcycle-parts importer in Egypt — talking to one of its three core partners.
- Answer in the language of their last message (Arabic or English), briefly: a few sentences or a short list. Money as "1,234.00 EGP".
- Never invent a figure, name or status; read it with a tool first. If a tool returns questions (a close name, an unknown customer, a missing price), ask exactly those; a close name is never the same thing until the partner says so.
- Changes (a sale, a payment, samples, a purchase order, a delivery, stock received…): call the tool WITHOUT confirmationToken. The app shows the partner the preview with Confirm and Cancel buttons and saves it only when they press Confirm. Never call a tool again to confirm, never ask for a token, never say a change is saved.
- A sale to a shop on file is owed; to anyone else it is a walk-in sale. Never create a customer. If no price was given, say the preview uses the list price and ask them to confirm it.
- A refusal starts with a code in capitals: explain it plainly and say what they can do; do not retry it unchanged.`;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  token: string;
  expiresAt: string | null;
  summary: string;
  /**
   * What the shop already holds as samples (§4, owner 2026-10-25): the
   * record_sale preview's note, which the app shows as its own translated
   * hint with a link to "They're buying". Empty for anything else.
   */
  samplesAtShop: ShopSamples;
}

@Injectable()
export class AssistantChatService {
  constructor(
    private readonly ai: AiProvider,
    private readonly assistant: AssistantServer,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** The day's allowance, shared by the partners (owner: 100 a day). */
  private dailyLimit(): number {
    const n = Number(this.config.get<string>('AI_DAILY_LIMIT'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
  }

  private usedToday() {
    return this.prisma.auditLog.count({
      where: {
        action: CHAT_AUDIT_ACTION,
        occurredAt: { gte: startOfBusinessDay(businessToday()) },
      },
    });
  }

  async currentStatus() {
    const settings = this.ai.settings();
    return {
      data: {
        configured: !!settings,
        provider: settings?.provider ?? null,
        model: settings?.model ?? null,
        used: await this.usedToday(),
        limit: this.dailyLimit(),
      },
    };
  }

  async chat(userId: string, body: { messages?: unknown }) {
    const settings = this.ai.settings();
    if (!settings) {
      throw badRequest(
        'AI_NOT_CONFIGURED',
        'The chat is not set up yet: the API has no AI key.',
      );
    }
    const turns = cleanTurns(body.messages);
    const question = turns[turns.length - 1];
    if (!question || question.role !== 'user' || !question.content.trim()) {
      throw badRequest('AI_EMPTY_QUESTION', 'Ask something first.');
    }
    if (question.content.length > QUESTION_CHARS) {
      throw badRequest(
        'AI_QUESTION_TOO_LONG',
        `A question can be at most ${QUESTION_CHARS} characters.`,
        { max: QUESTION_CHARS },
      );
    }
    const limit = this.dailyLimit();
    if ((await this.usedToday()) >= limit) {
      throw new HttpException(
        {
          code: 'AI_DAILY_LIMIT',
          message: `Today's ${limit} chat messages are used up. The chat opens again tomorrow.`,
          params: { limit },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.partner(userId);
    const session = await this.connect(user);
    const toolsUsed: string[] = [];
    const pending: PendingAction[] = [];
    try {
      const { tools, writes } = await this.toolSpecs(session.client);
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `${CHAT_INSTRUCTIONS}\nToday is ${businessToday()} (Cairo).`,
        },
        ...trimHistory(turns),
      ];

      let reply: string | null = null;
      for (let step = 0; step < MAX_STEPS && reply === null; step++) {
        const turn = await this.ai.complete(settings, messages, tools);
        if (!turn.tool_calls?.length) {
          reply = turn.content?.trim() || '';
          break;
        }
        messages.push(turn);
        for (const call of turn.tool_calls) {
          const name = call.function.name;
          toolsUsed.push(name);
          const args = parseArgs(call.function.arguments);
          // The model may only preview: a token it sends is not its to use.
          delete args.confirmationToken;
          const result = await session.client.callTool({
            name,
            arguments: args,
          });
          const text = textOf(result.content);
          const structured = result.structuredContent as
            | {
                status?: string;
                confirmationToken?: string;
                expiresAt?: string;
                data?: { samplesAtShop?: ShopSamples } | null;
              }
            | undefined;
          let forModel = text;
          if (
            writes.has(name) &&
            structured?.status === 'preview' &&
            structured.confirmationToken
          ) {
            const summary = text.split('\n\nNothing has been saved yet.')[0];
            const samplesAtShop = structured.data?.samplesAtShop ?? [];
            pending.push({
              tool: name,
              args,
              token: structured.confirmationToken,
              expiresAt: structured.expiresAt ?? null,
              // The samples note is shown as the app's own hint, in the
              // reader's language; the model still reads it in full below.
              summary: samplesAtShop.length
                ? summary.split(`\n\n${SAMPLES_AT_SHOP_NOTE}`)[0]
                : summary,
              samplesAtShop,
            });
            forModel =
              `${summary}\n\nThis preview is now shown to the partner with Confirm and Cancel buttons; ` +
              'it is saved only if they press Confirm. Do not call this tool again for it. ' +
              'Tell them briefly what will happen and that they can press Confirm.';
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: forModel.slice(0, TOOL_RESULT_CHARS),
          });
        }
      }

      await this.audit.log({
        actorUserId: userId,
        action: CHAT_AUDIT_ACTION,
        entityType: 'AssistantChat',
        entityId: userId,
        afterJson: {
          provider: settings.provider,
          model: settings.model,
          tools: toolsUsed,
          previewed: pending.map((p) => p.tool),
        },
      });

      return {
        data: {
          reply:
            reply ??
            'That needed more steps than one question allows. Ask it in smaller parts.',
          pending,
          toolsUsed,
        },
      };
    } finally {
      await session.close();
    }
  }

  /**
   * The Confirm button: commits a preview the model asked for, with the token
   * that preview issued to this partner for exactly these arguments. The
   * confirmation service refuses anything else (another partner, other
   * arguments, a used or lapsed token). No model is called.
   */
  async confirm(
    userId: string,
    body: { tool?: unknown; args?: unknown; token?: unknown },
  ) {
    if (
      typeof body.tool !== 'string' ||
      typeof body.token !== 'string' ||
      !body.args ||
      typeof body.args !== 'object' ||
      Array.isArray(body.args)
    ) {
      throw badRequest('AI_CONFIRM_INVALID', 'Nothing to confirm.');
    }
    const user = await this.partner(userId);
    const session = await this.connect(user);
    try {
      const { writes } = await this.toolSpecs(session.client);
      if (!writes.has(body.tool)) {
        throw badRequest('AI_CONFIRM_INVALID', 'Nothing to confirm.');
      }
      const result = await session.client.callTool({
        name: body.tool,
        arguments: {
          ...(body.args as Record<string, unknown>),
          confirmationToken: body.token,
        },
      });
      return {
        data: {
          ok: !result.isError,
          summary: textOf(result.content),
        },
      };
    } finally {
      await session.close();
    }
  }

  /** The partner, as the tools expect them — a core partner, now. */
  private async partner(userId: string): Promise<AssistantUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { partner: true },
    });
    if (!user || user.role !== 'CORE_PARTNER' || user.status !== 'ACTIVE') {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Only core partners can use the chat.',
      );
    }
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      partner: user.partner,
    };
  }

  private async connect(user: AssistantUser) {
    const server: McpServer = this.assistant.create(user);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'office-chat', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  /** Every tool, its token field hidden from the model; the write tools named. */
  private async toolSpecs(client: Client) {
    const { tools } = await client.listTools();
    const writes = new Set<string>();
    const specs: ToolSpec[] = tools.map((t) => {
      const schema = (t.inputSchema ?? { type: 'object' }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const properties = { ...(schema.properties ?? {}) };
      if ('confirmationToken' in properties) {
        writes.add(t.name);
        delete properties.confirmationToken;
      }
      return {
        type: 'function',
        function: {
          name: t.name,
          description: briefly(t.description ?? t.title ?? t.name, 280),
          parameters: portableSchema(
            {
              ...schema,
              properties,
              required: (schema.required ?? []).filter(
                (r) => r !== 'confirmationToken',
              ),
            },
            120,
          ),
        },
      };
    });
    return { tools: specs, writes };
  }
}

/** The browser's turns, checked: only user and assistant text. */
export function cleanTurns(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is ChatTurn =>
        !!m &&
        typeof m === 'object' &&
        ((m as ChatTurn).role === 'user' ||
          (m as ChatTurn).role === 'assistant') &&
        typeof (m as ChatTurn).content === 'string',
    )
    .map((m) => ({ role: m.role, content: m.content }));
}

/** The newest turns that fit the budget, each cut to a fair share, never starting on a reply. */
export function trimHistory(turns: ChatTurn[]): ChatMessage[] {
  const kept: ChatTurn[] = [];
  let chars = 0;
  for (
    let i = turns.length - 1;
    i >= 0 && kept.length < HISTORY_MESSAGES;
    i--
  ) {
    const content = turns[i].content.slice(0, 4_000);
    if (chars + content.length > HISTORY_CHARS && kept.length > 0) break;
    chars += content.length;
    kept.unshift({ role: turns[i].role, content });
  }
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

/** The first sentences of a description, within `max` characters — the rest stays on the MCP surface. */
export function briefly(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = cut.lastIndexOf('. ');
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1)}…`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: string; text?: string }) =>
      c?.type === 'text' ? (c.text ?? '') : '',
    )
    .filter(Boolean)
    .join('\n');
}
