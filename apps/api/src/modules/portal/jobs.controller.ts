import { Controller, Get, Headers, Logger } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { HoldsScheduler } from './holds.scheduler';
import { Surface } from '../../common/surface';
import { unauthorized } from '../../common/api-error';

/**
 * The sweep, reachable over HTTP so a scheduler outside the process can run it.
 *
 * `@Cron` needs a process that stays alive between ticks. On a serverless host
 * there is no such process — a function exists for the length of a request and
 * is then gone — so the decorator registers a job that never fires. Nothing
 * fails and nothing logs: holds simply stop expiring, and the office stops
 * being warned six hours before stock goes back on the shelf.
 *
 * So the schedule moves out of the app and into the platform, and this is the
 * door it knocks on. `vercel.json` declares the timetable; the decorator still
 * runs the same sweep on a host that has a real process, and running both is
 * harmless — the sweep is idempotent, and `holdWarnedAt` already exists to stop
 * a second pass re-warning about the same request.
 *
 * Not in Swagger: it is not part of the API anyone builds against.
 */
@ApiExcludeController()
@Surface('public')
@Controller('jobs')
export class JobsController {
  private readonly log = new Logger(JobsController.name);

  constructor(private holds: HoldsScheduler) {}

  /**
   * GET, because that is what Vercel Cron sends.
   *
   * Public in the routing sense and not public in fact: without the shared
   * secret this is an unauthenticated endpoint that mutates reservations and
   * sends notifications, and anyone who found the URL could fire it in a loop.
   * Vercel sends `Authorization: Bearer $CRON_SECRET` on every scheduled
   * request when that variable is set.
   *
   * Refused when the secret is missing from the environment as well as when it
   * is wrong. A deployment that forgot to set it would otherwise leave the
   * endpoint open to everybody, which is the failure that looks like success.
   */
  @Get('sweep-holds')
  async sweepHolds(@Headers('authorization') authorization?: string) {
    const expected = process.env.CRON_SECRET;

    if (!expected) {
      this.log.error('CRON_SECRET is not set; refusing to run the sweep');
      throw unauthorized(
        'CRON_NOT_CONFIGURED',
        'This deployment has no CRON_SECRET, so scheduled jobs cannot be authenticated.',
      );
    }

    if (authorization !== `Bearer ${expected}`) {
      throw unauthorized('CRON_FORBIDDEN', 'This is not a scheduled request.');
    }

    await this.holds.sweep();
    return { ok: true, ranAt: new Date().toISOString() };
  }
}
