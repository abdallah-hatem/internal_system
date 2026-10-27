/**
 * Samples left at shops, as the office reads them (BUSINESS_LOGIC §4,
 * "Samples at shops", owner 2026-10-18). The rules live in the API
 * (`apps/api/src/common/samples.ts`); this only names the statuses and reads
 * the summary the API sends with every order, so no screen works out the
 * reminder day or the units out for itself.
 */

/** Every status a samples order holds while it is not a sale. */
export const SAMPLES_STATUSES = ['SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF', 'SAMPLES_BOUGHT'] as const;

export function isSamplesStatus(status: string | null | undefined): boolean {
  return (SAMPLES_STATUSES as readonly string[]).includes(status ?? '');
}

/** Units out at the shop on an open samples order: the API's figure, else its lines. */
export function samplesUnits(order: {
  samples?: { unitsOut: string | number } | null;
  items?: { quantity: number | string }[];
}): number {
  if (order.samples) return Number(order.samples.unitsOut);
  return (order.items ?? []).reduce((s, i) => s + Number(i.quantity), 0);
}
