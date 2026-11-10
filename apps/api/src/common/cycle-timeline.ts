import { CYCLE_STATUSES } from './cycle-statuses';
import { expectedLegs } from './cycle-routes';

/**
 * A cycle's timeline: when each step happened and how long each took
 * (BUSINESS_LOGIC §1, owner 2026-11-10 — "how many days from China to UAE,
 * how long it waited in UAE, then to Egypt, the 1st batch, the 2nd…").
 *
 * Pure arithmetic over days the records already hold — the purchase orders'
 * dates, each leg's departures and deliveries, the receipts into stock and the
 * cycle's status history. The service loads them (`CyclesService.getTimeline`)
 * and the office app only renders what this returns.
 *
 * Every day is a Cairo calendar day, YYYY-MM-DD, and a length is a whole
 * number of calendar days between two of them — never hours divided by 24,
 * which a clock change or a UTC midnight would shift by one.
 *
 * Steps are in the order of the process, not sorted by date: leg 2's goods can
 * leave Dubai before leg 1's last batch reaches it, and that is two things
 * happening at once, not a step out of order. So each step is measured from
 * the step it actually follows (its "from"), named by `since.measure`:
 *
 *   ordered → first part leaves the leg's origin          AFTER_ORDER  (leg 1)
 *   last batch in at the leg's origin → first part leaves WAITED       (leg 2+)
 *   first part left → first batch arrives                 ON_THE_WAY
 *   1st part / batch / receipt → the next one             AFTER_FIRST
 *   batch reached Egypt → received into stock             AFTER_ARRIVAL
 *   first received → selling                              AFTER_RECEIVED
 *   selling → settlement                                  SELLING_FOR
 *   anything else → the step before it                    LATER
 *
 * A step dated before the one it is measured from (a delivery recorded before
 * its departure) is shown with its date as recorded and no length: `flag` says
 * so. A negative or a made-up 0 would be a number nobody entered (CLAUDE.md
 * §10). GUESS, 2026-11-10.
 */

export type TimelineStepKind =
  | 'ORDERED'
  | 'DEPARTED'
  | 'DELIVERED'
  | 'RECEIVED'
  | 'SELLING'
  | 'SETTLEMENT'
  | 'CLOSED'
  | 'CANCELLED';

/**
 * DONE has a day (or, for a status reached with no row recording when, null);
 * UPCOMING is not reached yet; NOT_RECORDED was skipped in the records while a
 * later step happened (a cycle entered after the fact) — it is not "next".
 */
export type TimelineStepState = 'DONE' | 'UPCOMING' | 'NOT_RECORDED';

export type TimelineMeasure =
  | 'AFTER_ORDER'
  | 'WAITED'
  | 'ON_THE_WAY'
  | 'AFTER_FIRST'
  | 'AFTER_ARRIVAL'
  | 'AFTER_RECEIVED'
  | 'SELLING_FOR'
  | 'LATER';

export interface TimelineStep {
  /** Stable within one timeline: `ordered`, `leg2-departed-1`, `received-last`… */
  key: string;
  kind: TimelineStepKind;
  state: TimelineStepState;
  /** The Cairo day it happened; null unless DONE (and null for a status nothing dated). */
  day: string | null;
  /** The leg a departure or delivery is on, with its route as recorded. */
  leg: { sequence: number; origin: string; destination: string } | null;
  /** 1st, 2nd… departure or delivery of its leg; null for a step that has no parts. */
  part: number | null;
  /** How many parts of its kind the leg has recorded: 1 is said without a number. */
  parts: number | null;
  /** An upcoming step for what is left after some has already gone: "the rest arrives". */
  rest: boolean;
  /** The delivery that brought the leg's last goods in, when it came in parts. */
  completesLeg: boolean;
  /** RECEIVED only: the one day stock was received, or the first or last of several. */
  receipt: 'ONLY' | 'FIRST' | 'LAST' | null;
  /** How long after the step it follows, for a DONE step whose day is known. */
  since: { days: number; measure: TimelineMeasure; from: string } | null;
  /** For the step under way: days from the step it follows until today. */
  soFar: { days: number; measure: TimelineMeasure; from: string } | null;
  /** Dated before the step it is measured from: shown as recorded, with no length. */
  flag: 'BEFORE_PREVIOUS' | null;
  /**
   * A status whose date came from the audit log, before the status history
   * began on 2026-11-08 — the time the change was logged, which is close to,
   * not exactly, when it was made.
   */
  recorded: boolean;
}

export interface TimelineSummary {
  /** The day the first order was placed. */
  from: string;
  /** Selling began, the cycle was cancelled, or today. */
  to: string;
  days: number;
  until: 'SELLING' | 'CANCELLED' | 'TODAY';
}

