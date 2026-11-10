import {
  cycleTimeline,
  daysBetween,
  type TimelineInput,
  type TimelineLegInput,
  type TimelineStep,
} from './cycle-timeline';
import { businessDay, nextDay } from './dates';

/**
 * The cycle timeline (BUSINESS_LOGIC §1, owner 2026-11-10): when each step
 * happened and how many days each took. The arithmetic is checked over every
 * day of five years (LEARNINGS "Tests that read the clock": one sample a day
 * from the real clock hides what goes wrong on 24 days of a year), and the
 * steps against the shapes a real cycle takes — legs in parts, legs entered
 * out of order, a delivery dated before its departure, a cycle entered after
 * the fact, a reversed settlement, a cancelled cycle.
 */

const TODAY = '2026-11-10';

function leg(
  sequence: number,
  departures: string[],
  deliveries: string[],
  extra: Partial<TimelineLegInput> = {},
): TimelineLegInput {
  const route =
    sequence === 1
      ? { origin: 'Guangzhou, CN', destination: 'Dubai, UAE' }
      : { origin: 'Dubai, UAE', destination: 'Cairo, Egypt' };
  return {
    sequence,
    ...route,
    departures,
    deliveries,
    waitingToLeave: false,
    complete: deliveries.length > 0,
    ...extra,
  };
}

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    originType: 'CHINA',
    status: 'PREPARING',
    orderedOn: ['2026-08-01'],
    legs: [],
    receivedOn: [],
    statusChanges: [],
    today: TODAY,
    ...over,
  };
}

const step = (steps: TimelineStep[], key: string) => {
  const found = steps.find((s) => s.key === key);
  if (!found)
    throw new Error(`no step ${key} in ${steps.map((s) => s.key).join(', ')}`);
  return found;
};
const since = (steps: TimelineStep[], key: string) => {
  const s = step(steps, key).since;
  return s ? `${s.days} ${s.measure}` : null;
};

/** Days from `from` to `to` by stepping one day at a time — the slow, obvious count. */
function countedDays(from: string, to: string) {
  let n = 0;
  for (let d = from; d < to; d = nextDay(d)) n++;
  return n;
}

describe('daysBetween', () => {
  it('agrees with counting day by day, from every day of 2024–2028 to the days after it', () => {
    // Every day of five years, two leap days among them, each month's end and
    // both of Egypt's clock changes every year.
    let checked = 0;
    for (let d = '2024-01-01'; d < '2029-01-01'; d = nextDay(d)) {
      let to = d;
      for (const step of [1, 1, 26, 1, 1, 1, 335]) {
        for (let i = 0; i < step; i++) to = nextDay(to);
        expect(daysBetween(d, to)).toBe(countedDays(d, to));
        expect(daysBetween(to, d)).toBe(-countedDays(d, to));
        checked++;
      }
      expect(daysBetween(d, d)).toBe(0);
    }
    expect(checked).toBeGreaterThan(12_000);
  });

  it('counts month ends and the leap day as the calendar does', () => {
    expect(daysBetween('2026-01-31', '2026-03-01')).toBe(29);
    expect(daysBetween('2028-01-31', '2028-03-01')).toBe(30);
    expect(daysBetween('2028-02-28', '2028-02-29')).toBe(1);
    expect(daysBetween('2028-02-29', '2028-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-04-30', '2026-05-31')).toBe(31);
  });

  it('is unmoved by the days Cairo changes its clock (a 23- and a 25-hour day)', () => {
    // Egypt's daylight saving, 2026: from the last Friday of April to the last
    // Thursday of October. The days are calendar days, not hours / 24.
    expect(daysBetween('2026-04-23', '2026-04-25')).toBe(2);
    expect(daysBetween('2026-10-28', '2026-10-31')).toBe(3);
  });

  it('refuses anything that is not a day, rather than answering NaN', () => {
    expect(() => daysBetween('2026-11-10T00:00:00Z', '2026-11-11')).toThrow();
    expect(() => daysBetween('', '2026-11-11')).toThrow();
  });
});

