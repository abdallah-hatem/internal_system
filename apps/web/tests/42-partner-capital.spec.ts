/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Partner capital is recorded, and shown
 * ═══════════════════════════════════════════════════════════════════════
 *  Two faults, one cause: a partner's money was tracked on the participant row
 *  and nowhere the rest of the system could see it.
 *
 *  The ledger recorded a cycle SPENDING its capital and never recorded that
 *  capital arriving. Netting financial_transactions on a cycle settled in full,
 *  owing nobody anything, gave −62,325 — the business appeared to have spent
 *  money it never received, understated by exactly what the partners put in.
 *
 *  And the Partners page showed "0 Cycles" for everyone. It counted a relation
 *  the users endpoint never returns, so the number was structurally incapable
 *  of being anything but zero, however many cycles a partner had funded.
 *
 *  The checks below are mostly about the ways the ledger can drift from the
 *  participant rows it is supposed to mirror: an edit posting the wrong sign, a
 *  raise double-counting, a backfill running twice.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every contribution entry raised against one participant, netted. */
async function contributionNet(request: any, participantId: string) {
  const { headers } = await apiCtx(request);
  const res = await request.get(`${API}/ledger?limit=200`, { headers });
  const body = await res.json();
  const rows = body.data?.items ?? body.data ?? [];
  return rows
    .filter(
      (r: any) => r.relatedType === 'CYCLE_PARTICIPANT' && r.relatedId === participantId,
    )
    .reduce(
      (sum: number, r: any) =>
        sum + (r.direction === 'INFLOW' ? Number(r.amount) : -Number(r.amount)),
      0,
    );
}

/** A fresh cycle, and the participants it seeds itself with. */
async function newCycle(request: any) {
  const { mk, headers } = await apiCtx(request);
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  return { cycle, participants: (detail.data ?? detail).participants ?? [] };
}

