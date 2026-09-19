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

  issue(partnerId: string, tool: string, input: unknown): IssuedConfirmation {
    const token = this.jwt.sign(
      { tool, input: inputHash(input) },
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
      if (isUniqueViolation(err)) {
        throw conflict(
          'CONFIRMATION_USED',
          'This confirmation has already been used. Nothing more was saved.',
        );
      }
      throw err;
    }
  }
}

function invalid() {
  return badRequest(
    'CONFIRMATION_INVALID',
    'This confirmation is not valid. Show the preview again and confirm that.',
  );
}
