import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';
import {
  SessionTokensService,
  mayHoldOfficeSession,
} from './session-tokens.service';

/**
 * Who may sign in at the office door (owner, 2026-10-19: "no investor can
 * access the system, its only the 3 of us"). BUSINESS_LOGIC §19.
 *
 * Each test tries to get an office token for someone who should not hold one,
 * and checks the partners still come in.
 */

const PASSWORD = 'Partner-pass-123';
const SECRET = 'office-door-spec-secret-long-enough-0000';

interface Row {
  id: string;
  email: string;
  role: string;
  status: string;
  passwordHash: string;
  partner: { displayName: string } | null;
}

let rows: Row[];
let issued: string[];
let auth: AuthService;
let hash: string;

beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  rows = [];
  issued = [];
  const prisma = {
    user: {
      findUnique: ({ where }: { where: { email?: string; id?: string } }) =>
        Promise.resolve(
          rows.find((r) => r.email === where.email || r.id === where.id) ??
            null,
        ),
      update: () => Promise.resolve({}),
    },
  };
  const sessions = {
    issue: (userId: string) => {
      issued.push(userId);
      return Promise.resolve(`refresh-${userId}`);
    },
  };
  auth = new AuthService(
    prisma as unknown as PrismaService,
    new JwtService({ secret: SECRET }),
    sessions as unknown as SessionTokensService,
  );
});

function account(role: string, over: Partial<Row> = {}): Row {
  const r: Row = {
    id: randomUUID(),
    email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@test.local`,
    role,
    status: 'ACTIVE',
    passwordHash: hash,
    partner: role === 'CORE_PARTNER' ? { displayName: 'Partner' } : null,
    ...over,
  };
  rows.push(r);
  return r;
}

async function refusal(
  p: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        code: (e.getResponse() as { code: string }).code,
      };
    }
    throw e;
  }
  throw new Error('expected a refusal, got a result');
}

describe('the office door', () => {
  it('a partner signs in and gets an office token and a refresh token', async () => {
    const p = account('CORE_PARTNER');
    const { data } = await auth.login({ email: p.email, password: PASSWORD });
    expect(data.user).toMatchObject({ id: p.id, role: 'CORE_PARTNER' });
    expect(data.accessToken).toBeTruthy();
    expect(issued).toEqual([p.id]);
  });

  it('an investor with the right password is refused with its own code, and no sign-in is issued', async () => {
    const i = account('TEMP_INVESTOR');
    expect(
      await refusal(auth.login({ email: i.email, password: PASSWORD })),
    ).toEqual({
      status: 401,
      code: 'OFFICE_NOT_FOR_INVESTORS',
    });
    expect(issued).toEqual([]);
  });

  it('an investor with the wrong password learns nothing about the account: the same answer as anyone', async () => {
    const i = account('TEMP_INVESTOR');
    expect(
      (await refusal(auth.login({ email: i.email, password: 'nope-nope-1' })))
        .code,
    ).toBe('INVALID_CREDENTIALS');
    expect(
      (
        await refusal(
          auth.login({ email: 'nobody@test.local', password: 'nope-nope-1' }),
        )
      ).code,
    ).toBe('INVALID_CREDENTIALS');
  });

  it('an inactive investor is still told it is the wrong door, not that the account is inactive', async () => {
    const i = account('TEMP_INVESTOR', { status: 'INACTIVE' });
    expect(
      (await refusal(auth.login({ email: i.email, password: PASSWORD }))).code,
    ).toBe('OFFICE_NOT_FOR_INVESTORS');
  });

  it('a shop is still sent to the store (its own code, unchanged)', async () => {
    const s = account('SHOP_OWNER_PORTAL');
    expect(
      (await refusal(auth.login({ email: s.email, password: PASSWORD }))).code,
    ).toBe('USE_PORTAL_LOGIN');
  });

  it('the admin-support role still signs in', async () => {
    const a = account('ADMIN_SUPPORT');
    await expect(
      auth.login({ email: a.email, password: PASSWORD }),
    ).resolves.toBeTruthy();
  });

  it('one definition: who may hold an office session', () => {
    expect(
      [
        'CORE_PARTNER',
        'ADMIN_SUPPORT',
        'TEMP_INVESTOR',
        'SHOP_OWNER_PORTAL',
        'ANYTHING',
      ].filter(mayHoldOfficeSession),
    ).toEqual(['CORE_PARTNER', 'ADMIN_SUPPORT']);
  });
});
