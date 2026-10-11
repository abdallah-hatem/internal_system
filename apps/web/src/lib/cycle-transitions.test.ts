import { describe, expect, it } from 'vitest';
import { VALID_TRANSITIONS, nextStatuses } from './cycle-transitions';
// The server's own file — the definition this copy must agree with.
import { VALID_TRANSITIONS as SERVER } from '../../../api/src/common/cycle-transitions';

/**
 * One rule, kept in two files (rule 11). The details page offers moves from
 * this copy and the server refuses from its own; if they drift, the button
 * offers a status that ends in a refusal, or hides one that is allowed.
 */
describe('cycle transitions', () => {
  it('is the same table the server enforces', () => {
    expect(VALID_TRANSITIONS).toEqual(SERVER);
  });

  it('offers what the table says for a known status', () => {
    expect(nextStatuses('SELLING')).toEqual(['SETTLEMENT']);
    expect(nextStatuses('PURCHASING')).toEqual(['IN_TRANSIT', 'ARRIVED_UAE', 'CANCELLED']);
  });

  it('offers nothing from a final, cancelled, unknown or missing status', () => {
    expect(nextStatuses('CLOSED')).toEqual([]);
    expect(nextStatuses('CANCELLED')).toEqual([]);
    expect(nextStatuses('NOT_A_STATUS')).toEqual([]);
    expect(nextStatuses('')).toEqual([]);
    expect(nextStatuses(undefined)).toEqual([]);
    expect(nextStatuses(null)).toEqual([]);
    // An inherited key is not a status.
    expect(nextStatuses('constructor')).toEqual([]);
  });
});
