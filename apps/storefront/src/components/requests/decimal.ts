/**
 * The little arithmetic this app is allowed to do, done in integers.
 *
 * The rule is that the browser does no money arithmetic — the figure that
 * counts is the one the server puts on the order. The basket still has to show
 * a running total, though, because a shop asking for eleven lines needs to know
 * roughly what it is committing to before it presses send, and "we cannot tell
 * you" is not an answer.
 *
 * So: an estimate, labelled as one, computed the only way that cannot drift.
 * Every decimal string is scaled to a whole number of ten-thousandths and
 * summed as a `bigint`. `0.1 + 0.2` is exactly `0.3` here because neither value
 * is ever a float. The result is handed back as a decimal string and rendered
 * by `ui/money`, which formats and does not calculate.
 *
 * None of this makes the number authoritative. It makes it honest about being
 * an estimate rather than an estimate that is also wrong in the last digit.
 *
 * Written with `BigInt()` rather than `10n` throughout: the project compiles at
 * an ES2017 target, where the literal form is a compile error even though the
 * type and the constructor are both available.
 */

/** Ten-thousandths. Wider than any price the API sends, so nothing is lost. */
const PLACES = 4;
const ZERO = BigInt(0);
const TWO = BigInt(2);
const TEN = BigInt(10);

function pow10(exponent: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < exponent; i++) result *= TEN;
  return result;
}

const ONE = pow10(PLACES);

/**
 * A decimal string as a whole number of ten-thousandths.
 *
 * Returns null for anything that is not a plain decimal — an empty string, a
 * stray "N/A", a value in exponent notation. A caller that cannot read one of
 * its prices must decline to show a total rather than quietly treat it as zero,
 * which would understate what the shop is asking for.
 */
export function parseDecimal(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;

  const match = /^\s*(-?)(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const padded = (fraction + '0'.repeat(PLACES)).slice(0, PLACES);
  const scaled = BigInt(whole) * ONE + BigInt(padded);

  return sign === '-' ? -scaled : scaled;
}

/** Back to a decimal string with `places` digits, rounding half away from zero. */
export function formatScaled(scaled: bigint, places = 2): string {
  const divisor = pow10(PLACES - places);

  const negative = scaled < ZERO;
  const magnitude = negative ? -scaled : scaled;
  // Half-up on the magnitude, so -0.005 and 0.005 round to the same distance
  // from zero rather than one of them creeping towards it.
  const rounded = (magnitude + divisor / TWO) / divisor;

  const unit = pow10(places);
  const whole = rounded / unit;
  const fraction = rounded % unit;

  const body =
    places === 0 ? whole.toString() : `${whole}.${fraction.toString().padStart(places, '0')}`;

  return negative && rounded !== ZERO ? `-${body}` : body;
}

/**
 * What the basket comes to, roughly.
 *
 * Null when any line's price cannot be read — see `parseDecimal`. Quantities
 * are whole counts, so multiplying by a `bigint` stays exact.
 */
export function estimateTotal(lines: { unitPrice: string; quantity: number }[]): string | null {
  let total = ZERO;

  for (const line of lines) {
    const price = parseDecimal(line.unitPrice);
    if (price === null) return null;
    if (!Number.isInteger(line.quantity)) return null;
    total += price * BigInt(line.quantity);
  }

  return formatScaled(total);
}

/**
 * Whether two decimal strings say the same thing.
 *
 * `"10"` and `"10.000"` are the same quantity and a string comparison says they
 * are not — which on the request detail would announce that the owner changed a
 * line they never touched. Both sides are compared as scaled integers instead.
 */
export function sameDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (left === null || right === null) return a === b;
  return left === right;
}

/** True when a decimal string is exactly zero, whatever it was written as. */
export function isZero(value: string | null | undefined): boolean {
  return parseDecimal(value) === ZERO;
}

/**
 * A quantity, tidied for display.
 *
 * The API sends quantities as decimal strings with whatever scale the column
 * has, so an order for six parts arrives as `"6"` or `"6.000"` depending on the
 * row. Trailing zeros after the point are noise to a shop counting boxes.
 */
export function trimQuantity(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (!trimmed.includes('.')) return trimmed;

  return trimmed.replace(/\.?0+$/, '');
}
