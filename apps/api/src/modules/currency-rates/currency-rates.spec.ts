/* eslint-disable @typescript-eslint/require-await -- an in-memory stand-in for Prisma answers synchronously behind async signatures */
import type { HttpException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the fake keeps rates as Prisma decimals, as the real one does
import { Prisma } from '@prisma/client';

import { RolesGuard } from '../../common/guards/roles.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { CurrencyRatesController } from './currency-rates.controller';
import { CurrencyRatesService } from './currency-rates.service';

/**
 * The exchange-rate page (BUSINESS_LOGIC §21, 2026-10-16): change a rate,
 * add a currency, and everything that must not get in.
 */

interface Rate {
  code: string;
  rateToEgp: Prisma.Decimal | null;
  source: string;
  updatedBy: string | null;
  updatedAt: Date;
}

function build() {
  const rows: Rate[] = [
    {
      code: 'AED',
      rateToEgp: new Prisma.Decimal('13.85'),
      source: 'manual',
      updatedBy: null,
      updatedAt: new Date(0),
    },
    {
      code: 'CNY',
      rateToEgp: null,
      source: 'seed',
      updatedBy: null,
      updatedAt: new Date(0),
    },
    {
      code: 'EGP',
      rateToEgp: new Prisma.Decimal(1),
      source: 'base',
      updatedBy: null,
      updatedAt: new Date(0),
    },
  ];
  const audit = { log: jest.fn(async () => undefined) };
  const prisma = {
    currencyRate: {
      findMany: async () => rows.map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { code: string } }) => {
        const r = rows.find((x) => x.code === where.code);
        return r ? { ...r } : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { code: string };
        data: Partial<Rate>;
      }) => {
        const r = rows.find((x) => x.code === where.code)!;
        Object.assign(r, data, { updatedAt: new Date() });
        return { ...r };
      },
      create: async ({ data }: { data: Omit<Rate, 'updatedAt'> }) => {
        if (rows.some((x) => x.code === data.code)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const r = { ...data, updatedAt: new Date() };
        rows.push(r);
        return { ...r };
      },
    },
  };
  const service = new CurrencyRatesService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, rows, audit };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    const body = err.getResponse() as { code: string; params?: unknown };
    return { status: err.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal, and it went through');
}

const rateOf = (rows: Rate[], code: string) =>
  rows.find((r) => r.code === code)?.rateToEgp?.toString() ?? null;

describe('PUT /currency-rates/:code — change a rate', () => {
  it('a new rate is kept as typed, with who changed it, and audited', async () => {
    const { service, rows, audit } = build();
    const { data } = await service.upsert('aed', 13.9125, 'partner-a');
    expect(data.code).toBe('AED');
    expect(rateOf(rows, 'AED')).toBe('13.9125');
    expect(rows.find((r) => r.code === 'AED')!.updatedBy).toBe('partner-a');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE', entityType: 'CurrencyRate' }),
    );
  });

  it.each([
    [0, 'RATE_NOT_POSITIVE'],
    [-1, 'RATE_NOT_POSITIVE'],
    ['abc', 'RATE_NOT_POSITIVE'],
    [undefined, 'RATE_NOT_POSITIVE'],
    [{}, 'RATE_NOT_POSITIVE'],
    [13.12345, 'RATE_TOO_PRECISE'],
  ])('a rate of %p → %s; nothing changed', async (rate, code) => {
    const { service, rows, audit } = build();
    expect((await refusal(service.upsert('AED', rate, 'p'))).code).toBe(code);
    expect(rateOf(rows, 'AED')).toBe('13.85');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('EGP is fixed at 1: any other rate, or none, → BASE_CURRENCY_RATE_FIXED; 1 is accepted', async () => {
    const { service, rows } = build();
    for (const rate of [2, 0.5, null]) {
      expect((await refusal(service.upsert('EGP', rate, 'p'))).code).toBe(
        'BASE_CURRENCY_RATE_FIXED',
      );
    }
    await service.upsert('EGP', 1, 'p');
    expect(rateOf(rows, 'EGP')).toBe('1');
  });

  it('a currency not on the page → 404, not a new currency made by a typo in a URL', async () => {
    const { service, rows } = build();
    const r = await refusal(service.upsert('USD', 50, 'p'));
    expect(r).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      params: { entity: 'currencyRate' },
    });
    expect(rows.map((x) => x.code)).toEqual(['AED', 'CNY', 'EGP']);
  });

  it('a code that is not three letters → CURRENCY_CODE_INVALID', async () => {
    const { service } = build();
    for (const code of ['AE', 'AEDX', '1AE', '']) {
      expect((await refusal(service.upsert(code, 13, 'p'))).code).toBe(
        'CURRENCY_CODE_INVALID',
      );
    }
  });

  it('null still says "no rate known" for a currency other than EGP', async () => {
    const { service, rows } = build();
    await service.upsert('AED', null, 'p');
    expect(rateOf(rows, 'AED')).toBeNull();
  });
});

