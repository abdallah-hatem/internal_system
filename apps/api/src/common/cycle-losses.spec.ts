// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type the fake stores money in, not data access
import { Prisma } from '@prisma/client';
import { cycleLossesEgp } from './cycle-losses';

/**
 * cycleLossesEgp — the one figure settlement and analytics both subtract for
 * goods lost on the way (§2, §9; CLAUDE.md rule 11). B3 wires it in.
 */
function dbWith(sum: Prisma.Decimal | null) {
  const aggregate = jest.fn().mockResolvedValue({ _sum: { costEgp: sum } });
  return { db: { shipmentLoss: { aggregate } }, aggregate };
}

describe('cycleLossesEgp', () => {
  it('sums the cost of every loss on every leg of the cycle', async () => {
    const { db, aggregate } = dbWith(new Prisma.Decimal('1650.50'));
    const total = await cycleLossesEgp(db, 'cycle-1');
    expect(total.toFixed(2)).toBe('1650.50');
    // Scoped to the cycle through the leg: a loss belongs to a leg, and a leg
    // to a cycle. Another cycle's losses are never in the sum.
    expect(aggregate).toHaveBeenCalledWith({
      where: { leg: { cycleId: 'cycle-1' } },
      _sum: { costEgp: true },
    });
  });

  it('a cycle with no losses → 0, a Decimal and never null (a null would NaN the profit)', async () => {
    const { db } = dbWith(null);
    const total = await cycleLossesEgp(db, 'cycle-1');
    expect(Prisma.Decimal.isDecimal(total)).toBe(true);
    expect(total.toFixed(2)).toBe('0.00');
  });

  it('the backfill’s zero-cost losses add nothing (they were charged to the batches already)', async () => {
    const { db } = dbWith(new Prisma.Decimal(0));
    expect((await cycleLossesEgp(db as never, 'c')).isZero()).toBe(true);
  });
});
