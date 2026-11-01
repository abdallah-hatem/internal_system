/**
 * Start this Node process's clock at a chosen moment.
 *
 *   NODE_OPTIONS="--require scripts/lib/fixed-clock.cjs" FIXED_CLOCK=2026-11-01T08:00:00Z node …
 *
 * For the visual-regression run only (apps/web/tests/visual.spec.ts). The
 * dashboard's "This month", an order's age and every other figure the API
 * works out from "now" would otherwise change the screen as the calendar
 * moves, and a baseline taken in November would fail in December with
 * nothing wrong. `scripts/agent-servers.sh` loads this into the API when
 * `AGENT_CLOCK` is set.
 *
 * The clock still runs — it starts at FIXED_CLOCK and advances in real time —
 * so timeouts, token lifetimes and caches behave as they always do. Only
 * `Date` is touched; timers do not read it.
 */
'use strict';

const fixed = Date.parse(process.env.FIXED_CLOCK || '');
if (Number.isNaN(fixed)) {
  throw new Error(`fixed-clock: FIXED_CLOCK must be an ISO date, got "${process.env.FIXED_CLOCK}"`);
}

const RealDate = Date;
const offset = fixed - RealDate.now();

// A function rather than a class: `Date()` called without `new` must still
// answer (a string, as the real one does), and a class constructor throws.
function ShiftedDate(...args) {
  if (!new.target) return new RealDate(RealDate.now() + offset).toString();
  return args.length === 0 ? new RealDate(RealDate.now() + offset) : new RealDate(...args);
}
ShiftedDate.prototype = RealDate.prototype;
ShiftedDate.now = () => RealDate.now() + offset;
ShiftedDate.parse = RealDate.parse;
ShiftedDate.UTC = RealDate.UTC;
Object.defineProperty(ShiftedDate, Symbol.hasInstance, { value: (v) => v instanceof RealDate });

globalThis.Date = ShiftedDate;