describe('days read from instants, near midnight in Cairo', () => {
  // A receipt or a status change is an instant; its day is Cairo's. These are
  // the instants that are one day in UTC and the next in Cairo.
  it.each([
    // Summer, UTC+3: 00:30 Cairo is 21:30 UTC the evening before.
    ['2026-07-14T21:30:00Z', '2026-07-15'],
    ['2026-07-14T20:59:59Z', '2026-07-14'],
    // Winter, UTC+2: 00:30 Cairo is 22:30 UTC.
    ['2026-01-14T22:30:00Z', '2026-01-15'],
    ['2026-01-14T21:59:59Z', '2026-01-14'],
    // Month and year ends.
    ['2026-12-31T22:00:00Z', '2027-01-01'],
    ['2026-08-31T21:00:00Z', '2026-09-01'],
  ])('%s is %s in Cairo', (instant, day) => {
    expect(businessDay(new Date(instant))).toBe(day);
  });

  it('counts a receipt at 00:30 Cairo as the next day, not the UTC one', () => {
    const received = businessDay(new Date('2026-10-01T21:30:00Z')); // 00:30 on Oct 2, Cairo
    const t = cycleTimeline(
      input({
        originType: 'UAE_DIRECT',
        status: 'SELLING',
        legs: [leg(1, ['2026-09-20'], ['2026-10-01'])],
        receivedOn: [received],
      }),
    );
    expect(step(t.steps, 'received-first').day).toBe('2026-10-02');
    expect(since(t.steps, 'received-first')).toBe('1 AFTER_ARRIVAL');
  });
});

describe('cycleTimeline — a China cycle from order to selling', () => {
  const t = cycleTimeline(
    input({
      status: 'SELLING',
      orderedOn: ['2026-08-03', '2026-08-01'],
      legs: [
        leg(1, ['2026-08-10'], ['2026-09-05']),
        leg(2, ['2026-09-12'], ['2026-10-08', '2026-10-01']),
      ],
      receivedOn: ['2026-10-09', '2026-10-02', '2026-10-02'],
      statusChanges: [
        { toStatus: 'PREPARING', day: '2026-08-04', recorded: true },
        { toStatus: 'SELLING', day: '2026-10-02', recorded: true },
      ],
    }),
  );

  it('lists the steps in the order of the process', () => {
    expect(t.steps.map((s) => s.key)).toEqual([
      'ordered',
      'leg1-departed-1',
      'leg1-delivered-1',
      'leg2-departed-1',
      'leg2-delivered-1',
      'leg2-delivered-2',
      'received-first',
      'received-last',
      'selling',
      'settlement',
      'closed',
    ]);
  });

  it('measures each step from the one it follows', () => {
    expect(step(t.steps, 'ordered').day).toBe('2026-08-01'); // the earliest order
    expect(since(t.steps, 'leg1-departed-1')).toBe('9 AFTER_ORDER');
    expect(since(t.steps, 'leg1-delivered-1')).toBe('26 ON_THE_WAY'); // China → UAE
    expect(since(t.steps, 'leg2-departed-1')).toBe('7 WAITED'); // in Dubai
    expect(since(t.steps, 'leg2-delivered-1')).toBe('19 ON_THE_WAY'); // UAE → 1st batch in Egypt
    expect(since(t.steps, 'leg2-delivered-2')).toBe('7 AFTER_FIRST');
    expect(since(t.steps, 'received-first')).toBe('1 AFTER_ARRIVAL');
    expect(since(t.steps, 'received-last')).toBe('7 AFTER_FIRST');
    expect(since(t.steps, 'selling')).toBe('0 AFTER_RECEIVED');
  });

  it('numbers the batches and marks the one that completed the leg', () => {
    const [first, second] = ['leg2-delivered-1', 'leg2-delivered-2'].map((k) =>
      step(t.steps, k),
    );
    expect([first.part, first.parts, first.completesLeg]).toEqual([
      1,
      2,
      false,
    ]);
    expect([second.part, second.parts, second.completesLeg]).toEqual([
      2,
      2,
      true,
    ]);
    // A leg that came in one delivery is not numbered or "completed".
    expect(step(t.steps, 'leg1-delivered-1').parts).toBe(1);
    expect(step(t.steps, 'leg1-delivered-1').completesLeg).toBe(false);
  });

  it('counts order to selling, and how long it has been selling so far', () => {
    expect(t.summary).toEqual({
      from: '2026-08-01',
      to: '2026-10-02',
      days: 62,
      until: 'SELLING',
    });
    expect(step(t.steps, 'settlement').state).toBe('UPCOMING');
    expect(step(t.steps, 'settlement').soFar).toEqual({
      days: 39,
      measure: 'SELLING_FOR',
      from: 'selling',
    });
    // Only the step under way counts "so far".
    expect(step(t.steps, 'closed').soFar).toBeNull();
  });

  it('marks a status dated from the audit log', () => {
    expect(step(t.steps, 'selling').recorded).toBe(true);
    expect(step(t.steps, 'ordered').recorded).toBe(false);
  });
});

