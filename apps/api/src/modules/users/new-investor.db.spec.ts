import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { SessionTokensService } from '../auth/session-tokens.service';
import { CyclesService } from '../cycles/cycles.service';
import { UsersService } from './users.service';

/**
 * A temporary investor from a name alone (BUSINESS_LOGIC §8, owner
 * 2026-10-26), against a real Postgres: what is stored, that it is never a
 * partner, the duplicate-name refusal (a GUESS, §8) and two of the same name
 * at once.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest new-investor.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('a new temporary investor from a name (Postgres)', () => {
  let prisma: PrismaClient;
  let users: UsersService;
  let cycles: CyclesService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    users = new UsersService(
      db,
      {} as SettlementsService,
      {} as SessionTokensService,
    );
    cycles = new CyclesService(
      db,
      { log: jest.fn() } as unknown as AuditService,
      { create: jest.fn() } as unknown as NotificationsService,
    );
  });
  afterAll(() => prisma.$disconnect());

  /** A name no other run has used. */
  const fresh = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const b = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { status: e.getStatus(), code: b.code, params: b.params };
    }
    throw new Error('expected a refusal');
  }

  it('makes an active TEMP_INVESTOR named as typed, with a made-up address and no usable password', async () => {
    const name = fresh('Mohammed Setta');
    const { data } = await users.createInvestor(`  ${name} `);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: data.id },
      include: { partner: true },
    });
    expect(row.role).toBe('TEMP_INVESTOR');
    expect(row.status).toBe('ACTIVE');
    expect(row.partner?.displayName).toBe(name);
    expect(row.email).toMatch(/@investors\.invalid$/);
    // Hashed, and none of the passwords anyone would try.
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    for (const guess of ['', 'password123', name, row.email]) {
      expect(await bcrypt.compare(guess, row.passwordHash)).toBe(false);
    }
    // What the picker is handed carries no hash.
    expect(data).not.toHaveProperty('passwordHash');
  });

  it('never a partner: the count of core partners does not move', async () => {
    const before = await prisma.user.count({ where: { role: 'CORE_PARTNER' } });
    await users.createInvestor(fresh('Not A Partner'));
    expect(await prisma.user.count({ where: { role: 'CORE_PARTNER' } })).toBe(
      before,
    );
  });

  it('an empty name is refused INVESTOR_NAME_REQUIRED, a long one INVESTOR_NAME_TOO_LONG — and no user is made', async () => {
    const before = await prisma.user.count();
    expect((await refusal(users.createInvestor('   '))).code).toBe(
      'INVESTOR_NAME_REQUIRED',
    );
    expect((await refusal(users.createInvestor('x'.repeat(81)))).code).toBe(
      'INVESTOR_NAME_TOO_LONG',
    );
    expect(await prisma.user.count()).toBe(before);
  });

  it('a name already held — an investor’s or a partner’s, whatever its case — is refused INVESTOR_NAME_TAKEN (GUESS)', async () => {
    const name = fresh('Ahmad Eraiby');
    await users.createInvestor(name);
    const r = await refusal(users.createInvestor(name.toUpperCase()));
    expect(r).toMatchObject({
      status: 409,
      code: 'INVESTOR_NAME_TAKEN',
      params: { name },
    });

    const partnerName = fresh('Shady');
    await prisma.user.create({
      data: {
        email: `inv-p-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: partnerName } },
      },
    });
    expect((await refusal(users.createInvestor(partnerName))).code).toBe(
      'INVESTOR_NAME_TAKEN',
    );
  });

  it('the same name twice at once: one is made, the other refused', async () => {
    const name = fresh('Twin');
    const results = await Promise.allSettled([
      users.createInvestor(name),
      users.createInvestor(name),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.partner.count({ where: { displayName: name } })).toBe(
      1,
    );
  });

  it('the second time: two different investors one after the other are two people', async () => {
    const a = (await users.createInvestor(fresh('First'))).data;
    const b = (await users.createInvestor(fresh('Second'))).data;
    expect(a.id).not.toBe(b.id);
    expect(a.email).not.toBe(b.email);
  });

  it('the investor made can join a cycle as one — and only as one', async () => {
    const { data: investor } = await users.createInvestor(fresh('Joins'));
    const cycle = await prisma.importCycle.create({
      data: {
        code: `INV-${randomUUID().slice(0, 8)}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'PURCHASING',
      },
    });
    const actor = (
      await prisma.user.create({
        data: {
          email: `inv-actor-${randomUUID()}@example.test`,
          passwordHash: 'x',
          role: 'CORE_PARTNER',
          partner: { create: { displayName: fresh('Actor') } },
        },
      })
    ).id;
    const asPartner = await refusal(
      cycles.addParticipant(
        cycle.id,
        {
          participantType: 'CORE_PARTNER',
          partnerUserId: investor.id,
          contributionAmount: 0,
        },
        actor,
      ),
    );
    expect(asPartner.status).toBe(400);
    const { data: joined } = await cycles.addParticipant(
      cycle.id,
      {
        participantType: 'TEMP_INVESTOR',
        investorUserId: investor.id,
        contributionAmount: 20000,
      },
      actor,
    );
    expect(joined.investorUserId).toBe(investor.id);
  });
});
