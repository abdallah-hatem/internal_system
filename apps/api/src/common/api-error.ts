import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Refusals the client can translate.
 *
 * Every message the API throws was an English sentence, so an Arabic screen
 * showed an Arabic form, an Arabic toast title, and an English explanation of
 * what went wrong — which is the half that actually matters.
 *
 * The API does not translate. It has no reliable idea what language the reader
 * wants (Accept-Language is the browser's setting, not the one chosen in the
 * app), and the web app already carries a full translation layer and knows the
 * locale for certain because it is in the URL. So the API names the refusal and
 * the client says it.
 *
 * The English message stays on every throw. It is what the logs record, what
 * the tests read, and what any client that does not know a code falls back to —
 * a new refusal is then merely untranslated rather than blank.
 */

export interface ApiErrorBody {
  /** Stable, machine-readable. Never shown to anyone. */
  code: string;
  /** English. For logs, for tests, and as the client's fallback. */
  message: string;
  /** Values to interpolate into the translated message. */
  params?: Record<string, string | number>;
}

type Ctor = new (body: ApiErrorBody) => HttpException;

const build =
  (Exception: Ctor) =>
  (code: string, message: string, params?: Record<string, string | number>) =>
    new Exception({ code, message, ...(params ? { params } : {}) });

export const badRequest = build(BadRequestException as unknown as Ctor);
export const conflict = build(ConflictException as unknown as Ctor);
export const forbidden = build(ForbiddenException as unknown as Ctor);
export const unauthorized = build(UnauthorizedException as unknown as Ctor);

/**
 * The one that covers a third of them.
 *
 * Fifty-seven throws said nothing but "<something> not found", which is one
 * refusal with a different noun each time. `entity` is a translation key, not a
 * word, so the client can decline it properly rather than pasting an English
 * noun into an Arabic sentence.
 */
export function notFound(entity: string, english?: string) {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: english ?? `${englishNoun(entity)} not found`,
    params: { entity },
  });
}

/** `purchaseOrderItem` -> `Purchase order item`, for the English fallback. */
function englishNoun(key: string): string {
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
