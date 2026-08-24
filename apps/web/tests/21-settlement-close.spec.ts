/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Settling and closing a cycle
 * ═══════════════════════════════════════════════════════════════════════
 *  Approving, paying and reversing used to be status flips: paying wrote
 *  nothing to the ledger, reversing undid nothing, and no cycle ever closed.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

/** A cycle that has stock and sales, so a settlement is meaningful. */
async function settleableCycle(request: any, h: any) {
  const cycles = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
  return cycles.find((c: any) => c.status !== 'CLOSED' && Number(c.totalRevenue) > 0);
}

async function cycleByCode(request: any, h: any, code: string) {
  const list = (await (await request.get(`${API}/cycles?limit=200`, { headers: h })).json()).data;
  return list.find((c: any) => c.code === code);
}

test.describe('Settlement close', () => {
  test('TC-SET-10: paying refuses while stock is still on the shelf', async ({ request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const target = await settleableCycle(request, h);
    test.skip(!target || Number(target.unitsRemaining) === 0, 'no open cycle with remaining stock');

    const cycle = await cycleByCode(request, h, target.cycleCode);
    const settlement = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;
    await request.post(`${API}/settlements/${settlement.id}/approve`, { headers: h });

    const paid = await request.post(`${API}/settlements/${settlement.id}/pay`, { headers: h, data: {} });
    expect(paid.status()).toBe(400);
    // Unsold stock keeps its cost with the cycle, so closing writes it off.
    expect(JSON.stringify(await paid.json())).toMatch(/still holds|remaining/i);

    await request.post(`${API}/settlements/${settlement.id}/reverse`, {
      headers: h, data: { reason: 'Reopened for a costing correction' },
    });
  });

  test('TC-SET-11: paying writes payouts that reconcile to capital plus profit', async ({ request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const target = await settleableCycle(request, h);
    test.skip(!target, 'no open cycle with sales');

    const cycle = await cycleByCode(request, h, target.cycleCode);
    const settlement = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;
    await request.post(`${API}/settlements/${settlement.id}/approve`, { headers: h });
    const paid = await request.post(`${API}/settlements/${settlement.id}/pay`, {
      headers: h, data: { acceptRemainingStock: true },
    });
    expect(paid.ok()).toBeTruthy();

    const body = (await paid.json()).data;
    expect(body.status).toBe('PAID');
    expect(body.cycle.status).toBe('CLOSED');

    const ledger = (await (await request.get(`${API}/ledger?limit=200`, { headers: h })).json()).data ?? [];
    const payouts = ledger.filter(
      (e: any) => e.relatedId === settlement.id && e.type === 'SETTLEMENT_PAYOUT',
    );
    expect(payouts.length).toBeGreaterThan(0);

    const capital = (settlement.lines ?? [])
      .filter((l: any) => l.component === 'CAPITAL_RETURN')
      .reduce((s: number, l: any) => s + Number(l.amount), 0);
    const totalPaid = payouts.reduce((s: number, e: any) => s + Number(e.amount), 0);

    // The fee line is a memo of a deduction already inside the profit share;
    // counting it again made the payouts disagree with the settlement screen.
    expect(totalPaid).toBeCloseTo(capital + Number(settlement.grossProfitEgp), 2);

    await request.post(`${API}/settlements/${settlement.id}/reverse`, {
      headers: h, data: { reason: 'Reopened for a costing correction' },
    });
  });

  test('TC-SET-12: a settled cycle recalculates to the same profit', async ({ request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const target = await settleableCycle(request, h);
    test.skip(!target, 'no open cycle with sales');

    const cycle = await cycleByCode(request, h, target.cycleCode);
    const first = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;
    await request.post(`${API}/settlements/${first.id}/approve`, { headers: h });
    await request.post(`${API}/settlements/${first.id}/pay`, {
      headers: h, data: { acceptRemainingStock: true },
    });
    await request.post(`${API}/settlements/${first.id}/reverse`, {
      headers: h, data: { reason: 'recalculate check' },
    });

    const second = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;
    // Paying out distributes profit already earned. Counting the payout as a
    // cycle expense turned an 11,620 profit into a 100,871 loss on the recalc.
    expect(Number(second.grossProfitEgp)).toBeCloseTo(Number(first.grossProfitEgp), 2);
    expect(Number(second.expensesEgp)).toBeCloseTo(Number(first.expensesEgp), 2);
  });

  test('TC-SET-13: reversing balances the ledger and reopens the cycle', async ({ request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const target = await settleableCycle(request, h);
    test.skip(!target, 'no open cycle with sales');

    const cycle = await cycleByCode(request, h, target.cycleCode);
    const settlement = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;
    await request.post(`${API}/settlements/${settlement.id}/approve`, { headers: h });
    await request.post(`${API}/settlements/${settlement.id}/pay`, {
      headers: h, data: { acceptRemainingStock: true },
    });

    const reversed = await request.post(`${API}/settlements/${settlement.id}/reverse`, {
      headers: h, data: { reason: 'agreed figures were wrong' },
    });
    expect(reversed.ok()).toBeTruthy();
    const body = (await reversed.json()).data;
    expect(body.status).toBe('REVERSED');
    expect(body.cycle.status).not.toBe('CLOSED');

    const ledger = (await (await request.get(`${API}/ledger?limit=200`, { headers: h })).json()).data ?? [];
    const mine = ledger.filter((e: any) => e.relatedId === settlement.id);
    const out = mine.filter((e: any) => e.direction === 'OUTFLOW').reduce((s: number, e: any) => s + Number(e.amount), 0);
    const back = mine.filter((e: any) => e.direction === 'INFLOW').reduce((s: number, e: any) => s + Number(e.amount), 0);

    // Financial history is never rewritten, so a reversal is a balancing entry
    // rather than a deletion: the pair must net to zero.
    expect(out).toBeCloseTo(back, 2);
  });

  test('TC-SET-14: reversing requires a reason', async ({ request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const target = await settleableCycle(request, h);
    test.skip(!target, 'no open cycle with sales');

    const cycle = await cycleByCode(request, h, target.cycleCode);
    const settlement = (await (await request.post(`${API}/settlements/calculate/${cycle.id}`, { headers: h })).json()).data;

    const res = await request.post(`${API}/settlements/${settlement.id}/reverse`, {
      headers: h, data: { reason: '' },
    });
    expect(res.status()).toBe(400);
  });
});
