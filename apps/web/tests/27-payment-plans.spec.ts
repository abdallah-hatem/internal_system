/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Instalment plans and overdue
 * ═══════════════════════════════════════════════════════════════════════
 *  A plan is agreed per shop against its running balance, with whatever
 *  amounts were agreed on whatever dates. Progress is cumulative: what
 *  matters on any day is whether the shop has paid what it promised by then.
 */
import { test, expect } from '@playwright/test';
import { apiCtx, stockedProduct, owedOrder } from './support/fixtures';

const API = 'http://localhost:3001/api/v1';

async function auth(request: any) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: 'partner.a@motoparts.com', password: 'password123' },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

/**
 * A shop that owes money, and nothing else.
 *
 * These tests used to build a shop with no history at all, on the grounds that
 * nothing would then colour the arithmetic. But a plan schedules a debt, and a
 * shop with no debt has nothing to schedule — the API used to allow the plan
 * anyway and then refuse every payment into it, which is the contradiction
 * this suite was quietly built on top of.
 *
 * The debt is far larger than any plan here, so no test trips the separate
 * rule about promising more than is owed.
 */
async function freshCustomer(request: any, h: any, label: string) {
  const { mk } = await apiCtx(request);
  const customer = await mk('customers', {
    displayName: `${label} ${Date.now()}`,
    type: 'B2B',
  });
  const { product } = await stockedProduct(request, h, mk, `${label}-stock`, 10);
  await owedOrder(mk, customer.id, product.id, 100_000);
  return customer;
}

/**
 * A calendar day, YYYY-MM-DD, built from local parts.
 *
 * Not toISOString(): that converts local midnight to UTC, which lands on the
 * previous day at any positive offset — so iso(0) quietly meant yesterday and
 * an instalment "due today" was scheduled for the day before.
 */
const iso = (daysFromToday: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysFromToday);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
};

