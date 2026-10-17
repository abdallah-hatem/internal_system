import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { unauthorized } from '../../common/api-error';
import { hashToken, newRefreshToken } from '../../common/opaque-token';

/**
 * What time it is. Injected so day thirty-one can be tested without waiting.
 */
export const SESSION_CLOCK = Symbol('SESSION_CLOCK');
export type SessionClock = () => Date;

/**
 * How long an office access token lives. Short, because it cannot be taken
 * back: it is a signed JWT and the API keeps no list of them. The refresh
 * token below is what makes a sign-in last (BUSINESS_LOGIC §23).
 */
export const OFFICE_ACCESS_TTL = '1h';

/**
 * Thirty days of not opening the app, and the sign-in ends. Rolling: every
 * refresh starts the thirty days again, so someone who opens the office at
 * least once a month never sees the login page.
 */
export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a spent token is still honoured. Opening the app fires several
 * requests at once, and two tabs (or a tab and the installed app) can each
 * refresh with the same token a moment apart. Inside this window that is the
 * same holder racing itself, and gets a pair in the same sign-in; after it,
 * a spent token coming back is treated as stolen.
 */
export const REUSE_GRACE_MS = 30 * 1000;

/** Who a refresh token belongs to, as the access token needs them. */
export interface SessionUserRow {
  id: string;
  email: string;
  role: string;
  partner: { displayName: string } | null;
}

/** Every refusal reads the same to a client: sign in again. */
const expired = (english: string) => unauthorized('SESSION_EXPIRED', english);

/**
 * Office refresh tokens (owner, 2026-10-17).
 *
 * Random, stored hashed, spent on every use. Each sign-in starts a family;
 * every token refreshed from it inherits the family. A token that was already
 * spent coming back after `REUSE_GRACE_MS` means two holders — the app and
 * whoever copied it — and which is which cannot be told, so the whole family
 * ends and both sign in again. Only the office: a portal or assistant token is never issued here,
 * and nothing issued anywhere else is in this table.
 */
@Injectable()
export class SessionTokensService {
  constructor(
    private prisma: PrismaService,
    @Inject(SESSION_CLOCK) private now: SessionClock,
  ) {}

  /** A new token. A new family unless continuing one (rotation). */
  async issue(
    userId: string,
    familyId: string = randomUUID(),
  ): Promise<string> {
    const token = newRefreshToken();
    await this.prisma.sessionRefreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt: new Date(this.now().getTime() + REFRESH_IDLE_MS),
      },
    });
    return token;
  }

  /**
   * Spend the presented token and hand back its successor.
   *
   * The checks run before anything is written, in the order that matters:
   * a token reused after the grace window ends its family even if it has
   * since expired, because reuse is the alarm and the rest are only reasons.
   * Reused inside the window, it gets a successor of its own in the same
   * family — unless the family was ended meanwhile (signed out).
   */
  async rotate(
    presented: unknown,
  ): Promise<{ user: SessionUserRow; refreshToken: string }> {
    if (typeof presented !== 'string' || presented.length === 0) {
      throw expired('No sign-in to continue.');
    }

    const row = await this.prisma.sessionRefreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        replacedById: true,
      },
    });
    if (!row) throw expired('The sign-in is not recognised.');

    const racing = row.replacedById !== null;
    if (racing && !this.withinGrace(row.lastUsedAt)) {
      await this.revokeFamily(row.familyId);
      throw expired(
        'The sign-in was already used; it has been ended everywhere.',
      );
    }
    if (racing && !(await this.familyAlive(row.familyId))) {
      throw expired('The sign-in was ended.');
    }
    if (!racing && row.revokedAt) throw expired('The sign-in was ended.');
    if (row.expiresAt <= this.now()) throw expired('The sign-in has expired.');

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        partner: { select: { displayName: true } },
      },
    });
    // A deactivated partner, or an account that became a shop's, holds no
    // office sign-in. End all of theirs rather than just refuse this one.
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.role === 'SHOP_OWNER_PORTAL'
    ) {
      await this.revokeAllForUser(row.userId);
      throw unauthorized('SESSION_INVALID', 'Your session is no longer valid');
    }

    const now = this.now();
    const refreshToken = newRefreshToken();
    await this.prisma.$transaction(async (tx) => {
      const next = await tx.sessionRefreshToken.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: hashToken(refreshToken),
          expiresAt: new Date(now.getTime() + REFRESH_IDLE_MS),
        },
        select: { id: true },
      });
      if (racing) return;
      // Conditional, so of two refreshes racing on one token exactly one
      // spends it. The other matches nothing; it keeps its new token only if
      // the winner spent it just now (the grace window), never if the family
      // was ended in between.
      const spent = await tx.sessionRefreshToken.updateMany({
        where: { id: row.id, revokedAt: null, replacedById: null },
        data: { revokedAt: now, lastUsedAt: now, replacedById: next.id },
      });
      if (spent.count === 1) return;
      const winner = await tx.sessionRefreshToken.findUnique({
        where: { id: row.id },
        select: { replacedById: true, lastUsedAt: true },
      });
      if (!winner?.replacedById || !this.withinGrace(winner.lastUsedAt)) {
        throw expired('The sign-in was already used.');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- status was only for the check above
    const { status, ...account } = user;
    return { user: account, refreshToken };
  }

  /**
   * Sign out: end the family the presented token belongs to. Says nothing
   * either way — an unknown token is as signed out as a known one.
   */
  async revokeFamilyOf(presented: unknown): Promise<void> {
    if (typeof presented !== 'string' || presented.length === 0) return;
    const row = await this.prisma.sessionRefreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  /** Every office sign-in this person holds, on every device. */
  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.sessionRefreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    return count;
  }

  private withinGrace(spentAt: Date | null): boolean {
    return (
      spentAt !== null &&
      this.now().getTime() - spentAt.getTime() <= REUSE_GRACE_MS
    );
  }

  /** Does any token of this sign-in still work? None after a sign-out. */
  private async familyAlive(familyId: string): Promise<boolean> {
    const live = await this.prisma.sessionRefreshToken.findFirst({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });
    return live !== null;
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.sessionRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }
}
