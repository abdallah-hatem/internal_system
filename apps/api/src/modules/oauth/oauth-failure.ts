import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

/**
 * How the OAuth door says no.
 *
 * Not through `api-error`. That shape — `{ error: { code, message } }` — is for
 * the office app, which translates the code. The callers here are Claude's
 * OAuth client, which parses RFC 6749's `{ error: "invalid_grant" }` and
 * nothing else, and a browser showing the sign-in page, which needs HTML.
 * The protocol decides the shape; these are not user-facing refusals.
 */
export type OAuthReply =
  /** RFC 6749 §5.2 / RFC 7591 §3.2.2 — for the client, never a person. */
  | { kind: 'json'; status: number; body: Record<string, string> }
  /** The sign-in page again, or a page saying the request cannot be served. */
  | { kind: 'html'; status: number; html: string }
  /** An error sent back to a redirect URI that has already been verified. */
  | { kind: 'redirect'; url: string };

export class OAuthFailure extends Error {
  constructor(readonly reply: OAuthReply) {
    super(
      reply.kind === 'json'
        ? `${reply.body.error}: ${reply.body.error_description ?? ''}`
        : `oauth ${reply.kind}`,
    );
  }
}

/** RFC 6749 §5.2: 400, or 401 for a client that cannot be identified. */
export function protocolError(
  error: string,
  description: string,
  status = 400,
): OAuthFailure {
  return new OAuthFailure({
    kind: 'json',
    status,
    body: { error, error_description: description },
  });
}

/**
 * Writes an `OAuthFailure` as its protocol requires. Scoped to the OAuth
 * controllers; anything else they throw still reaches the global filter.
 */
@Catch(OAuthFailure)
export class OAuthFailureFilter implements ExceptionFilter {
  catch(failure: OAuthFailure, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { reply } = failure;
    if (reply.kind === 'redirect') {
      res.redirect(302, reply.url);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (reply.kind === 'json') {
      res.status(reply.status).json(reply.body);
      return;
    }
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.status(reply.status).type('html').send(reply.html);
  }
}