describe('cycleTimeline — the limits', () => {
  it('a cycle with only an order: every later step is to come, and the total runs to today', () => {
    const t = cycleTimeline(input());
    const done = t.steps.filter((s) => s.state === 'DONE').map((s) => s.key);
    expect(done).toEqual(['ordered']);
    // The route's two legs are expected even though none is recorded, with the wizard's places.
    expect(step(t.steps, 'leg2-departed-1').leg?.origin).toBe('Dubai, UAE');
    expect(t.steps.every((s) => s.state === 'DONE' || s.day === null)).toBe(
      true,
    );
    expect(step(t.steps, 'leg1-departed-1').soFar).toEqual({
      days: 101,
      measure: 'AFTER_ORDER',
      from: 'ordered',
    });
    expect(t.summary).toEqual({
      from: '2026-08-01',
      to: TODAY,
      days: 101,
      until: 'TODAY',
    });
  });

  it('a cycle with nothing ordered has no total and invents no date', () => {
    const t = cycleTimeline(input({ status: 'PLANNING', orderedOn: [] }));
    expect(t.summary).toBeNull();
    expect(
      t.steps.every(
        (s) => s.state === 'UPCOMING' && s.day === null && s.since === null,
      ),
    ).toBe(true);
    expect(t.steps.every((s) => s.soFar === null)).toBe(true);
  });

  it('a UAE-direct cycle has one leg', () => {
    const t = cycleTimeline(input({ originType: 'UAE_DIRECT' }));
    expect(
      t.steps.filter((s) => s.kind === 'DEPARTED').map((s) => s.leg?.sequence),
    ).toEqual([1]);
    expect(step(t.steps, 'leg1-departed-1').leg?.origin).toBe('Dubai, UAE');
  });

  it('a delivery dated before its departure keeps its date and has no length — never a negative', () => {
    const t = cycleTimeline(
      input({
        originType: 'UAE_DIRECT',
        status: 'ARRIVED_EGYPT',
        legs: [leg(1, ['2026-09-20'], ['2026-09-15'])],
      }),
    );
    const delivered = step(t.steps, 'leg1-delivered-1');
    expect(delivered.day).toBe('2026-09-15');
    expect(delivered.since).toBeNull();
    expect(delivered.flag).toBe('BEFORE_PREVIOUS');
    expect(step(t.steps, 'leg1-departed-1').flag).toBeNull();
  });

  it('an order dated after selling began gives a total of 0, not a negative', () => {
    const t = cycleTimeline(
      input({
        status: 'SELLING',
        orderedOn: ['2026-10-20'],
        statusChanges: [
          { toStatus: 'SELLING', day: '2026-10-10', recorded: false },
        ],
      }),
    );
    expect(t.summary?.days).toBe(0);
  });

  it('never gives a negative length, whatever order the days come in', () => {
    // A small random walk of days, deliberately allowed to run backwards.
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const day = () => {
      const d = new Date(
        Date.UTC(2026, 6, 1) + Math.floor(rand() * 130) * 86_400_000,
      );
      return d.toISOString().slice(0, 10);
    };
    const statuses = [
      'PREPARING',
      'IN_TRANSIT',
      'ARRIVED_EGYPT',
      'SELLING',
      'SETTLEMENT',
      'CLOSED',
      'CANCELLED',
    ];
    for (let i = 0; i < 2000; i++) {
      const many = () => Array.from({ length: Math.floor(rand() * 4) }, day);
      const t = cycleTimeline(
        input({
          originType: rand() < 0.5 ? 'CHINA' : 'UAE_DIRECT',
          status: statuses[Math.floor(rand() * statuses.length)],
          orderedOn: many(),
          legs: [
            leg(1, many(), many()),
            ...(rand() < 0.5 ? [leg(2, many(), many())] : []),
          ],
          receivedOn: many(),
          statusChanges: statuses.map((s) => ({
            toStatus: s,
            day: day(),
            recorded: rand() < 0.5,
          })),
        }),
      );
      for (const s of t.steps) {
        if (s.since) expect(s.since.days).toBeGreaterThanOrEqual(0);
        if (s.soFar) expect(s.soFar.days).toBeGreaterThanOrEqual(0);
        if (s.state !== 'DONE') expect(s.day).toBeNull();
        if (s.flag) expect(s.since).toBeNull();
      }
      if (t.summary) expect(t.summary.days).toBeGreaterThanOrEqual(0);
      // Keys are unique: the screen keys its rows by them.
      expect(new Set(t.steps.map((s) => s.key)).size).toBe(t.steps.length);
    }
  });
});

