/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Ledger reversals
 * ═══════════════════════════════════════════════════════════════════════
 *  Financial history is never rewritten (BRD 10): a correction is a
 *  balancing entry, and the guards stop that from being abused.
 */
import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001/api/v1';

async function auth(request: any) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: 'partner.a@motoparts.com', password: 'password123' },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

/** A hand-entered expense, the only kind reversible from the ledger. */
async function manualEntry(request: any, h: any, amount = 500) {
  const res = await request.post(`${API}/ledger`, {
    headers: h,
    data: {
      type: 'EXPENSE', category: 'other', direction: 'OUTFLOW',
      amount, currency: 'EGP', reason: 'test entry',
    },
  });
  return (await res.json()).data;
}

test.describe('Ledger reversals', () => {
  test('TC-LED-01: a reversal balances the original instead of deleting it', async ({ request }) => {
    const h = await auth(request);
    const entry = await manualEntry(request, h, 500);

    const res = await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: 'entered against the wrong month' },
    });
    expect(res.ok()).toBeTruthy();
    const reversal = (await res.json()).data;

    expect(reversal.direction).toBe(entry.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW');
    expect(Number(reversal.amount)).toBeCloseTo(Number(entry.amount), 2);
    expect(reversal.reversalOfId).toBe(entry.id);

    // The original must still be there: history survives.
    const still = await request.get(`${API}/ledger/${entry.id}`, { headers: h });
    expect(still.ok()).toBeTruthy();
  });

  test('TC-LED-02: reversing twice is refused', async ({ request }) => {
    const h = await auth(request);
    const entry = await manualEntry(request, h);

    await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: 'first correction' },
    });
    const second = await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: 'second correction' },
    });

    // Two balancing entries against one original would double-count.
    expect(second.status()).toBe(400);
    expect(JSON.stringify(await second.json())).toMatch(/already reversed/i);
  });

  test('TC-LED-03: a reversal cannot itself be reversed', async ({ request }) => {
    const h = await auth(request);
    const entry = await manualEntry(request, h);
    const reversal = (await (await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: 'correction' },
    })).json()).data;

    const res = await request.post(`${API}/ledger/${reversal.id}/reverse`, {
      headers: h, data: { reason: 'undo the undo' },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/itself a reversal/i);
  });

  test('TC-LED-04: an entry owned by a flow is not reversible on its own', async ({ request }) => {
    const h = await auth(request);
    const ledger = (await (await request.get(`${API}/ledger?limit=200`, { headers: h })).json()).data ?? [];
    const owned = ledger.find((e: any) => e.relatedType && !e.reversalOfId);
    test.skip(!owned, 'no flow-generated entries present');

    const res = await request.post(`${API}/ledger/${owned.id}/reverse`, {
      headers: h, data: { reason: 'trying to reverse a payout directly' },
    });
    // Reversing the line alone would leave the ledger and the settlement,
    // sale or payment it describes disagreeing.
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/belongs to a|reverse it from there/i);
  });

  test('TC-LED-05: a reason is required', async ({ request }) => {
    const h = await auth(request);
    const entry = await manualEntry(request, h);

    const res = await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('TC-LED-06: the pair nets to zero', async ({ request }) => {
    const h = await auth(request);
    const entry = await manualEntry(request, h, 750);
    await request.post(`${API}/ledger/${entry.id}/reverse`, {
      headers: h, data: { reason: 'nets to zero' },
    });

    const ledger = (await (await request.get(`${API}/ledger?limit=200`, { headers: h })).json()).data ?? [];
    const pair = ledger.filter((e: any) => e.id === entry.id || e.reversalOfId === entry.id);
    expect(pair).toHaveLength(2);

    const net = pair.reduce(
      (s: number, e: any) => s + (e.direction === 'OUTFLOW' ? -1 : 1) * Number(e.amount),
      0,
    );
    expect(net).toBeCloseTo(0, 2);
  });
});