describe('POST /currency-rates — add a currency', () => {
  it('a new three-letter code with its rate is added, upper-cased, and audited', async () => {
    const { service, rows, audit } = build();
    const { data } = await service.create(
      { code: ' usd ', rateToEgp: 50.86 },
      'partner-a',
    );
    expect(data).toMatchObject({ code: 'USD', source: 'manual' });
    expect(rateOf(rows, 'USD')).toBe('50.86');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CREATE' }),
    );
  });

  it('a code already on the page, EGP included → CURRENCY_EXISTS; nothing changed', async () => {
    const { service, rows } = build();
    for (const code of ['AED', 'aed', 'EGP']) {
      expect(
        await refusal(service.create({ code, rateToEgp: 20 }, 'p')),
      ).toMatchObject({ status: 400, code: 'CURRENCY_EXISTS' });
    }
    expect(rateOf(rows, 'AED')).toBe('13.85');
  });

  it('twice at once (a double click): one is added, the other is CURRENCY_EXISTS, not a 500', async () => {
    const { service, rows } = build();
    const results = await Promise.allSettled([
      service.create({ code: 'GBP', rateToEgp: 64 }, 'p'),
      service.create({ code: 'GBP', rateToEgp: 64 }, 'p'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(
      ((failed as PromiseRejectedResult).reason as HttpException).getResponse(),
    ).toMatchObject({ code: 'CURRENCY_EXISTS' });
    expect(rows.filter((r) => r.code === 'GBP')).toHaveLength(1);
  });

  it.each([
    [{ code: 'GBP' }, 'RATE_NOT_POSITIVE'],
    [{ code: 'GBP', rateToEgp: 0 }, 'RATE_NOT_POSITIVE'],
    [{ code: 'GBP', rateToEgp: 64.123456 }, 'RATE_TOO_PRECISE'],
    [{ code: 'GB', rateToEgp: 64 }, 'CURRENCY_CODE_INVALID'],
    [{ code: 'POUND', rateToEgp: 64 }, 'CURRENCY_CODE_INVALID'],
    [{ rateToEgp: 64 }, 'CURRENCY_CODE_INVALID'],
    [{ code: 42, rateToEgp: 64 }, 'CURRENCY_CODE_INVALID'],
  ])('%p → %s; nothing added', async (body, code) => {
    const { service, rows } = build();
    expect((await refusal(service.create(body, 'p'))).code).toBe(code);
    expect(rows).toHaveLength(3);
  });
});

describe('who may change the rates', () => {
  const guard = new RolesGuard(new Reflector());
  const contextFor = (
    handler: keyof CurrencyRatesController,
    role: string,
  ): ExecutionContext =>
    ({
      getHandler: () =>
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
        CurrencyRatesController.prototype[handler],
      getClass: () => CurrencyRatesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it.each(['create', 'upsert'] as const)(
    '%s: an investor and admin support are refused with a code; a core partner is let through',
    (handler) => {
      for (const role of ['TEMP_INVESTOR', 'ADMIN_SUPPORT']) {
        let caught: unknown;
        try {
          guard.canActivate(contextFor(handler, role));
        } catch (e) {
          caught = e;
        }
        expect((caught as HttpException).getResponse()).toMatchObject({
          code: 'ROLE_NOT_ALLOWED',
        });
      }
      expect(guard.canActivate(contextFor(handler, 'CORE_PARTNER'))).toBe(true);
    },
  );

  it('reading is open to every office role', () => {
    for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR']) {
      expect(guard.canActivate(contextFor('findAll', role))).toBe(true);
    }
  });
});