export interface CycleTimeline {
  steps: TimelineStep[];
  /** Order to selling (or to today, "so far"); null with no order placed. */
  summary: TimelineSummary | null;
  today: string;
}

export interface TimelineLegInput {
  sequence: number;
  origin: string;
  destination: string;
  /** Each departure's day, in any order. */
  departures: string[];
  /** Each delivery's day, in any order. */
  deliveries: string[];
  /** Goods entered the leg and have not left its origin yet. */
  waitingToLeave: boolean;
  /** Nothing on the leg is still on the way or waiting to leave. */
  complete: boolean;
}

export interface TimelineInput {
  originType: string;
  status: string;
  /** Each purchase order's day. */
  orderedOn: string[];
  legs: TimelineLegInput[];
  /** Each receipt into stock's day (stock moved in from another cycle is not one). */
  receivedOn: string[];
  /** Every status change: the status entered, its Cairo day, and whether it came from the audit log. */
  statusChanges: { toStatus: string; day: string; recorded: boolean }[];
  today: string;
}

/**
 * The day `cycle_status_changes` began to be written by its trigger
 * (migration 20261108300000). Changes before it were filled in from the audit
 * log, so their dates are when the change was logged.
 */
export const STATUS_HISTORY_BEGAN = '2026-11-08';

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole calendar days from `from` to `to`, both YYYY-MM-DD. Negative when
 * `to` is earlier. Read as UTC midnights, where every day is 24 hours long.
 */