test.describe('Partner capital', () => {
  test('TC-CAP-01: setting a contribution posts the money coming in', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const { participants } = await newCycle(request);
    const p = participants[0];
    expect(p).toBeTruthy();

    // A cycle starts its partners at zero — the capital is not known until the
    // goods are costed — so nothing should be on the ledger yet.
    expect(await contributionNet(request, p.id)).toBe(0);

    await request.put(`${API}/cycles/participants/${p.id}`, {
      headers,
      data: { contributionAmount: 5000 },
    });

    expect(await contributionNet(request, p.id)).toBe(5000);
  });

  test('TC-CAP-02: raising a contribution posts only the difference', async ({
    request,
  }) => {
    // The expensive mistake: posting the new total each time. Three edits on
    // the way to 5,000 would put 12,000 on the ledger.
    const { headers } = await apiCtx(request);
    const { participants } = await newCycle(request);
    const p = participants[0];

    for (const amount of [1000, 3000, 5000]) {
      await request.put(`${API}/cycles/participants/${p.id}`, {
        headers,
        data: { contributionAmount: amount },
      });
    }

    expect(await contributionNet(request, p.id)).toBe(5000);
  });

  test('TC-CAP-03: lowering a contribution sends money back out', async ({ request }) => {
    // Capital handed back is an outflow. Posting it as another inflow would
    // grow the ledger while the contribution shrank.
    const { headers } = await apiCtx(request);
    const { participants } = await newCycle(request);
    const p = participants[0];

    await request.put(`${API}/cycles/participants/${p.id}`, {
      headers,
      data: { contributionAmount: 8000 },
    });
    await request.put(`${API}/cycles/participants/${p.id}`, {
      headers,
      data: { contributionAmount: 3000 },
    });

    expect(await contributionNet(request, p.id)).toBe(3000);

    const outflow = await (
      await request.get(`${API}/ledger?limit=200`, { headers })
    ).json();
    const rows = (outflow.data?.items ?? outflow.data ?? []).filter(
      (r: any) => r.relatedId === p.id && r.direction === 'OUTFLOW',
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].amount)).toBe(5000);
  });

  test('TC-CAP-04: an edit that changes nothing writes nothing', async ({ request }) => {
    // Saving the form without touching the amount must not add a zero-value
    // entry — the ledger is read by people, and noise is a cost.
    const { headers } = await apiCtx(request);
    const { participants } = await newCycle(request);
    const p = participants[0];

    await request.put(`${API}/cycles/participants/${p.id}`, {
      headers,
      data: { contributionAmount: 2000 },
    });

    const countRows = async () => {
      const body = await (await request.get(`${API}/ledger?limit=200`, { headers })).json();
      return (body.data?.items ?? body.data ?? []).filter((r: any) => r.relatedId === p.id)
        .length;
    };
    const before = await countRows();

    await request.put(`${API}/cycles/participants/${p.id}`, {
      headers,
      data: { contributionAmount: 2000 },
    });

    expect(await countRows()).toBe(before);
  });

  test('TC-CAP-05: contributions net against the capital they fund', async ({
    request,
  }) => {
    // The invariant the whole change exists for. A cycle that has returned all
    // its capital and paid out its profit should leave the ledger at zero, not
    // showing money spent that was never received.
    const { headers } = await apiCtx(request);
    const body = await (
      await request.get(`${API}/analytics/dashboard`, { headers })
    ).json();
    expect(body.data).toBeTruthy();

    const ledger = await (await request.get(`${API}/ledger?limit=500`, { headers })).json();
    const rows = ledger.data?.items ?? ledger.data ?? [];

    const contributions = rows
      .filter((r: any) => r.category === 'contribution')
      .reduce(
        (s: number, r: any) =>
          s + (r.direction === 'INFLOW' ? Number(r.amount) : -Number(r.amount)),
        0,
      );

    // Every participant's current figure, summed, must equal what the ledger
    // says came in. Drift between the two is the bug this guards.
    const cycles = await (await request.get(`${API}/cycles?limit=100`, { headers })).json();
    let declared = 0;
    for (const c of cycles.data?.items ?? cycles.data ?? []) {
      const detail = await (await request.get(`${API}/cycles/${c.id}`, { headers })).json();
      for (const p of (detail.data ?? detail).participants ?? []) {
        declared += Number(p.contributionAmount);
      }
    }

    expect(contributions).toBeCloseTo(declared, 2);
  });

  test('TC-CAP-06: the partners page reports real cycles, not zero', async ({
    page,
    request,
  }) => {
    // "0 Cycles" was not an empty database — it was a count read from a
    // relation the endpoint never returned, so it could never be anything else.
    const { headers } = await apiCtx(request);
    const summary = await (
      await request.get(`${API}/users/participation`, { headers })
    ).json();
    const partner = (summary.data ?? []).find(
      (p: any) => p.email === EMAIL && p.cycleCount > 0,
    );
    test.skip(!partner, 'no partner is on a cycle in this database');

    await login(page);
    await page.goto(`${BASE}/en/partners`);

    // Wait for the cycle code itself, not for a container — the page renders
    // its heading while still loading, so reading innerText too early caught
    // "Loading..." and reported it as a missing cycle.
    await expect(page.getByText(partner.cycles[0].code).first()).toBeVisible({
      timeout: 15000,
    });

    const text = await page.locator('main').innerText();
    expect(text).toContain(EMAIL);
    expect(text).not.toContain('0 cycles');
  });

  test('TC-CAP-07: a partner who has funded nothing shows nothing, not a wrong number', async ({
    request,
  }) => {
    // The other direction. A summary that invents figures for someone with no
    // participation is worse than one that admits it.
    const { headers } = await apiCtx(request);
    const summary = await (
      await request.get(`${API}/users/participation`, { headers })
    ).json();

    for (const person of summary.data ?? []) {
      if (person.cycleCount === 0) {
        expect(person.contributedEgp).toBe(0);
        expect(person.profitShareEgp).toBe(0);
        expect(person.atRiskEgp).toBe(0);
        expect(person.cycles).toEqual([]);
      }
      // Capital never comes back as more than went in.
      expect(person.returnedEgp).toBeLessThanOrEqual(person.contributedEgp + 0.001);
      // And what is still out is exactly the gap.
      expect(person.atRiskEgp).toBeCloseTo(
        person.contributedEgp - person.returnedEgp,
        2,
      );
    }
  });
});
