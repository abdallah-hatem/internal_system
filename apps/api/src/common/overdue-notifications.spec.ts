import {
  overdueNotificationsToSend,
  type OverdueInstalment,
} from './overdue-notifications';

/**
 * Who is told about which overdue instalment (BUSINESS_LOGIC §7, DECIDED
 * 2026-10-11): every active core partner, once per instalment, ever.
 */

const inst = (
  id: string,
  extra: Partial<OverdueInstalment> = {},
): OverdueInstalment => ({
  instalmentId: id,
  planId: 'plan-1',
  customerId: 'cust-1',
  customer: 'El-Sayed Motors',
  reference: 'PLAN-2026-0001',
  dueOn: '2026-10-01',
  outstandingEgp: '1000.00',
  ...extra,
});

describe('overdueNotificationsToSend', () => {
  it('first run: every partner hears about every overdue instalment', () => {
    const out = overdueNotificationsToSend(
      [inst('i1'), inst('i2')],
      ['a', 'b'],
      [],
    );

    expect(out.map((o) => [o.instalment.instalmentId, o.userIds])).toEqual([
      ['i1', ['a', 'b']],
      ['i2', ['a', 'b']],
    ]);
  });

  it('second run with nothing new: nothing is sent', () => {
    const sent = [
      { userId: 'a', instalmentId: 'i1' },
      { userId: 'b', instalmentId: 'i1' },
    ];
    expect(overdueNotificationsToSend([inst('i1')], ['a', 'b'], sent)).toEqual(
      [],
    );
  });

  it('a partner who already heard is skipped; one who has not (added since) is told', () => {
    const out = overdueNotificationsToSend(
      [inst('i1')],
      ['a', 'c'],
      [{ userId: 'a', instalmentId: 'i1' }],
    );
    expect(out).toEqual([{ instalment: inst('i1'), userIds: ['c'] }]);
  });

  it('a later instalment falling behind is new, though its plan was notified before', () => {
    const out = overdueNotificationsToSend(
      [inst('i1'), inst('i2', { dueOn: '2026-10-08' })],
      ['a'],
      [{ userId: 'a', instalmentId: 'i1' }],
    );
    expect(out.map((o) => o.instalment.instalmentId)).toEqual(['i2']);
  });

  it('no partners: nothing to send (and no empty createMany)', () => {
    expect(overdueNotificationsToSend([inst('i1')], [], [])).toEqual([]);
  });

  it('no overdue instalments: nothing to send', () => {
    expect(overdueNotificationsToSend([], ['a'], [])).toEqual([]);
  });

  it('the same instalment listed twice is still notified once per partner', () => {
    const out = overdueNotificationsToSend([inst('i1'), inst('i1')], ['a'], []);
    expect(out).toEqual([{ instalment: inst('i1'), userIds: ['a'] }]);
  });

  it('the same partner listed twice is told once', () => {
    const out = overdueNotificationsToSend([inst('i1')], ['a', 'a'], []);
    expect(out).toEqual([{ instalment: inst('i1'), userIds: ['a'] }]);
  });

  it("a notification for one instalment does not silence another partner's or another instalment's", () => {
    const out = overdueNotificationsToSend(
      [inst('i1'), inst('i2')],
      ['a', 'b'],
      [
        { userId: 'a', instalmentId: 'i2' },
        { userId: 'b', instalmentId: 'i1' },
      ],
    );
    expect(out).toEqual([
      { instalment: inst('i1'), userIds: ['a'] },
      { instalment: inst('i2'), userIds: ['b'] },
    ]);
  });
});
