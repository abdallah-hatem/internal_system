import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { SessionTokensService } from '../auth/session-tokens.service';
import { CostingService } from '../costing/costing.service';
import { SettlementsService } from '../settlements/settlements.service';
import { PartnerAccountsService } from '../partner-accounts/partner-accounts.service';
import { businessToday } from '../../common/dates';
import { UsersService } from './users.service';

/**
 * The Partners page's "Put in so far" (BUSINESS_LOGIC §8, owner 2026-10-28:
 * the cards read capital only, so a cycle funded by advances not yet drawn
 * showed nothing on them while the Running accounts and the cycle's Funding
 * card showed the money — "not synced"). Per cycle it is the Funding card's
 * own figure (`putInSoFar` over the same pots), so the test also asks the
 * Funding card and expects the same number.
 *
 * Against a real, THROWAWAY Postgres (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest participation.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Partners page: put in so far (Postgres)', () => {
  let prisma: PrismaClient;
  let users: UsersService;
  let accounts: PartnerAccountsService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const costing = new CostingService(db);
    users = new UsersService(
      db,
      new SettlementsService(db, audit, costing),
      {} as SessionTokensService,
    );
    accounts = new PartnerAccountsService(db, audit, costing);
    actor = (await person('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());

  // ─── Fixtures ───────────────────────────────────────────────────────

  async function person(
    name: string,
    role: 'CORE_PARTNER' | 'TEMP_INVESTOR' = 'CORE_PARTNER',
  ) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `pin-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role,
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  async function cycle(status = 'PURCHASING') {
    return prisma.importCycle.create({
      data: {
        code: `PIN-${randomUUID().slice(0, 8)}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: status as never,
      },
    });
  }

  /** He joins `cycleId` with `contribution` entered directly (Enter amounts). */
  const join = (
    cycleId: string,
    userId: string,
    contribution: number,
    type: 'CORE_PARTNER' | 'TEMP_INVESTOR' = 'CORE_PARTNER',
  ) =>
    prisma.cycleParticipant.create({
      data: {
        cycleId,
        participantType: type,
        ...(type === 'CORE_PARTNER'
          ? { partnerUserId: userId }
          : { investorUserId: userId }),
        contributionAmount: contribution,
      },
    });

  const advance = (userId: string, cycleId: string, amount: number) =>
    accounts.recordAdvance(userId, { cycleId, amount }, actor);

  /** His card's figures, and his line for each cycle. */
  async function card(userId: string) {
    const { data } = await users.participation();
    const p = data.find((d) => d.id === userId)!;
    return {
      putIn: p.putInEgp,
      capital: p.contributedEgp,
      undrawn: p.undrawnAdvancesEgp,
      cycles: Object.fromEntries(
        p.cycles.map((c) => [
          c.id,
          {
            putIn: c.putInEgp,
            capital: c.contributionEgp,
            undrawn: c.undrawnAdvancesEgp,
          },
        ]),
      ),
    };
  }

  /** What the cycle's Funding card says he has put in. */
  async function fundingCardSays(cycleId: string, userId: string) {
    const f = (await accounts.cycleFunding(cycleId)) as unknown as {
      data: {
        putIn: { byPartner: { partnerUserId: string; totalEgp: string }[] };
      };
    };
    const row = f.data.putIn.byPartner.find((r) => r.partnerUserId === userId);
    return row ? Number(row.totalEgp) : 0;
  }

  // ─── Cases ──────────────────────────────────────────────────────────

  it('a contribution only: put in so far is the capital', async () => {
    const me = await person('Abdallah');
    const c = await cycle();
    await join(c.id, me.id, 55_000);
    const r = await card(me.id);
    expect(r).toMatchObject({ putIn: 55_000, capital: 55_000, undrawn: 0 });
    expect(r.cycles[c.id]).toEqual({
      putIn: 55_000,
      capital: 55_000,
      undrawn: 0,
    });
    expect(await fundingCardSays(c.id, me.id)).toBe(55_000);
  });

  it('advances only, on a cycle with no contribution yet: they are put in, capital stays 0', async () => {
    const me = await person('Shady');
    const c = await cycle();
    await join(c.id, me.id, 0);
    await advance(me.id, c.id, 50_000);
    await advance(me.id, c.id, 22_100);
    const r = await card(me.id);
    expect(r).toMatchObject({ putIn: 72_100, capital: 0, undrawn: 72_100 });
    expect(r.cycles[c.id]).toEqual({
      putIn: 72_100,
      capital: 0,
      undrawn: 72_100,
    });
    expect(await fundingCardSays(c.id, me.id)).toBe(72_100);
  });

  it('production-like: cycle 1 contributions and cycle 2 advances add up per partner, and match each Funding card', async () => {
    const [a, s, f] = [
      await person('Abdallah'),
      await person('Shady'),
      await person('Fares'),
    ];
    const one = await cycle('SELLING');
    const two = await cycle('PURCHASING');
    await join(one.id, a.id, 55_000);
    await join(one.id, s.id, 33_084.5);
    await join(one.id, f.id, 33_084.49);
    for (const p of [a, s, f]) await join(two.id, p.id, 0);
    await advance(a.id, two.id, 50_775);
    await advance(s.id, two.id, 72_100);
    await advance(f.id, two.id, 51_207);

    expect((await card(a.id)).putIn).toBe(105_775);
    expect((await card(s.id)).putIn).toBe(105_184.5);
    expect((await card(f.id)).putIn).toBe(84_291.49);
    // Capital (what settlement hands back) is unchanged.
    expect((await card(s.id)).capital).toBe(33_084.5);
    for (const p of [a, s, f]) {
      const r = await card(p.id);
      for (const cy of [one, two]) {
        expect(r.cycles[cy.id].putIn).toBe(await fundingCardSays(cy.id, p.id));
      }
    }
  });

  it('partly drawn: advance 100, 60 drawn into capital — put in 100, not 160; drawing the rest leaves it 100', async () => {
    const me = await person('Fares');
    const c = await cycle();
    await join(c.id, me.id, 0);
    await advance(me.id, c.id, 100);
    await accounts.contribute(
      c.id,
      { lines: [{ partnerUserId: me.id, amountEgp: 60 }] },
      actor,
    );
    let r = await card(me.id);
    expect(r).toMatchObject({ putIn: 100, capital: 60, undrawn: 40 });
    expect(await fundingCardSays(c.id, me.id)).toBe(100);

    // The second time: draw the other 40. Nothing new was put in.
    await accounts.contribute(
      c.id,
      { lines: [{ partnerUserId: me.id, amountEgp: 40 }] },
      actor,
    );
    r = await card(me.id);
    expect(r).toMatchObject({ putIn: 100, capital: 100, undrawn: 0 });
  });

  it('an advance tied to no cycle is in his running account only, not put in any cycle', async () => {
    const me = await person('Abdallah');
    const c = await cycle();
    await join(c.id, me.id, 0);
    await advance(me.id, c.id, 50_775);
    // The 10,000 moved off cycle 1: an advance with no cycle (written by hand).
    await prisma.partnerAccountMovement.create({
      data: {
        partnerUserId: me.id,
        kind: 'ADVANCE',
        amount: 10_000,
        amountEgp: 10_000,
        occurredOn: new Date(`${businessToday()}T00:00:00Z`),
        cycleId: null,
      },
    });
    const r = await card(me.id);
    expect(r).toMatchObject({ putIn: 50_775, capital: 0, undrawn: 50_775 });
    // It is still his money: the running account holds both.
    const { data } = await accounts.list();
    expect(
      Number(data.find((x) => x.partnerUserId === me.id)!.balanceEgp),
    ).toBe(60_775);
  });

  it('a reversed advance is not put in', async () => {
    const me = await person('Shady');
    const c = await cycle();
    await join(c.id, me.id, 0);
    await advance(me.id, c.id, 1_000);
    const wrong = await advance(me.id, c.id, 9_999);
    await accounts.reverse(me.id, wrong.data.id, 'typed twice', actor);
    const r = await card(me.id);
    expect(r).toMatchObject({ putIn: 1_000, undrawn: 1_000 });
  });

  it('a temporary investor has no account: his put in so far is his contribution', async () => {
    const inv = await person('Setta', 'TEMP_INVESTOR');
    const c = await cycle();
    await join(c.id, inv.id, 20_000, 'TEMP_INVESTOR');
    const r = await card(inv.id);
    expect(r).toMatchObject({ putIn: 20_000, capital: 20_000, undrawn: 0 });
    expect(r.cycles[c.id].putIn).toBe(20_000);
  });

  it('an advance on a cycle he is not on still counts, under that cycle (as the Funding card lists him)', async () => {
    const me = await person('Fares');
    const mine = await cycle();
    const other = await cycle();
    await join(mine.id, me.id, 500);
    await advance(me.id, other.id, 700);
    const r = await card(me.id);
    expect(r).toMatchObject({ putIn: 1_200, capital: 500, undrawn: 700 });
    expect(r.cycles[other.id]).toEqual({
      putIn: 700,
      capital: 0,
      undrawn: 700,
    });
    expect(await fundingCardSays(other.id, me.id)).toBe(700);
  });

  it("two partners: one's advances never land on the other's card", async () => {
    const [a, b] = [await person('Abdallah'), await person('Shady')];
    const c = await cycle();
    await join(c.id, a.id, 0);
    await join(c.id, b.id, 300);
    await advance(a.id, c.id, 400);
    expect((await card(a.id)).putIn).toBe(400);
    expect((await card(b.id)).putIn).toBe(300);
  });
});
