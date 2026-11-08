import { SettlementsController } from './settlements.controller';
import { ROLES_KEY } from '../../common/guards/roles.guard';

/**
 * Who may pay out, reverse and read running costs (review, 2026-10-12). The
 * running costs themselves are shared to the selling cycles since 2026-11-08
 * (§8): `running-cost-allocation.db.spec.ts` holds that behaviour.
 */
describe('who may pay out or reverse (review, 2026-10-12)', () => {
  const roles = (name: 'markPaid' | 'reverse' | 'runningCosts') =>
    Reflect.getMetadata(
      ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its decorator metadata, never called
      SettlementsController.prototype[name],
    ) as string[];

  it('Mark paid and reversal are a core partner’s alone — not the office, not an investor', () => {
    expect(roles('markPaid')).toEqual(['CORE_PARTNER']);
    expect(roles('reverse')).toEqual(['CORE_PARTNER']);
  });

  it('the running costs are read by the partners and the office, never an investor', () => {
    expect(roles('runningCosts')).toEqual(['CORE_PARTNER', 'ADMIN_SUPPORT']);
  });
});
