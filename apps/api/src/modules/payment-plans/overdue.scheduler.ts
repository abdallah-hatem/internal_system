import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PaymentPlansService } from './payment-plans.service';
import { LendersService } from '../lenders/lenders.service';
import { SalesService } from '../sales/sales.service';

/**
 * The daily overdue check (BUSINESS_LOGIC §7, DECIDED 2026-10-11).
 *
 * Same arrangement as the holds sweep (`portal/holds.scheduler.ts`): on
 * Vercel there is no process for `@Cron` to live in, so `vercel.json` calls
 * `GET /jobs/overdue-payments` once a day instead; on a host with a real
 * process this decorator runs it. Both running is harmless — an instalment is
 * notified once per partner, ever, however often the check runs.
 *
 * 05:00 UTC is 07:00 or 08:00 in Cairo: the morning, after the day turned, so
 * yesterday's instalments have had their whole due day.
 */
@Injectable()
export class OverdueScheduler {
  private readonly log = new Logger(OverdueScheduler.name);

  constructor(
    private plans: PaymentPlansService,
    private lenders: LendersService,
    private sales: SalesService,
  ) {}

  @Cron('0 5 * * *')
  async daily() {
    try {
      const { overdueInstalments, notifications } =
        await this.plans.notifyOverdue();
      // A friend's plan (§18) is checked by the same job: Vercel's Hobby
      // plan allows two crons and both are used.
      const lent = await this.lenders.notifyOverdue();
      // Samples at a shop for 14 days (§4, samples at shops) — same job.
      const samples = await this.sales.notifySamplesReminders();
      const sent = notifications + lent.notifications + samples.notifications;
      if (sent > 0) {
        this.log.log(
          `${overdueInstalments + lent.overdueInstalments} overdue instalment(s); ${sent} notification(s) sent`,
        );
      }
    } catch (err) {
      // A scheduled job that throws takes nothing down here, but it does fill
      // the log with an unhandled rejection and tells nobody what failed.
      this.log.error(`overdue check failed: ${(err as Error).message}`);
    }
  }
}
