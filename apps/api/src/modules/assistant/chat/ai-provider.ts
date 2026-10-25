import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The chat's model, behind one door (owner 2026-10-25: Gemini to start, "maybe
 * later we can change the api key from env, Groq or any free one").
 *
 * Every provider listed speaks the same OpenAI-style chat-completions request
 * with function calling, so one adapter serves them all; switching is three
 * settings on the API's Vercel project, no code change:
 *
 *   AI_PROVIDER  gemini | groq | openai | openrouter   (or any, with AI_BASE_URL)
 *   AI_API_KEY   the provider's key
 *   AI_MODEL     optional; each provider has a default below
 *   AI_BASE_URL  optional; a provider not listed, OpenAI-compatible
 *
 * No key: the chat says it is not set up, and nothing is called.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

const PROVIDERS: Record<string, { baseUrl: string; model: string }> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    // Llama 3.3 was withdrawn on Groq by 2026-10-25; gpt-oss is its tool-capable model.
    model: 'openai/gpt-oss-120b',
  },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
  },
};

export interface ProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
  key: string;
}

/** One model call may wait this long; a serverless function has about a minute. */
const TIMEOUT_MS = 40_000;

@Injectable()
export class AiProvider {
  private readonly logger = new Logger('AssistantChat');

  constructor(private readonly config: ConfigService) {}

  /** What is set up, or null when there is no key — the chat is then "not set up". */
  settings(): ProviderSettings | null {
    const key = this.config.get<string>('AI_API_KEY')?.trim();
    if (!key) return null;
    const provider = (this.config.get<string>('AI_PROVIDER') ?? 'gemini')
      .trim()
      .toLowerCase();
    const known = PROVIDERS[provider];
    const baseUrl =
      this.config.get<string>('AI_BASE_URL')?.trim() || known?.baseUrl;
    if (!baseUrl) return null;
    const model =
      this.config.get<string>('AI_MODEL')?.trim() || known?.model || '';
    if (!model) return null;
    return { provider, model, baseUrl: baseUrl.replace(/\/+$/, ''), key };
  }

  /** One turn of the model: what it says, or the tools it wants called. */
  async complete(
    settings: ProviderSettings,
    messages: ChatMessage[],
    tools: ToolSpec[],
  ): Promise<Extract<ChatMessage, { role: 'assistant' }>> {
    let res: Response;
    try {
      res = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.key}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(
        `model call failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException({
        code: 'AI_PROVIDER_FAILED',
        message: 'The AI service did not answer. Try again in a moment.',
      });
    }
    if (res.status === 429) {
      throw new HttpException(
        {
          code: 'AI_PROVIDER_BUSY',
          message:
            'The AI service is busy or its free allowance is used up for now. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (res.status === 413) {
      // A free tier whose minute allowance is smaller than one question with
      // every tool (Groq's 8,000 tokens, 2026-10-25). Not a passing failure.
      this.logger.warn(`model call 413 — ${(await res.text()).slice(0, 300)}`);
      throw new HttpException(
        {
          code: 'AI_PROVIDER_TOO_SMALL',
          message:
            "This AI provider's allowance is too small for one question with the assistant's tools. Use a provider with a larger allowance (Gemini's free tier fits).",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!res.ok) {
      // The provider's own words go to the log, never to the partner: they
      // can name the key or the account.
      this.logger.warn(
        `model call ${res.status} — ${(await res.text()).slice(0, 500)}`,
      );
      throw new ServiceUnavailableException({
        code: 'AI_PROVIDER_FAILED',
        message: 'The AI service did not answer. Try again in a moment.',
        params: { status: res.status },
      });
    }
    const body = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: ToolCall[] };
      }[];
    };
    const message = body.choices?.[0]?.message;
    return {
      role: 'assistant',
      content: message?.content ?? null,
      ...(message?.tool_calls?.length
        ? { tool_calls: message.tool_calls }
        : {}),
    };
  }
}

/**
 * A tool's input schema in the subset every provider here accepts. Gemini's
 * function declarations take an OpenAPI subset and refuse the rest
 * (`$schema`, `additionalProperties`, `exclusiveMinimum`…), so only these keys
 * pass, at every depth.
 */
const KEEP = new Set([
  'type',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'format',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'nullable',
  'anyOf',
]);

export function portableSchema(
  schema: unknown,
  maxDescription = Infinity,
): unknown {
  if (Array.isArray(schema))
    return schema.map((s) => portableSchema(s, maxDescription));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>,
  )) {
    if (!KEEP.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          portableSchema(v, maxDescription),
        ]),
      );
    } else if (key === 'type' && Array.isArray(value)) {
      // ["string","null"] → "string", nullable
      const types = value.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (types.length < value.length) out.nullable = true;
    } else if (key === 'description' && typeof value === 'string') {
      // Every question carries every tool: a field's note stays short.
      out.description =
        value.length > maxDescription
          ? `${value.slice(0, maxDescription - 1)}…`
          : value;
    } else {
      out[key] = portableSchema(value, maxDescription);
    }
  }
  return out;
}
