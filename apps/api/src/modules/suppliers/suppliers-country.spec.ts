import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { SuppliersService } from './suppliers.service';

/**
 * A supplier's country is a code from the one list (§21, 2026-10-16), checked
 * by the service — the office form is one caller, the API is reachable
 * without it. The database is a stand-in that keeps what it is given, so a
 * refusal can be shown to have written nothing.
 */

const ID = '11111111-1111-4111-8111-111111111111';

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    supplier: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: ID, ...data };
        rows.set(ID, row);
        return Promise.resolve(row);
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.get(where.id) ?? null),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const defined = Object.fromEntries(
            Object.entries(data).filter(([, v]) => v !== undefined),
          );
          const row = { ...rows.get(where.id), ...defined };
          rows.set(where.id, row);
          return Promise.resolve(row);
        },
      ),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new SuppliersService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, prisma, rows };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (e) {
    return (e as { response?: { code?: string } }).response?.code ?? 'uncoded';
  }
}

describe('supplier country on create', () => {
  it('a valid code is saved as it is', async () => {
    const { service, rows } = setup();
    const { data } = await service.create(
      { name: 'Ningbo Moto', country: 'CN' },
      'u1',
    );
    expect(data.country).toBe('CN');
    expect(rows.get(ID)?.country).toBe('CN');
  });

  it('a lower-case code is saved upper-case', async () => {
    const { service, rows } = setup();
    await service.create({ name: 'Dubai Parts', country: ' ae ' }, 'u1');
    expect(rows.get(ID)?.country).toBe('AE');
  });

  it.each(['XX', 'Narnia', 'China', 'Egypt (Cairo)'])(
    '%s → COUNTRY_UNKNOWN, nothing written',
    async (country) => {
      const { service, prisma } = setup();
      expect(
        await codeOf(service.create({ name: 'X Co', country }, 'u1')),
      ).toBe('COUNTRY_UNKNOWN');
      expect(prisma.supplier.create).not.toHaveBeenCalled();
    },
  );

  it.each([[''], ['   '], [undefined], [null]])(
    'empty (%p) → COUNTRY_REQUIRED, nothing written',
    async (country) => {
      const { service, prisma } = setup();
      expect(
        await codeOf(
          service.create(
            { name: 'X Co', country: country as unknown as string },
            'u1',
          ),
        ),
      ).toBe('COUNTRY_REQUIRED');
      expect(prisma.supplier.create).not.toHaveBeenCalled();
    },
  );
});

describe('supplier country on edit', () => {
  async function existing() {
    const s = setup();
    await s.service.create({ name: 'Ningbo Moto', country: 'CN' }, 'u1');
    return s;
  }

  it('changed to another code, any case → saved upper-case', async () => {
    const { service, rows } = await existing();
    await service.update(ID, { country: 'eg' }, 'u1');
    expect(rows.get(ID)?.country).toBe('EG');
  });

  it('left out → the country stays', async () => {
    const { service, rows } = await existing();
    await service.update(ID, { name: 'Ningbo Moto Ltd' }, 'u1');
    expect(rows.get(ID)).toMatchObject({
      name: 'Ningbo Moto Ltd',
      country: 'CN',
    });
  });

  it('an unknown code → COUNTRY_UNKNOWN, the old country kept', async () => {
    const { service, rows, prisma } = await existing();
    expect(await codeOf(service.update(ID, { country: 'Narnia' }, 'u1'))).toBe(
      'COUNTRY_UNKNOWN',
    );
    expect(prisma.supplier.update).not.toHaveBeenCalled();
    expect(rows.get(ID)?.country).toBe('CN');
  });

  it('emptied → COUNTRY_REQUIRED, not saved as no country', async () => {
    const { service, rows } = await existing();
    expect(await codeOf(service.update(ID, { country: '' }, 'u1'))).toBe(
      'COUNTRY_REQUIRED',
    );
    expect(rows.get(ID)?.country).toBe('CN');
  });

  it('a supplier that does not exist is still NOT_FOUND, before the country is read', async () => {
    const { service } = setup();
    const other = '22222222-2222-4222-8222-222222222222';
    expect(await codeOf(service.update(other, { country: 'XX' }, 'u1'))).toBe(
      'NOT_FOUND',
    );
  });
});
