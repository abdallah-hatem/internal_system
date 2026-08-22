import { BadRequestException } from '@nestjs/common';

/**
 * Refuse a date that has not happened yet.
 *
 * Records of things that happened cannot be dated forward: money is not
 * received next week, and an order was not placed next month. Accepting one
 * puts revenue and cash into a period that has not occurred, so a report run
 * today already contains next month's figures.
 *
 * Compared as calendar days, not timestamps. A date column comes back at UTC
 * midnight while "now" is local, so comparing instants makes today look like
 * the future for anyone east of Greenwich — which is everyone here.
 */
export function assertNotFuture(value: string | Date | undefined | null, label: string) {
  if (!value) return;

  const given = new Date(value);
  if (Number.isNaN(given.getTime())) return; // shape is the DTO's job, not ours

  const day = (d: Date) =>
    [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

  // A date-only string is midnight UTC; read it back in UTC so it is not
  // shifted into yesterday before the comparison.
  const givenDay =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : day(given);

  if (givenDay > day(new Date())) {
    throw new BadRequestException(`${label} cannot be in the future (${givenDay}).`);
  }
}
