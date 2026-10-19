/**
 * "Split equally" (BUSINESS_LOGIC §8, §18): what each core partner puts in.
 *
 * `toFundEgp` is the server's cost to fund (`CostingService.fundingFor`): the
 * cycle's goods, shipping and the expenses charged to it, plus stock moved in.
 * What a friend paid the supplier is NOT taken off (owner 2026-10-19): it is a
 * loan the partners repay, so on a cycle a friend paid for this is each
 * partner's share of repaying him. Temporary investors put in a specific
 * amount that is theirs, so it comes off before the partners split the rest.
 *
 * To the piastre: thirds of 75,645.50 do not divide evenly, so the last
 * partner absorbs the residual and the parts re-sum exactly. Left uneven,
 * capital returned at settlement would not match capital put in.
 *
 * One definition for the cycle page's button and its funding note (the
 * wizard's funding step, which had its own copy, was removed 2026-10-18).
 */
export function splitAcrossPartners(
  toFundEgp: number,
  investorsEgp: number,
  partners: number,
): { total: number; shares: number[] } {
  if (partners <= 0) return { total: 0, shares: [] };
  const cents = partnersCents(toFundEgp, investorsEgp);
  const each = Math.floor(cents / partners);
  const shares = Array.from(
    { length: partners },
    (_, i) => (i === partners - 1 ? cents - each * (partners - 1) : each) / 100,
  );
  return { total: cents / 100, shares };
}

/** What the core partners fund between them, in piastres: the cost to fund less investors' money, never below zero. */
function partnersCents(toFundEgp: number, investorsEgp: number): number {
  return Math.round(Math.max(toFundEgp - investorsEgp, 0) * 100);
}

/**
 * Any split, not only equal (owner 2026-10-19: "it does not have to be
 * equally maybe 30,30,40"). Each core partner's row in "Enter amounts" has an
 * amount and a percentage of what the partners fund (`base`: the cost to fund
 * less investors' money, as Split equally takes it), kept in step. These are
 * the arithmetic of that editor, so it is tested without a screen.
 */

/** The amount `pct` percent of `base` comes to, to the piastre ('' when either is blank). */
export function amountFromPct(base: number, pct: string): string {
  if (pct.trim() === '' || !Number.isFinite(Number(pct))) return '';
  const cents = Math.round(Math.max(base, 0) * Number(pct));
  return (cents / 100).toFixed(2);
}

/** What share of `base` an amount is, to two decimals ('' when there is no base to be a share of). */
export function pctFromAmount(base: number, amount: string): string {
  if (amount.trim() === '' || base <= 0 || !Number.isFinite(Number(amount))) return '';
  return ((Number(amount) / base) * 100).toFixed(2);
}

/** The percentages typed, summed to the hundredth — the editor says so when they are not 100. */
export function pctTotal(pcts: string[]): number {
  return Math.round(pcts.reduce((s, p) => s + (Number(p) || 0) * 100, 0)) / 100;
}

export interface PartnerShareRow {
  amount: string;
  pct: string;
  /** Which of the two the person typed last; the other follows it. */
  from: 'amount' | 'pct' | null;
}

/**
 * When the percentages come to exactly 100 and the last partner's amount
 * came from his percentage, he absorbs the rounding, so the amounts sum to
 * `base` exactly — 30/30/40 of 172,155.50 is 51,646.65 + 51,646.65 +
 * 68,862.20, not a piastre over or under. An amount the person typed is
 * never changed.
 */
export function balanceLastPartner(rows: PartnerShareRow[], base: number): PartnerShareRow[] {
  if (rows.length === 0) return rows;
  const last = rows[rows.length - 1];
  if (last.from !== 'pct') return rows;
  if (rows.some((r) => r.pct.trim() === '')) return rows;
  if (Math.round(pctTotal(rows.map((r) => r.pct)) * 100) !== 10000) return rows;
  const others = rows.slice(0, -1).reduce((s, r) => s + Math.round(Number(r.amount || 0) * 100), 0);
  const rest = Math.round(Math.max(base, 0) * 100) - others;
  if (rest < 0) return rows;
  return [...rows.slice(0, -1), { ...last, amount: (rest / 100).toFixed(2) }];
}