test.describe('Instalment plans', () => {
  test('TC-PLAN-01: amounts are whatever was agreed, not equal splits', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Uneven');

    // The shape the owner described: 10,000 up front, then 1,000 / 5,000 / 4,000.
    const res = await request.post(`${API}/payment-plans`, {
      headers: h,
      data: {
        customerId: customer.id,
        agreedOn: iso(0),
        instalments: [
          { dueOn: iso(0), amount: 10000, note: 'upfront' },
          { dueOn: iso(7), amount: 1000 },
          { dueOn: iso(14), amount: 5000 },
          { dueOn: iso(21), amount: 4000 },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const plan = (await res.json()).data;

    expect(Number(plan.totalEgp)).toBeCloseTo(20000, 2);
    expect(plan.instalments.map((i: any) => Number(i.amount))).toEqual([10000, 1000, 5000, 4000]);
    // Due today is not overdue until tomorrow.
    expect(plan.instalments[0].state).toBe('DUE');
    expect(plan.isOverdue).toBe(false);
  });

  test('TC-PLAN-02: a missed instalment is overdue by the shortfall', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Behind');

    const plan = (await (await request.post(`${API}/payment-plans`, {
      headers: h,
      data: {
        customerId: customer.id,
        agreedOn: iso(-21),
        instalments: [
          { dueOn: iso(-14), amount: 3000 },
          { dueOn: iso(-7), amount: 2000 },
          { dueOn: iso(7), amount: 5000 },
        ],
      },
    })).json()).data;

    // Both past dates unpaid; the future one is not yet owed.
    expect(Number(plan.overdueEgp)).toBeCloseTo(5000, 2);
    expect(plan.isOverdue).toBe(true);
    expect(plan.instalments.map((i: any) => i.state)).toEqual(['OVERDUE', 'OVERDUE', 'UPCOMING']);
  });

  test('TC-PLAN-03: paying early covers later instalments, and clears nothing twice', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Ahead');

    const plan = (await (await request.post(`${API}/payment-plans`, {
      headers: h,
      data: {
        customerId: customer.id,
        agreedOn: iso(-7),
        instalments: [
          { dueOn: iso(-1), amount: 1000 },
          { dueOn: iso(7), amount: 5000 },
          { dueOn: iso(14), amount: 4000 },
        ],
      },
    })).json()).data;
    expect(Number(plan.overdueEgp)).toBeCloseTo(1000, 2);

    // Pays 6,000: covers the missed 1,000 and the whole of the next.
    await request.post(`${API}/payments`, {
      headers: h,
      data: { customerId: customer.id, amount: 6000, currency: 'EGP', method: 'CASH' },
    });

    const after = (await (await request.get(`${API}/payment-plans/${plan.id}`, { headers: h })).json()).data;
    // A shop that pays late but generously is square, not still flagged.
    expect(Number(after.overdueEgp)).toBeCloseTo(0, 2);
    expect(after.isOverdue).toBe(false);
    expect(after.instalments[0].state).toBe('PAID');
    expect(after.instalments[1].state).toBe('PAID');
    expect(Number(after.remainingEgp)).toBeCloseTo(4000, 2);
  });

  test('TC-PLAN-04: only one active plan per customer', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Double');

    const body = {
      customerId: customer.id,
      instalments: [{ dueOn: iso(7), amount: 1000 }],
    };
    expect((await request.post(`${API}/payment-plans`, { headers: h, data: body })).ok()).toBeTruthy();

    const second = await request.post(`${API}/payment-plans`, { headers: h, data: body });
    // Two schedules would both claim the same payments.
    expect(second.status()).toBe(400);
    expect(JSON.stringify(await second.json())).toMatch(/already has an active plan/i);
  });

  test('TC-PLAN-05: a plan cannot promise more than the shop owes', async ({ request }) => {
    const h = await auth(request);

    // Its own shop. Hunting the database for any outstanding order found one
    // that the tests above had already given a plan, so this refused with
    // "already has an active plan" — the right status for the wrong reason,
    // and dependent on the order the tests happened to run in.
    const customer = await freshCustomer(request, h, 'Overpromise');

    const res = await request.post(`${API}/payment-plans`, {
      headers: h,
      data: {
        customerId: customer.id,
        instalments: [{ dueOn: iso(7), amount: 500_000 }],
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('INSTALMENTS_EXCEED_OWED');
  });

  test('TC-PLAN-08: a shop that owes nothing cannot be given a plan', async ({
    request,
  }) => {
    // The contradiction this suite was built on top of. The check for
    // over-promising was guarded on `owed > 0`, so a shop with no debt skipped
    // it and any plan was accepted — then every payment into that plan was
    // refused with "does not owe anything, so there is nothing to pay".
    // Agreed and unusable, with nothing on screen explaining why.
    const h = await auth(request);
    const debtless = (await (await request.post(`${API}/customers`, {
      headers: h,
      data: { displayName: `Debtless ${Date.now()}`, type: 'B2B' },
    })).json()).data;

    const res = await request.post(`${API}/payment-plans`, {
      headers: h,
      data: { customerId: debtless.id, instalments: [{ dueOn: iso(7), amount: 1000 }] },
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('NOTHING_TO_SCHEDULE');
  });

  test('TC-PLAN-06: a plan needs at least one positive instalment', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Invalid');

    for (const instalments of [[], [{ dueOn: iso(7), amount: 0 }], [{ dueOn: iso(7), amount: -100 }]]) {
      const res = await request.post(`${API}/payment-plans`, {
        headers: h, data: { customerId: customer.id, instalments },
      });
      expect(res.status()).toBe(400);
    }
  });

  test('TC-PLAN-07: overdue plans are summarised and notified', async ({ request }) => {
    const h = await auth(request);
    const customer = await freshCustomer(request, h, 'Notify');

    await request.post(`${API}/payment-plans`, {
      headers: h,
      data: {
        customerId: customer.id,
        agreedOn: iso(-14),
        instalments: [{ dueOn: iso(-7), amount: 2500 }],
      },
    });

    const summary = (await (await request.get(`${API}/payment-plans/overdue`, { headers: h })).json()).data;
    expect(Number(summary.totalOverdueEgp)).toBeGreaterThanOrEqual(2500);
    expect(summary.plans.some((p: any) => p.customer.id === customer.id)).toBeTruthy();

    // Flag and notify is the whole of V1: nothing is blocked, nothing is charged.
    const notes = (await (await request.get(`${API}/notifications`, { headers: h })).json()).data ?? [];
    expect(notes.some((n: any) => n.eventType === 'PAYMENT_OVERDUE')).toBeTruthy();
  });
});