describe('cycleTimeline — the shapes real cycles take', () => {
  it('legs entered out of order are shown in route order', () => {
    const t = cycleTimeline(
      input({
        status: 'IN_TRANSIT_TO_EGYPT',
        legs: [
          leg(2, ['2026-09-12'], [], { complete: false }),
          leg(1, ['2026-08-10'], ['2026-09-05']),
        ],
      }),
    );
    const legs = t.steps
      .filter((s) => s.leg)
      .map((s) => `${s.leg!.sequence}:${s.kind}`);
    expect(legs).toEqual([
      '1:DEPARTED',
      '1:DELIVERED',
      '2:DEPARTED',
      '2:DELIVERED',
    ]);
    expect(since(t.steps, 'leg2-departed-1')).toBe('7 WAITED');
    // The leg on its way counts its days so far.
    expect(step(t.steps, 'leg2-delivered-1').soFar).toEqual({
      days: 59,
      measure: 'ON_THE_WAY',
      from: 'leg2-departed-1',
    });
  });

  it('departures and deliveries in parts are numbered, the rest is still to come', () => {
    const t = cycleTimeline(
      input({
        status: 'IN_TRANSIT',
        legs: [
          leg(1, ['2026-08-20', '2026-08-10'], ['2026-09-05'], {
            waitingToLeave: true,
            complete: false,
          }),
        ],
      }),
    );
    expect(since(t.steps, 'leg1-departed-2')).toBe('10 AFTER_FIRST');
    const rest = step(t.steps, 'leg1-departed-rest');
    expect([rest.state, rest.rest, rest.day]).toEqual(['UPCOMING', true, null]);
    expect(step(t.steps, 'leg1-delivered-rest').state).toBe('UPCOMING');
    // "The rest" is never counted as the step under way.
    expect(rest.soFar).toBeNull();
    expect(step(t.steps, 'leg2-departed-1').soFar).toEqual({
      days: 66,
      measure: 'WAITED',
      from: 'leg1-delivered-1',
    });
  });

  it('leg 2 leaving between leg 1 batches waits from the batch that was there, not the later one', () => {
    const t = cycleTimeline(
      input({
        status: 'IN_TRANSIT_TO_EGYPT',
        legs: [
          leg(1, ['2026-08-10'], ['2026-09-01', '2026-09-20'], {
            complete: true,
          }),
          leg(2, ['2026-09-10'], [], { complete: false }),
        ],
      }),
    );
    // Left Dubai on Sep 10 — 9 days after the 1st batch, the one that was there.
    expect(since(t.steps, 'leg2-departed-1')).toBe('9 WAITED');
    expect(step(t.steps, 'leg2-departed-1').flag).toBeNull();
  });

  it('a cycle entered after the fact: skipped steps are "not recorded", not "next"', () => {
    const t = cycleTimeline(
      input({
        status: 'SELLING',
        legs: [],
        receivedOn: ['2026-10-02'],
        statusChanges: [
          { toStatus: 'SELLING', day: '2026-10-02', recorded: true },
        ],
      }),
    );
    expect(step(t.steps, 'leg1-departed-1').state).toBe('NOT_RECORDED');
    expect(step(t.steps, 'leg2-delivered-1').state).toBe('NOT_RECORDED');
    // Measured from the last step with a day instead, as "later".
    expect(since(t.steps, 'received-first')).toBe('62 LATER');
    expect(step(t.steps, 'settlement').state).toBe('UPCOMING');
  });

  it('a reversed settlement: selling dates from when it began, settlement is to come again', () => {
    const t = cycleTimeline(
      input({
        status: 'SELLING',
        receivedOn: ['2026-10-02'],
        legs: [
          leg(1, ['2026-08-10'], ['2026-09-05']),
          leg(2, ['2026-09-12'], ['2026-10-01']),
        ],
        statusChanges: [
          { toStatus: 'SELLING', day: '2026-10-02', recorded: false },
          { toStatus: 'SETTLEMENT', day: '2026-11-01', recorded: false },
          { toStatus: 'SELLING', day: '2026-11-03', recorded: false },
        ],
      }),
    );
    expect(step(t.steps, 'selling').day).toBe('2026-10-02');
    expect(step(t.steps, 'settlement')).toMatchObject({
      state: 'UPCOMING',
      day: null,
    });
    expect(t.summary?.to).toBe('2026-10-02');
  });

  it('a settled cycle: settlement after its days of selling, closed after that', () => {
    const t = cycleTimeline(
      input({
        status: 'CLOSED',
        receivedOn: ['2026-10-02'],
        legs: [
          leg(1, ['2026-08-10'], ['2026-09-05']),
          leg(2, ['2026-09-12'], ['2026-10-01']),
        ],
        statusChanges: [
          { toStatus: 'SELLING', day: '2026-10-02', recorded: false },
          { toStatus: 'SETTLEMENT', day: '2026-11-01', recorded: false },
          { toStatus: 'CLOSED', day: '2026-11-04', recorded: false },
        ],
      }),
    );
    expect(since(t.steps, 'settlement')).toBe('30 SELLING_FOR');
    expect(since(t.steps, 'closed')).toBe('3 LATER');
    expect(t.steps.some((s) => s.state === 'UPCOMING')).toBe(false);
  });

  it('a cancelled cycle shows what happened and nothing to come', () => {
    const t = cycleTimeline(
      input({
        status: 'CANCELLED',
        statusChanges: [
          { toStatus: 'CANCELLED', day: '2026-08-15', recorded: false },
        ],
      }),
    );
    expect(t.steps.map((s) => s.key)).toEqual(['ordered', 'cancelled']);
    expect(since(t.steps, 'cancelled')).toBe('14 LATER');
    expect(t.summary).toEqual({
      from: '2026-08-01',
      to: '2026-08-15',
      days: 14,
      until: 'CANCELLED',
    });
  });

  it('a step begun today counts nothing "so far" yet', () => {
    const t = cycleTimeline(
      input({
        status: 'SELLING',
        receivedOn: [TODAY],
        statusChanges: [{ toStatus: 'SELLING', day: TODAY, recorded: false }],
      }),
    );
    expect(step(t.steps, 'settlement').soFar).toBeNull();
    expect(t.steps.every((s) => s.soFar === null)).toBe(true);
  });

  it('a status reached with no row saying when is done, without a date', () => {
    const t = cycleTimeline(
      input({ status: 'SELLING', receivedOn: ['2026-10-02'] }),
    );
    expect(step(t.steps, 'selling')).toMatchObject({
      state: 'DONE',
      day: null,
      since: null,
    });
    // Selling with no day: the total runs to today rather than guessing one.
    expect(t.summary?.until).toBe('TODAY');
  });
});
