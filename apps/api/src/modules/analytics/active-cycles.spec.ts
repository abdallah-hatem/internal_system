import { ACTIVE_CYCLE_WHERE } from './analytics.service';

/**
 * The dashboard's Active cycles counts every cycle that is neither closed nor
 * cancelled (owner, 2026-10-17). It read 'CLOSED' alone, so a cancelled cycle
 * stayed active for good.
 */
const ALL = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
];
const counted = (statuses: string[]) => {
  const excluded = ACTIVE_CYCLE_WHERE.status.notIn as string[];
  return statuses.filter((s) => !excluded.includes(s));
};

describe('active cycles', () => {
  it('a cancelled cycle is not active, nor a closed one', () => {
    expect(counted(['CANCELLED', 'CLOSED'])).toEqual([]);
  });

  it('every cycle still running is active — settlement included, until it is closed', () => {
    expect(counted(ALL)).toEqual(
      ALL.filter((s) => s !== 'CLOSED' && s !== 'CANCELLED'),
    );
    expect(counted(['SETTLEMENT'])).toEqual(['SETTLEMENT']);
  });
});
