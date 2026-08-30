import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { OrderRequestDecisionsService } from './order-request-decisions.service';
import { PortalNotifier } from '../notifications/portal-notifier.service';

/**
 * The clock behind the holds.
 *
 * `releaseExpiredHolds()` existed and nothing called it, so reservations sat
 * ACTIVE forever after their deadline. That was not wrong on screen —
 * `availableQty` ignores a hold past its time, so stock was never withheld —
 * but it left a table that only ever grew, and "the deadline is the rule, not
 * the sweeper" is only a defensible design if the sweeper actually runs.
 *
 * It also does the more useful half: warning the office six hours before a hold
 * lapses, while there is still stock behind the request. A notification saying
 * the stock has already gone back on the shelf is a report; one saying it is
 * about to is a prompt.
 */
@Injectable()
export class HoldsScheduler {
  private readonly log = new Logger(HoldsScheduler.name);

  constructor(
    private prisma: PrismaService,
    private decisions: OrderRequestDecisionsService,
    private notifier: PortalNotifier,
  ) {}

  /**
   * Every fifteen minutes.
   *
   * Frequent enough that "six hours left" means roughly that, and rare enough
   * that it is two cheap queries an hour on a table with a few rows in it.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweep() {
    try {
      await this.warnAboutExpiring();
      const { released } = await this.decisions.releaseExpiredHolds();
      if (released > 0) this.log.log(`released ${released} expired hold(s)`);
    } catch (err) {
      // A scheduled job that throws takes nothing down here, but it does fill
      // the log with an unhandled rejection and tells nobody what failed.
      this.log.error(`hold sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Nudge the office about anything lapsing within six hours.
   *
   * `holdWarnedAt` is what stops this firing every half hour for the same
   * request until it expires — twelve identical alerts is how people learn to
   * ignore the bell.
   */
  private async warnAboutExpiring() {
    const soon = new Date(Date.now() + 6 * 60 * 60 * 1000);

    const expiring = await this.prisma.orderRequest.findMany({
      where: {
        status: 'PENDING',
        holdWarnedAt: null,
        holdExpiresAt: { gt: new Date(), lte: soon },
      },
      include: { customer: { select: { displayName: true } } },
    });

    for (const request of expiring) {
      await this.notifier.holdExpiringSoon({
        requestId: request.id,
        requestNo: request.requestNo,
        shopName: request.customer.displayName,
      });
      await this.prisma.orderRequest.update({
        where: { id: request.id },
        data: { holdWarnedAt: new Date() },
      });
    }

    if (expiring.length > 0) this.log.log(`warned about ${expiring.length} expiring hold(s)`);
  }
}
