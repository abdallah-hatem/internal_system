/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A partner can see what an open cycle has earned them
 * ═══════════════════════════════════════════════════════════════════════
 *  Profit only counted once a settlement was PAID, so a partner on a cycle that
 *  was actively selling saw capital in, profit zero — money had clearly been
 *  made and none of it was visible to the people who funded it.
 *
 *  What is shown is a share of PROFIT, not of revenue. A partner does not earn
 *  revenue: the cycle does, and most of it repays the goods. Showing collected
 *  revenue per partner would overstate what they are owed by roughly the cost
 *  of the stock.
 *
 *  It runs the settlement's own projection, so the figure converges on the real
 *  one rather than contradicting it — which is the property most of what
 *  follows is about.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const num = (v: any) => Number(v ?? 0);

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const participation = async (request: any) => {
  const { headers } = await apiCtx(request);
  return (await (await request.get(`${API}/users/participation`, { headers })).json()).data;
};

test.describe('Accrued profit', () => {
  test('TC-ACC-01: an open cycle that has sold shows a share, not zero', async ({
    request,
  }) => {
    const people = await participation(request);
    const withOpen = people.filter((p: any) => p.openCycleCount > 0);
    test.skip(withOpen.length === 0, 'no open cycles in this database');

    // At least one of them is on a cycle that has made money.
    expect(withOpen.some((p: any) => p.accruedProfitEgp !== 0)).toBeTruthy();
  });

  test('TC-ACC-02: the shares add up to the cycle profit, not to revenue', async ({
    request,
  }) => {
    // The mistake this guards: crediting each partner with revenue received.
    // That would total the cycle's revenue, several times the profit.
    const { headers } = await apiCtx(request);
    const people = await participation(request);

    const cycles = await (await request.get(`${API}/cycles?limit=50`, { headers })).json();
    const open = (cycles.data?.items ?? cycles.data ?? []).filter(
      (c: any) => c.status !== 'CLOSED',
    );
    test.skip(open.length === 0, 'no open cycles');

    for (const cycle of open) {
      const shares = people
        .flatMap((p: any) => p.cycles)
        .filter((c: any) => c.id === cycle.id)
        .reduce((s: number, c: any) => s + num(c.accruedProfitEgp), 0);

      const preview = await request.get(`${API}/settlements/preview/${cycle.id}`, {
        headers,
      });
      if (!preview.ok()) continue;
      const body = (await preview.json()).data ?? (await preview.json());
      const profit = num(body.grossProfitEgp ?? body.grossProfit);

      // Fees move between participants, so the parts re-sum to the whole.
      expect(shares).toBeCloseTo(profit, 1);
    }
  });

  test('TC-ACC-03: a closed cycle reports what was paid, never a projection', async ({
    request,
  }) => {
    // Two numbers for the same finished cycle would just disagree with each
    // other, and the settled one is the truth.
    const people = await participation(request);
    for (const person of people) {
      for (const cycle of person.cycles) {
        if (cycle.status === 'CLOSED') {
          expect(cycle.accruedProfitEgp).toBe(0);
        }
      }
    }
  });

  test('TC-ACC-04: a cycle that has sold nothing accrues nothing', async ({
    request,
  }) => {
    // A brand new cycle must not invent a profit out of its capital.
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    const people = await participation(request);
    const rows = people.flatMap((p: any) => p.cycles).filter((c: any) => c.id === cycle.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.accruedProfitEgp).toBe(0);
  });

  test('TC-ACC-05: accrued and paid are kept apart', async ({ request }) => {
    // They answer different questions — what the cycle has made, and what has
    // actually reached the partner. Folding them into one number would let a
    // projection be read as money in hand.
    const people = await participation(request);
    for (const person of people) {
      expect(person).toHaveProperty('accruedProfitEgp');
      expect(person).toHaveProperty('profitShareEgp');

      // A cycle contributes to one or the other, never both.
      for (const cycle of person.cycles) {
        expect(
          cycle.profitShareEgp !== 0 && cycle.accruedProfitEgp !== 0,
          `${cycle.code} counted twice`,
        ).toBeFalsy();
      }
    }
  });

  test('TC-ACC-06: someone who is both partner and investor keeps both', async ({
    request,
  }) => {
    // The entry list used to be picked by the user's ROLE, so a core partner
    // who also put money in as an investor had that participation dropped
    // entirely — the cycle vanished from their list and its capital from their
    // totals. The demo data does exactly this.
    //
    // Checked against the cycles themselves, not against the summary's own
    // arithmetic. An earlier version compared the totals to the cycle list, and
    // both came from the same dropped entries — self-consistent, both wrong,
    // and it passed against the bug it was written for.
    const { headers } = await apiCtx(request);
    const people = await participation(request);

    const cycles = await (await request.get(`${API}/cycles?limit=50`, { headers })).json();
    const list = cycles.data?.items ?? cycles.data ?? [];
    // Only the cycles this page actually returned. Run on its own there are a
    // handful and the limit is irrelevant; run as part of the whole suite there
    // are hundreds, so the expectation was built from a truncated list and a
    // participation the summary reported correctly looked like an extra.
    const fetched = new Set<string>(list.map((c: any) => c.id));

    // Every participation the API knows about, per user, straight from source.
    const expected = new Map<string, { cycles: Set<string>; capital: number }>();
    for (const c of list) {
      const detail = await (await request.get(`${API}/cycles/${c.id}`, { headers })).json();
      for (const p of (detail.data ?? detail).participants ?? []) {
        const userId = p.partnerUserId ?? p.investorUserId;
        if (!userId) continue;
        // Summed, not overwritten: the same person can hold two participant
        // rows on one cycle — a core partner who also invested — and both
        // contributions are real money.
        const entry = expected.get(userId) ?? { cycles: new Set<string>(), capital: 0 };
        entry.cycles.add(c.id);
        entry.capital += num(p.contributionAmount);
        expected.set(userId, entry);
      }
    }
    expect(expected.size).toBeGreaterThan(0);

    for (const person of people) {
      const want = expected.get(person.id) ?? { cycles: new Set<string>(), capital: 0 };
      const all = person.cycles.map((c: any) => c.id);
      const got = all.filter((id: string) => fetched.has(id));

      // One row per cycle. Two participant rows on the same cycle are legal —
      // a core partner who also invested — and their money is summed, but the
      // cycle is still one cycle and must not be listed or counted twice.
      expect(new Set(all).size, `${person.email} lists a cycle twice`).toBe(all.length);
      expect(
        [...got].sort(),
        `${person.email} is missing a participation`,
      ).toEqual([...want.cycles].sort());

      // Capital, over the same subset — the summary totals every cycle, so
      // comparing it against a partial list would only ever agree by luck.
      const capital = person.cycles
        .filter((c: any) => fetched.has(c.id))
        .reduce((sum: number, c: any) => sum + num(c.contributionEgp), 0);
      expect(capital).toBeCloseTo(want.capital, 2);
      expect(person.cycleCount).toBe(all.length);
    }
  });

  test('TC-ACC-07: the figure reaches the page, labelled as not yet paid', async ({
    page,
    request,
  }) => {
    const people = await participation(request);
    const earner = people.find((p: any) => p.accruedProfitEgp !== 0);
    test.skip(!earner, 'nothing accrued in this database');

    await login(page);
    await page.goto(`${BASE}/en/partners`);
    await expect(page.getByText('Earned so far').first()).toBeVisible({ timeout: 15000 });

    const text = await page.locator('main').innerText();
    const shown = earner.accruedProfitEgp.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(text).toContain(shown);
    // And it says plainly that this is not money in hand.
    expect(text).toContain('not yet paid out');
  });
});

test.describe('Capital movement is not a cycle expense', () => {
  test('TC-ACC-08: handing capital back does not reduce the cycle profit', async ({
    request,
  }) => {
    // Lowering a contribution posts an outflow. It was not in the capitalised
    // list, so it was read as an operating expense and came straight off the
    // cycle's profit — the partners would have paid for their own money being
    // returned.
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const participant = (detail.data ?? detail).participants[0];

    const profitOf = async () => {
      const res = await request.get(`${API}/settlements/preview/${cycle.id}`, { headers });
      if (!res.ok()) return null;
      const body = (await res.json()).data ?? {};
      return num(body.grossProfitEgp ?? body.grossProfit);
    };

    await request.put(`${API}/cycles/participants/${participant.id}`, {
      headers,
      data: { contributionAmount: 10000 },
    });
    const before = await profitOf();
    test.skip(before === null, 'cycle cannot be previewed yet');

    // Hand half of it back.
    await request.put(`${API}/cycles/participants/${participant.id}`, {
      headers,
      data: { contributionAmount: 5000 },
    });

    expect(await profitOf()).toBeCloseTo(before as number, 2);
  });
});
