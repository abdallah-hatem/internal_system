import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

/** The currency everything reports in; its rate is 1 by definition. */
const BASE = 'EGP';

/**
 * A stable UUID for a currency, so its rate changes form one audit trail.
 *
 * The audit log keys on a UUID, but a currency's identity is its code. Deriving
 * the id from the code (RFC 4122 v5, name-based) means every change to AED
 * lands on the same entity id and reads back as one history — where a random
 * id per write would scatter it.
 */
function auditIdFor(code: string) {
  const b = Buffer.from(createHash('sha1').update(`currency-rate:${code}`).digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class CurrencyRatesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll() {
    const rates = await this.prisma.currencyRate.findMany({ orderBy: { code: 'asc' } });
    return { data: rates };
  }

  /**
   * The rates as a plain `{ AED: 13.85 }` map, for prefilling a form.
   *
   * Currencies with no rate are left out rather than sent as null: a caller
   * asking "what should this field default to" has no use for "unknown", and
   * omitting them makes the form fall back to asking.
   */
  async asMap() {
    const rates = await this.prisma.currencyRate.findMany();
    const data: Record<string, number> = {};
    for (const r of rates) {
      if (r.rateToEgp !== null) data[r.code] = Number(r.rateToEgp);
    }
    return { data };
  }

  /**
   * Set a rate.
   *
   * This changes what future documents are prefilled with. It does NOT touch
   * anything already recorded — every purchase order, shipping leg and ledger
   * entry keeps the rate it was agreed at, so a correction here can never
   * silently restate a landed cost or a settled cycle.
   */
  async upsert(code: string, rateToEgp: number | null, actorId?: string, source = 'manual') {
    const upper = code.toUpperCase();

    if (upper === BASE && rateToEgp !== null && Number(rateToEgp) !== 1) {
      throw new BadRequestException(
        `${BASE} is the base currency — its rate is 1 by definition and cannot be changed.`,
      );
    }
    if (rateToEgp !== null && !(Number(rateToEgp) > 0)) {
      throw new BadRequestException('A rate must be greater than zero.');
    }

    const before = await this.prisma.currencyRate.findUnique({ where: { code: upper } });

    const rate = await this.prisma.currencyRate.upsert({
      where: { code: upper },
      update: {
        rateToEgp: rateToEgp === null ? null : new Prisma.Decimal(rateToEgp),
        source,
        updatedBy: actorId,
      },
      create: {
        code: upper,
        rateToEgp: rateToEgp === null ? null : new Prisma.Decimal(rateToEgp),
        source,
        updatedBy: actorId,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: before ? 'UPDATE' : 'CREATE',
      entityType: 'CurrencyRate',
      entityId: auditIdFor(upper),
      beforeJson: before ? { code: upper, rateToEgp: before.rateToEgp?.toString() ?? null } : undefined,
      afterJson: { code: upper, rateToEgp: rate.rateToEgp?.toString() ?? null, source },
    });

    return { data: rate };
  }

  async findOne(code: string) {
    const rate = await this.prisma.currencyRate.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!rate) throw new NotFoundException(`No rate recorded for ${code.toUpperCase()}`);
    return { data: rate };
  }
}
