/**
 * "Split equally" (BUSINESS_LOGIC §8, §18): what each core partner puts in.
 *
 * `toFundEgp` is the server's cost to fund (`CostingService.fundingFor`): the
 * cycle's goods, shipping and the expenses charged to it, plus stock moved in,
 * less what friends paid — never below zero. Temporary investors put in a
 * specific amount that is theirs, so it comes off before the partners split
 * the rest.
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
  const cents = Math.round(Math.max(toFundEgp - investorsEgp, 0) * 100);
  const each = Math.floor(cents / partners);
  const shares = Array.from(
    { length: partners },
    (_, i) => (i === partners - 1 ? cents - each * (partners - 1) : each) / 100,
  );
  return { total: cents / 100, shares };
}
