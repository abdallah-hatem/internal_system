import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from './api-error';
import { loadShipment } from './shipment-load';

/**
 * A cycle settles only once every unit it ordered is accounted for
 * (BUSINESS_LOGIC §8 — DECIDED 2026-10-10): received into stock, or marked
 * lost. Goods still on the way, or delivered and not yet counted in, make the
 * cycle's profit a guess.
 *
 * The ONE gate, called by both routes into SETTLEMENT (spec amendment 5): the
 * plain transition (`CyclesService.planTransition`) and settlement `approve`,
 * which writes the status itself. Two copies would let one route through the
 * moment the other changed (CLAUDE.md rule 11).
 *
 * The caller holds the cycle's lock (`lockCycle`) in the same transaction, so a
 * delivery or a loss taken back cannot slip in between this check and the
 * status being written.
 *
 * A cycle with nothing ordered has nothing to account for and passes.
 */
export async function assertShipmentAccounted(
  db: Pick<Prisma.TransactionClient, 'importCycle'>,
  cycleId: string,
) {
  const open = await shipmentUnaccounted(db, cycleId);
  if (!open) return;
  throw badRequest(
    'SHIPMENT_NOT_ACCOUNTED',
    `Cycle ${open.cycle} cannot be settled yet: ${open.onTheWay} unit(s) are still on the way and ${open.waiting} delivered but not received, across ${open.lines} order line(s). Receive them, or mark them lost, first.`,
    open,
  );
}

/**
 * What still stops a cycle being accounted for, or null when every unit is
 * received or lost: its code, the units on the way, the units delivered and
 * not received, and how many order lines. The figures behind the settlement
 * gate above and the leftover-transfer gate (§8, L5) — one reading.
 */
export async function shipmentUnaccounted(
  db: Pick<Prisma.TransactionClient, 'importCycle'>,
  cycleId: string,
) {
  const loaded = await loadShipment(db, cycleId);
  if (!loaded) throw notFound('cycle');
  const { cycle, position } = loaded;
  if (position.accounted) return null;

  const open = position.lines.filter((l) => !l.accounted);
  const milli = (n: number) => Math.round(n * 1000);
  // Everything neither received, lost nor waiting on a shelf is still coming —
  // including goods on a cycle whose legs were never recorded.
  const onTheWay =
    open.reduce(
      (s, l) =>
        s +
        Math.max(
          0,
          milli(l.ordered) -
            milli(l.received) -
            milli(l.lost) -
            milli(l.waiting),
        ),
      0,
    ) / 1000;
  const waiting = open.reduce((s, l) => s + milli(l.waiting), 0) / 1000;
  return { cycle: cycle.code, onTheWay, waiting, lines: open.length };
}
