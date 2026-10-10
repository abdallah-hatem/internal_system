import { describe, expect, it } from 'vitest';
import * as web from './sale-totals';
// The server's own file — the definition this copy must agree with.
import * as server from '../../../api/src/common/sale-totals';

/**
 * One definition, kept in two files (Next cannot import across apps).
 *
 * The order form's running total is only worth showing if it is the figure the
 * saved order will carry. This runs both copies over the same grid of lines —
 * fractional quantities, prices that do not sit well in binary, discounts up
 * to and past the line — and fails the moment one is changed without the other.
 */

const quantities = [0, 1, 2, 3, 0.5, 1.255, 7.333, 40, 999.999, '12', ''];
const prices = [0, 0.1, 0.29, 1.005, 19.99, 33.33, 250, 1234.56, '99.95'];
const discounts = [0, 0.01, 0.99, 5, 100, 9999, null, undefined, '2.50'];

describe('sale totals: the web copy equals the server', () => {
  it('every line in the grid comes to the same cents', () => {
    let checked = 0;
    for (const quantity of quantities)
      for (const unitPrice of prices)
        for (const discount of discounts) {
          const line = { quantity, unitPrice, discount };
          expect(web.saleLineTotals(line), JSON.stringify(line)).toEqual(
            server.saleLineTotals(line),
          );
          checked++;
        }
    expect(checked).toBe(quantities.length * prices.length * discounts.length);
  });

  it('a whole order with a discount comes to the same total', () => {
    const lines = [
      { quantity: 3, unitPrice: 33.33, discount: 0.99 },
      { quantity: 1.255, unitPrice: 19.99, discount: 5 },
      { quantity: 40, unitPrice: 250, discount: 1000 },
    ];
    expect(web.saleOrderTotals(lines)).toEqual(server.saleOrderTotals(lines));
    expect(web.saleOrderTotals(lines).subtotalCents).toBe(11909 + 900000);
  });

  it('writes cents the same way', () => {
    for (const cents of [0, 5, 99, 100, 11909, -989900]) {
      expect(web.centsToDecimalString(cents)).toBe(server.centsToDecimalString(cents));
    }
  });
});
