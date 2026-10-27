import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BEFORE_SHIPPING, CYCLE_STATUSES } from './cycle-statuses';
import { VALID_TRANSITIONS, nextStatuses } from './cycle-transitions';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { STATUS_COLORS, STATUS_ORDER } from '@/components/views/cycles-view';
import { statusesToWalk, WIZARD_STATUSES } from '@/components/cycles/wizard-walk';
// The server's own file — the definition this copy must agree with.
import {
  BEFORE_SHIPPING as SERVER_BEFORE_SHIPPING,
  CYCLE_STATUSES as SERVER_STATUSES,
} from '../../../api/src/common/cycle-statuses';

/**
 * Every map over cycle statuses in the office app covers every status in the
 * schema (Preparing, owner 2026-10-27). It reads the enum out of
 * schema.prisma itself, so the next status added fails here until each map
 * has it — the classic bug being a status missed in one map: a raw code on a
 * badge, a filter chip that never appears, a move never offered.
 */
const schema = readFileSync(join(__dirname, '../../../api/prisma/schema.prisma'), 'utf8');
const ENUM = /enum CycleStatus \{([^}]+)\}/
  .exec(schema)![1]
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//'));

const labels = (locale: typeof en) => locale.codes.cycleStatus as Record<string, string>;

describe('every cycle status in the office app', () => {
  it('the schema enum is the list, in the server’s order', () => {
    expect(ENUM).toContain('PREPARING');
    expect([...CYCLE_STATUSES]).toEqual(ENUM);
    expect([...CYCLE_STATUSES]).toEqual([...SERVER_STATUSES]);
    expect([...BEFORE_SHIPPING]).toEqual([...SERVER_BEFORE_SHIPPING]);
  });

  it.each(ENUM)('%s has an English and an Arabic name', (status) => {
    for (const locale of [en, ar]) {
      const name = labels(locale)[status];
      expect(name, `${status} in ${locale === en ? 'en' : 'ar'}`).toBeTruthy();
      expect(name).not.toBe(status);
    }
    // Arabic is not an English copy.
    expect(labels(ar)[status]).not.toBe(labels(en)[status]);
  });

  it.each(ENUM)('%s has a badge colour and a filter chip', (status) => {
    expect(STATUS_COLORS[status]).toBeTruthy();
    expect(STATUS_ORDER).toContain(status);
  });

  it.each(ENUM)('%s is in the Change status table', (status) => {
    if (status !== 'CANCELLED') expect(Object.hasOwn(VALID_TRANSITIONS, status)).toBe(true);
    if (status !== 'PLANNING') expect(Object.values(VALID_TRANSITIONS).flat()).toContain(status);
  });

  it('Preparing badges differently from its neighbours', () => {
    expect(STATUS_COLORS.PREPARING).not.toBe(STATUS_COLORS.PURCHASING);
    expect(STATUS_COLORS.PREPARING).not.toBe(STATUS_COLORS.IN_TRANSIT);
  });

  it('Change status offers Preparing from Purchasing and the way on, or back, from it', () => {
    expect(nextStatuses('PURCHASING')).toEqual(['PREPARING', 'CANCELLED']);
    expect(nextStatuses('PREPARING')).toEqual(['IN_TRANSIT', 'ARRIVED_UAE', 'PURCHASING', 'CANCELLED']);
  });

  it('the wizard passes through Preparing on a departure, and stops at Purchasing without one', () => {
    const left = [{ sequence: 1, departedOn: '2026-10-01', status: 'IN_TRANSIT' }];
    expect(statusesToWalk('CHINA', 'PURCHASING', left)).toEqual(['PREPARING', 'IN_TRANSIT']);
    expect(statusesToWalk('UAE_DIRECT', 'PURCHASING', left)).toEqual([
      'PREPARING',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
    ]);
    expect(statusesToWalk('CHINA', 'PURCHASING', [{ sequence: 1, departedOn: null }])).toEqual([]);
    // Preparing's orders are confirmed: the wizard is not reopened on it.
    expect(WIZARD_STATUSES).not.toContain('PREPARING');
  });
});
