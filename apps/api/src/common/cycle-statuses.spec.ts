import { readFileSync } from 'fs';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the schema enum's runtime values are what this iterates
import { CycleStatus } from '@prisma/client';
import { BEFORE_SHIPPING, CYCLE_STATUSES } from './cycle-statuses';
import { VALID_TRANSITIONS } from './cycle-transitions';
import { forwardPath, stepsToward } from './status-follows-shipping';
import { ASSISTANT_TARGETS } from '../modules/assistant/tools/cycle';

/**
 * Every map over cycle statuses covers every status (Preparing, owner
 * 2026-10-27). A status missed in one map is the classic bug: it shows as a
 * raw code, a missing filter, a move that is never offered. These iterate the
 * schema's enum itself, so the next status added is checked the same way.
 */
const ALL = Object.values(CycleStatus) as string[];
const repo = join(__dirname, '..', '..', '..', '..');

describe('every cycle status, everywhere', () => {
  it('the one list is the schema enum, in order, with Preparing after Purchasing', () => {
    expect([...CYCLE_STATUSES].sort()).toEqual([...ALL].sort());
    expect(CYCLE_STATUSES.indexOf('PREPARING')).toBe(
      CYCLE_STATUSES.indexOf('PURCHASING') + 1,
    );
    expect(CYCLE_STATUSES.indexOf('IN_TRANSIT')).toBe(
      CYCLE_STATUSES.indexOf('PREPARING') + 1,
    );
  });

  it('before shipping is Planning through Preparing, and nothing else', () => {
    expect([...BEFORE_SHIPPING]).toEqual([
      'PLANNING',
      'FUNDING',
      'PURCHASING',
      'PREPARING',
    ]);
  });

  it.each(ALL)('%s: the transition table knows it', (status) => {
    // Every status but CANCELLED (final, nothing leaves it) has a row, and
    // every status but PLANNING (where a cycle starts) can be reached.
    if (status !== 'CANCELLED')
      expect(VALID_TRANSITIONS).toHaveProperty(status);
    if (status !== 'PLANNING') {
      expect(Object.values(VALID_TRANSITIONS).flat()).toContain(status);
    }
  });

  it.each(ALL)(
    '%s: the assistant can filter by it, and move to it unless settlements own it',
    (status) => {
      expect(CYCLE_STATUSES as readonly string[]).toContain(status);
      if (!['SETTLEMENT', 'CLOSED'].includes(status)) {
        expect(ASSISTANT_TARGETS as readonly string[]).toContain(status);
      }
    },
  );

  it('the walk to Egypt passes through every status before shipping, on both routes', () => {
    for (const route of ['CHINA', 'UAE_DIRECT']) {
      const path = forwardPath(route);
      expect(path.slice(0, BEFORE_SHIPPING.length)).toEqual([
        ...BEFORE_SHIPPING,
      ]);
      // Every step on the path is a move the table allows.
      for (let i = 1; i < path.length; i++) {
        expect(VALID_TRANSITIONS[path[i - 1]]).toContain(path[i]);
      }
    }
    expect(stepsToward('CHINA', 'PURCHASING', 'IN_TRANSIT')).toEqual([
      'PREPARING',
      'IN_TRANSIT',
    ]);
    expect(
      stepsToward('UAE_DIRECT', 'PURCHASING', 'IN_TRANSIT_TO_EGYPT'),
    ).toEqual(['PREPARING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']);
  });

  it('the stranded-drafts scripts count every status after Purchasing but Cancelled', () => {
    // Orders are confirmed on leaving Purchasing (§15): a draft on a cycle in
    // any of these is stranded.
    const before = BEFORE_SHIPPING as readonly string[];
    const placed = CYCLE_STATUSES.filter(
      (s) => s === 'PREPARING' || (!before.includes(s) && s !== 'CANCELLED'),
    );
    const sh = readFileSync(
      join(repo, 'scripts', 'confirm-stranded-orders.sh'),
      'utf8',
    );
    const shPast = /^PAST="([^"]+)"/m.exec(sh)![1].replace(/'/g, '').split(',');
    expect(shPast).toEqual(placed);

    const prod = readFileSync(join(repo, 'scripts', 'ship-prod.sh'), 'utf8');
    const prodPast = /const PAST = `\(\$\{\[([^\]]+)\]/
      .exec(prod)![1]
      .replace(/["\s]/g, '')
      .split(',');
    expect(prodPast).toEqual(placed);
  });
});