export function daysBetween(from: string, to: string): number {
  if (!DAY.test(from) || !DAY.test(to)) {
    throw new Error(`daysBetween needs YYYY-MM-DD days (${from}, ${to})`);
  }
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

const byDay = (a: string, b: string) => a.localeCompare(b);
const rank = (status: string) =>
  (CYCLE_STATUSES as readonly string[]).indexOf(status);

/** The latest of `days` on or before `day`; failing that, the earliest. */
function latestOnOrBefore(days: string[], day: string): string | undefined {
  const sorted = [...days].sort(byDay);
  const before = sorted.filter((d) => d <= day);
  return before.length ? before[before.length - 1] : sorted[0];
}

function blank(
  key: string,
  kind: TimelineStepKind,
  state: TimelineStepState,
  day: string | null,
): TimelineStep {
  return {
    key,
    kind,
    state,
    day,
    leg: null,
    part: null,
    parts: null,
    rest: false,
    completesLeg: false,
    receipt: null,
    since: null,
    soFar: null,
    flag: null,
    recorded: false,
  };
}

export function cycleTimeline(input: TimelineInput): CycleTimeline {
  const today = input.today;
  const cancelled = input.status === 'CANCELLED';
  const steps: TimelineStep[] = [];
  /** What each step is measured from: a step's key, or a bare day. */
  const fromOf = new Map<
    string,
    { day: string | null; measure: TimelineMeasure; from: string } | null
  >();

  const measure = (
    step: TimelineStep,
    from: { day: string | null; key: string } | undefined,
    m: TimelineMeasure,
  ) => {
    fromOf.set(
      step.key,
      from ? { day: from.day, measure: m, from: from.key } : null,
    );
  };

  // ── Ordered ────────────────────────────────────────────────────────────
  const ordered = [...input.orderedOn].sort(byDay)[0] ?? null;
  const orderedStep = blank(
    'ordered',
    'ORDERED',
    ordered ? 'DONE' : 'UPCOMING',
    ordered,
  );
  steps.push(orderedStep);

  // ── The legs, in route order, with any the route still expects ─────────
  const recorded = [...input.legs].sort((a, b) => a.sequence - b.sequence);
  const have = new Set(recorded.map((l) => l.sequence));
  const legs: TimelineLegInput[] = [
    ...recorded,
    ...expectedLegs(input.originType)
      .filter((e) => !have.has(e.sequence))
      .map((e) => ({
        ...e,
        departures: [],
        deliveries: [],
        waitingToLeave: false,
        complete: false,
      })),
  ].sort((a, b) => a.sequence - b.sequence);

  let previousLeg: { deliveries: string[]; key: (d: string) => string } | null =
    null;
  let lastLegDeliveries: { day: string; key: string }[] = [];

  for (const leg of legs) {
    const route = {
      sequence: leg.sequence,
      origin: leg.origin,
      destination: leg.destination,
    };
    const prefix = `leg${leg.sequence}`;
    const departures = [...leg.departures].sort(byDay);
    const deliveries = [...leg.deliveries].sort(byDay);

    // Departures.
    if (departures.length === 0) {
      const s = blank(`${prefix}-departed-1`, 'DEPARTED', 'UPCOMING', null);
      s.leg = route;
      steps.push(s);
      measureDeparture(s, null);
    }
    departures.forEach((day, i) => {
      const s = blank(`${prefix}-departed-${i + 1}`, 'DEPARTED', 'DONE', day);
      s.leg = route;
      s.part = i + 1;
      s.parts = departures.length;
      steps.push(s);
      if (i === 0) measureDeparture(s, day);
      else
        measure(
          s,
          { day: departures[0], key: `${prefix}-departed-1` },
          'AFTER_FIRST',
        );
    });
    if (departures.length > 0 && leg.waitingToLeave) {
      const s = blank(`${prefix}-departed-rest`, 'DEPARTED', 'UPCOMING', null);
      s.leg = route;
      s.rest = true;
      s.part = departures.length + 1;
      s.parts = departures.length;
      steps.push(s);
      measure(s, undefined, 'LATER');
    }

    // Deliveries.
    const firstDeparture = departures[0];
    const fromDeparture = firstDeparture
      ? { day: firstDeparture, key: `${prefix}-departed-1` }
      : undefined;
    if (deliveries.length === 0) {
      const s = blank(`${prefix}-delivered-1`, 'DELIVERED', 'UPCOMING', null);
      s.leg = route;
      steps.push(s);
      measure(s, fromDeparture, 'ON_THE_WAY');
    }
    deliveries.forEach((day, i) => {
      const s = blank(`${prefix}-delivered-${i + 1}`, 'DELIVERED', 'DONE', day);
      s.leg = route;
      s.part = i + 1;
      s.parts = deliveries.length;
      s.completesLeg =
        deliveries.length > 1 && leg.complete && i === deliveries.length - 1;
      steps.push(s);
      if (i === 0) measure(s, fromDeparture, 'ON_THE_WAY');
      else
        measure(
          s,
          { day: deliveries[0], key: `${prefix}-delivered-1` },
          'AFTER_FIRST',
        );
    });
    if (deliveries.length > 0 && !leg.complete) {
      const s = blank(
        `${prefix}-delivered-rest`,
        'DELIVERED',
        'UPCOMING',
        null,
      );
      s.leg = route;
      s.rest = true;
      s.part = deliveries.length + 1;
      s.parts = deliveries.length;
      steps.push(s);
      measure(s, undefined, 'LATER');
    }

    previousLeg = {
      deliveries,
      key: (d) => `${prefix}-delivered-${deliveries.indexOf(d) + 1}`,
    };
    lastLegDeliveries = deliveries.map((d, i) => ({
      day: d,
      key: `${prefix}-delivered-${i + 1}`,
    }));
  }

  /** Leg 1 leaves after the order; a later leg after its goods came in. */
  function measureDeparture(s: TimelineStep, day: string | null) {
    if (!previousLeg) {
      measure(
        s,
        ordered ? { day: ordered, key: 'ordered' } : undefined,
        'AFTER_ORDER',
      );
      return;
    }
    const at = latestOnOrBefore(previousLeg.deliveries, day ?? today);
    measure(
      s,
      at ? { day: at, key: previousLeg.key(at) } : undefined,
      'WAITED',
    );
  }

  // ── Received into stock ────────────────────────────────────────────────
  const receipts = [...new Set(input.receivedOn)].sort(byDay);
  const arrival = (day: string) => {
    const at = latestOnOrBefore(
      lastLegDeliveries.map((d) => d.day),
      day,
    );
    return lastLegDeliveries.find((d) => d.day === at);
  };
  if (receipts.length === 0) {
    const s = blank('received-first', 'RECEIVED', 'UPCOMING', null);
    steps.push(s);
    measure(s, arrival(today), 'AFTER_ARRIVAL');
  } else {
    const first = blank('received-first', 'RECEIVED', 'DONE', receipts[0]);
    first.receipt = receipts.length === 1 ? 'ONLY' : 'FIRST';
    steps.push(first);
    measure(first, arrival(receipts[0]), 'AFTER_ARRIVAL');
    if (receipts.length > 1) {
      const last = blank(
        'received-last',
        'RECEIVED',
        'DONE',
        receipts[receipts.length - 1],
      );
      last.receipt = 'LAST';
      steps.push(last);
      measure(last, { day: receipts[0], key: 'received-first' }, 'AFTER_FIRST');
    }
  }

  // ── The statuses worth a line ──────────────────────────────────────────
  const changesTo = (status: string) =>
    input.statusChanges
      .filter((c) => c.toStatus === status)
      .sort((a, b) => byDay(a.day, b.day));
  const now = rank(input.status);
  /**
   * Selling is when it first began; Settlement and Closed the last time they
   * were entered (a reversed settlement goes back to Selling and comes again).
   * A cancelled cycle shows only the ones it reached before it was cancelled.
   */
  const statusStep = (
    kind: 'SELLING' | 'SETTLEMENT' | 'CLOSED',
    which: 'first' | 'last',
    from: TimelineStep | undefined,
    m: TimelineMeasure,
  ) => {
    const changes = changesTo(kind);
    const change = which === 'first' ? changes[0] : changes[changes.length - 1];
    const reached = cancelled ? !!change : now >= rank(kind);
    const s = blank(
      kind.toLowerCase(),
      kind,
      reached ? 'DONE' : 'UPCOMING',
      reached ? (change?.day ?? null) : null,
    );
    s.recorded = reached && !!change?.recorded;
    steps.push(s);
    measure(s, from ? { day: from.day, key: from.key } : undefined, m);
    return s;
  };

  const selling = statusStep(
    'SELLING',
    'first',
    steps.find((s) => s.key === 'received-first'),
    'AFTER_RECEIVED',
  );
  const settlement = statusStep('SETTLEMENT', 'last', selling, 'SELLING_FOR');
  statusStep('CLOSED', 'last', settlement, 'LATER');
  let cancelledDay: string | null = null;
  if (cancelled) {
    const c = changesTo('CANCELLED').pop();
    cancelledDay = c?.day ?? null;
    const s = blank('cancelled', 'CANCELLED', 'DONE', cancelledDay);
    s.recorded = !!c?.recorded;
    steps.push(s);
    measure(s, undefined, 'LATER');
  }

  // ── What is not next, and what is no longer to come ────────────────────
  // A cancelled cycle has nothing to come: only what happened is shown.
  const kept = cancelled ? steps.filter((s) => s.state === 'DONE') : steps;
  // A step still to come, followed by one that happened, was skipped in the
  // records (a cycle entered after the fact) — except "the rest", which is
  // genuinely still on its way while later steps go ahead.
  let laterDone = false;
  for (let i = kept.length - 1; i >= 0; i--) {
    const s = kept[i];
    if (s.state === 'DONE') laterDone = true;
    else if (laterDone && !s.rest) s.state = 'NOT_RECORDED';
  }

  // ── Lengths ────────────────────────────────────────────────────────────
  const byKey = new Map(kept.map((s) => [s.key, s]));
  kept.forEach((s, i) => {
    const f = fromOf.get(s.key);
    const fromStep = f ? byKey.get(f.from) : undefined;
    const usable =
      f && f.day && (!fromStep || fromStep.state === 'DONE') ? f : null;
    if (s.state === 'DONE') {
      if (!s.day) return;
      if (usable) {
        const days = daysBetween(usable.day!, s.day);
        if (days < 0) s.flag = 'BEFORE_PREVIOUS';
        else s.since = { days, measure: usable.measure, from: usable.from };
        return;
      }
      // Nothing recorded for the step it follows: measured from the last
      // step before it that has a day, as "N days later". Never flagged —
      // that step may well be a parallel one, not its predecessor.
      const previous = kept
        .slice(0, i)
        .reverse()
        .find((x) => x.state === 'DONE' && x.day);
      if (!previous) return;
      const days = daysBetween(previous.day!, s.day);
      if (days >= 0) s.since = { days, measure: 'LATER', from: previous.key };
    } else if (s.state === 'UPCOMING' && !s.rest && usable) {
      const days = daysBetween(usable.day!, today);
      // Begun today is nothing to count yet: "0 days so far" says nothing.
      if (days > 0) {
        s.soFar = { days, measure: usable.measure, from: usable.from };
      }
    }
  });
  // Only the step under way counts "so far": the first one still to come.
  const next = kept.find((s) => s.state === 'UPCOMING' && !s.rest);
  for (const s of kept) if (s !== next) s.soFar = null;

  // ── Order to selling ───────────────────────────────────────────────────
  let summary: TimelineSummary | null = null;
  if (ordered) {
    const sold = selling.state === 'DONE' && selling.day ? selling.day : null;
    const to = sold ?? (cancelled ? cancelledDay : null) ?? today;
    const until = sold
      ? 'SELLING'
      : cancelled && cancelledDay
        ? 'CANCELLED'
        : 'TODAY';
    const days = daysBetween(ordered, to);
    summary = { from: ordered, to, days: Math.max(days, 0), until };
  }

  return { steps: kept, summary, today };
}
