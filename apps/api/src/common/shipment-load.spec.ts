import { legsThatMustHaveDelivered } from './shipment-load';

/**
 * Which legs a cycle status needs a delivery on (§1's table, 2026-10-10). The
 * transition gate and deleting a delivery both read this one answer.
 */
describe('legsThatMustHaveDelivered', () => {
  it('a China cycle that reached the UAE needs a delivery on leg 1', () => {
    expect(legsThatMustHaveDelivered('CHINA', 'ARRIVED_UAE')).toEqual([
      'first',
    ]);
    expect(legsThatMustHaveDelivered('CHINA', 'IN_TRANSIT_TO_EGYPT')).toEqual([
      'first',
    ]);
  });

  it('any cycle that reached Egypt needs one on its last leg', () => {
    for (const status of [
      'ARRIVED_EGYPT',
      'VERIFICATION',
      'SELLING',
      'SETTLEMENT',
      'CLOSED',
    ]) {
      expect(legsThatMustHaveDelivered('UAE_DIRECT', status)).toEqual(['last']);
      expect(legsThatMustHaveDelivered('CHINA', status)).toEqual([
        'first',
        'last',
      ]);
    }
  });

  it('a UAE-direct cycle "arrived UAE" asks nothing: its one leg starts there', () => {
    expect(legsThatMustHaveDelivered('UAE_DIRECT', 'ARRIVED_UAE')).toEqual([]);
  });

  it('before anything arrives, and on a cancelled cycle, nothing is needed', () => {
    for (const status of [
      'PLANNING',
      'FUNDING',
      'PURCHASING',
      'IN_TRANSIT',
      'CANCELLED',
    ]) {
      expect(legsThatMustHaveDelivered('CHINA', status)).toEqual([]);
    }
  });
});
