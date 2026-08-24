import { badRequest, notFound, conflict, unauthorized } from './api-error';

/**
 * The contract between the API and every client: a stable code, an English
 * message that never goes missing, and params the client can phrase with.
 *
 * The failure worth guarding against is silent. If `code` stops arriving the
 * client falls back to English and nothing breaks visibly — the Arabic app just
 * quietly stops being Arabic. Same if `message` is dropped: a client that has
 * not heard of a new code shows an empty toast rather than an error.
 */
describe('api-error', () => {
  const body = (e: any) => e.getResponse();

  describe('the response body', () => {
    it('carries the code, the message and the status', () => {
      const e = badRequest('QTY_NOT_POSITIVE', 'A quantity must be greater than zero.');
      expect(e.getStatus()).toBe(400);
      expect(body(e)).toEqual({
        code: 'QTY_NOT_POSITIVE',
        message: 'A quantity must be greater than zero.',
      });
    });

    it('omits params entirely when there are none', () => {
      // An empty `params: {}` would read as "this message interpolates" to
      // anything inspecting the shape.
      expect(body(badRequest('X', 'y'))).not.toHaveProperty('params');
    });

    it('keeps params when given', () => {
      const e = badRequest('NOT_ENOUGH_STOCK', 'Only 3 in stock', {
        available: '3.000',
        product: 'Brake Pad Set',
      });
      expect(body(e).params).toEqual({ available: '3.000', product: 'Brake Pad Set' });
    });

    it('never drops the English message, whatever the code', () => {
      // The client's last resort. Without it an unrecognised code shows nothing.
      for (const e of [
        badRequest('A', 'alpha'),
        conflict('B', 'bravo'),
        unauthorized('C', 'charlie'),
        notFound('cycle'),
      ]) {
        expect(typeof body(e).message).toBe('string');
        expect(body(e).message.length).toBeGreaterThan(0);
      }
    });

    it('gives each helper its own status', () => {
      expect(badRequest('A', 'a').getStatus()).toBe(400);
      expect(conflict('A', 'a').getStatus()).toBe(409);
      expect(unauthorized('A', 'a').getStatus()).toBe(401);
      expect(notFound('cycle').getStatus()).toBe(404);
    });
  });

  describe('notFound', () => {
    it('passes the entity as a key, not as an English word', () => {
      // The client declines the noun itself. An English word here would be
      // pasted verbatim into an Arabic sentence.
      expect(body(notFound('purchaseOrderItem')).params).toEqual({
        entity: 'purchaseOrderItem',
      });
    });

    it('still reads as English in the fallback message', () => {
      // Built from the key, so it used to come out "purchaseOrderItem not
      // found" — the fallback is what a client with no translation shows.
      expect(body(notFound('purchaseOrderItem')).message).toBe(
        'Purchase order item not found',
      );
      expect(body(notFound('cycle')).message).toBe('Cycle not found');
    });

    it('uses one code for every entity', () => {
      // 57 throws collapsed into this. A per-entity code would need 57
      // translations of the same sentence.
      expect(body(notFound('cycle')).code).toBe('NOT_FOUND');
      expect(body(notFound('supplier')).code).toBe('NOT_FOUND');
    });

    it('lets a caller override the English without losing the entity', () => {
      const e = notFound('cycle', 'That import cycle is gone');
      expect(body(e).message).toBe('That import cycle is gone');
      expect(body(e).params).toEqual({ entity: 'cycle' });
    });
  });
});
