import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from '../../prisma/unique-violation';
import { badRequest, conflict } from '../../common/api-error';
import { inputHash } from './canonical-input';

/**
 * Nothing the assistant writes is written without a confirmed preview
 * (BUSINESS_LOGIC §16). This is what makes "confirmed" mean something.
 *
 * A preview hands back a token that names who it was shown to, which tool, and
 * a hash of exactly what was shown. Committing presents it again, and is let
 * through only if all three still match, it is under fifteen minutes old, and
 * it has never been presented before. A changed quantity, a different cycle, a
 * token from another tool or another partner, or the same "yes" replayed, is
 * refused rather than trusted.
 *
 * The token's audience is its own. `SurfaceGuard` compares a bearer token's
 * audience to the route's surface, so a confirmation token presented as an
 * access token is refused everywhere, `/mcp` included.
 */
export const CONFIRMATION_AUDIENCE = 'mcp-confirmation';
export const CONFIRMATION_TTL_SECONDS = 15 * 60;

interface ConfirmationClaims {
  sub?: string;
  tool?: string;
  input?: string;
  /** Hash of what the preview promised, for tools that bind it. */
  shown?: string;
  jti?: string;
  exp?: number;
}

export interface IssuedConfirmation {
  token: string;
  /** ISO-8601. Shown so the model can say when the preview lapses. */
  expiresAt: string;
}

@Injectable()
export class ConfirmationService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `shown` is the part of the preview the partner is agreeing to, for a tool
   * whose same input can do more by the time it commits — a transition that
   * would lock a draft order created after the preview, a stock booking whose
   * landed cost moved. Left out, only the input is bound.
   */
  issue(
    partnerId: string,
    tool: string,
    input: unknown,
    shown?: unknown,
  ): IssuedConfirmation {
    const token = this.jwt.sign(
      {
        tool,
        input: inputHash(input),
        ...(shown === undefined ? {} : { shown: inputHash(shown) }),
      },
      {
        audience: CONFIRMATION_AUDIENCE,
        subject: partnerId,
        jwtid: randomUUID(),
        expiresIn: CONFIRMATION_TTL_SECONDS,
        algorithm: 'HS256',
      },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /**
   * Spends the token, or refuses. Returns only when the caller may commit.
   *
   * Spent before the commit runs, never after: a commit that then fails costs
   * a fresh preview, which is cheap, whereas spending afterwards leaves a
   * window in which one "yes" commits twice.
   */
  async redeem(
    token: string,
    partnerId: string,
    tool: string,
    input: unknown,
    /** Previews again, for a token that bound what it showed. */
    shownNow?: () => Promise<unknown>,
  ): Promise<void> {
    let claims: ConfirmationClaims;
    try {
      claims = this.jwt.verify<ConfirmationClaims>(token, {
        audience: CONFIRMATION_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw badRequest(
          'CONFIRMATION_EXPIRED',
          'This confirmation has expired. Show the preview again and confirm it within 15 minutes.',
        );
      }
      throw invalid();
    }

    if (!claims.jti || typeof claims.exp !== 'number') throw invalid();

    if (
      claims.sub !== partnerId ||
      claims.tool !== tool ||
      claims.input !== inputHash(input)
    ) {
      throw badRequest(
        'CONFIRMATION_MISMATCH',
        'This confirmation was given for a different request. Nothing was saved — show the new preview and confirm that.',
      );
    }

    // Checked before the token is spent, so a preview that went stale leaves
    // the partner free to look again rather than burning their "yes". A token
    // already spent says so first — previewing again for a replay would answer
    // with whatever the finished write now makes the preview refuse.
    if (claims.shown !== undefined) {
      const spent = await this.prisma.usedNonce.findUnique({
        where: { jti: claims.jti },
      });
      if (spent) throw used();
      const shown = shownNow ? await shownNow() : undefined;
      if (shown === undefined || claims.shown !== inputHash(shown)) {
        throw conflict(
          'PREVIEW_CHANGED',
          'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
        );
      }
    }

    // Single use rests on the primary key, not on looking first: two
    // presentations at once would both find nothing and both commit.
    try {
      await this.prisma.usedNonce.create({
        data: {
          jti: claims.jti,
          kind: 'confirmation',
          expiresAt: new Date(claims.exp * 1000),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw used();
      throw err;
    }
  }
}

function used() {
  return conflict(
    'CONFIRMATION_USED',
    'This confirmation has already been used. Nothing more was saved.',
  );
}

function invalid() {
  return badRequest(
    'CONFIRMATION_INVALID',
    'This confirmation is not valid. Show the preview again and confirm that.',
  );
}
