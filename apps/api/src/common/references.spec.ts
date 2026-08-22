import { nextReferenceNumber, pad } from './references';

describe('nextReferenceNumber', () => {
  it('starts at one when nothing has been issued', () => {
    expect(nextReferenceNumber(null, 4)).toBe(1);
    expect(nextReferenceNumber(undefined, 4)).toBe(1);
  });

  it('continues from the highest reference, not the count', () => {
    // The bug: with 0001, 0002 and 0004 present, counting gives three and the
    // next cycle is handed 0004 — which already exists.
    expect(nextReferenceNumber('CYC-2026-0004', 4)).toBe(5);
  });

  it('handles the wider references too', () => {
    expect(nextReferenceNumber('ORD-2026-00042', 5)).toBe(43);
    expect(nextReferenceNumber('PRD-000007', 6)).toBe(8);
  });

  it('falls back to one on something unparseable', () => {
    expect(nextReferenceNumber('CYC-2026-XXXX', 4)).toBe(1);
  });

  it('pads back to the width it came from', () => {
    expect(pad(5, 4)).toBe('0005');
    expect(pad(43, 5)).toBe('00043');
    // Past the width it simply gets longer rather than truncating, which would
    // silently collide.
    expect(pad(12345, 4)).toBe('12345');
  });
});
