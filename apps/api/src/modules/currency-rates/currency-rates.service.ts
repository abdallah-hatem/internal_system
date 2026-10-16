import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import { badRequest, notFound } from '../../common/api-error';
import {
  BASE_CURRENCY,
  parseCurrencyCode,
  parseRateToEgp,
} from '../../common/fx-rate';

/** Where a rate came from, as stored: a person on the page unless said. */
function sourceOf(value: unknown): string {
  const s = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  return s || 'manual';
}

/**
 * A stable UUID for a currency, so its rate changes form one audit trail.
 *
 * The audit log keys on a UUID, but a currency's identity is its code. Deriving
 * the id from the code (RFC 4122 v5, name-based) means every change to AED
 * lands on the same entity id and reads back as one history — where a random
 * id per write would scatter it.
 */
function auditIdFor(code: string) {
  const b = Buffer.from(
    createHash('sha1').update(`currency-rate:${code}`).digest().subarray(0, 16),
  );
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The code in a URL or a body, checked; a missing one is not a code. */
function codeOf(value: unknown): string {
  const code = parseCurrencyCode(value);
  if (!code) {
    throw badRequest(
      'CURRENCY_CODE_INVALID',
      'A currency code is three letters, such as AED.',
      { value: '' },
    );
  }
  return code;
}

/**
 * The exchange-rate page (BUSINESS_LOGIC §22, 2026-10-16).
 *
 * These rates only prefill forms. Every purchase order, shipping leg, ledger
 * entry and friend's payment keeps the rate it was recorded at, so a change
 * here never restates a landed cost or a settled cycle.
 */
@Injectable()
export class CurrencyRatesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll() {
    const rates = await this.prisma.currencyRate.findMany({
      orderBy: { code: 'asc' },
    });
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
   * Change a currency's rate (`PUT /currency-rates/:code`).
   *
   * The currency must already be on the page — a new one is added with
   * `create`, so a typo in a URL cannot quietly make a currency. The rate is
   * above zero with at most four decimals; `null` says "no rate known" (the
   * forms then ask). EGP is 1 by definition.
   */
  async upsert(
    code: string,
    rateToEgp: unknown,
    actorId?: string,
    source?: unknown,
  ) {
    const upper = codeOf(code);
    const rate = rateToEgp === null ? null : parseRateToEgp(rateToEgp);
    if (rate === undefined) {
      throw badRequest(
        'RATE_NOT_POSITIVE',
        'A rate must be greater than zero.',
      );
    }
    if (upper === BASE_CURRENCY && (rate === null || !rate.eq(1))) {
      throw badRequest(
        'BASE_CURRENCY_RATE_FIXED',
        `${BASE_CURRENCY} is the base currency — its rate is 1 by definition and cannot be changed.`,
        { currency: BASE_CURRENCY },
      );
    }

    const before = await this.prisma.currencyRate.findUnique({
      where: { code: upper },
    });
    if (!before) throw notFound('currencyRate');

    const saved = await this.prisma.currencyRate.update({
      where: { code: upper },
      data: { rateToEgp: rate, source: sourceOf(source), updatedBy: actorId },
    });
    await this.logChange('UPDATE', upper, before.rateToEgp, saved, actorId);
    return { data: saved };
  }

  /**
   * Add a currency the business deals in (`POST /currency-rates`): a
   * three-letter code not already on the page, and its rate to EGP — the same
   * rules as a change.
   */
  async create(
    body: { code?: unknown; rateToEgp?: unknown; source?: unknown },
    actorId?: string,
  ) {
    const code = codeOf(body?.code);
    const rate = parseRateToEgp(body?.rateToEgp);
    if (rate === undefined) {
      throw badRequest(
        'RATE_NOT_POSITIVE',
        'A rate must be greater than zero.',
      );
    }
    const existing = await this.prisma.currencyRate.findUnique({
      where: { code },
    });
    if (existing) {
      throw badRequest(
        'CURRENCY_EXISTS',
        `${code} is already on the exchange-rate page; change its rate there.`,
        { currency: code },
      );
    }
    let saved;
    try {
      saved = await this.prisma.currencyRate.create({
        data: {
          code,
          rateToEgp: rate,
          source: sourceOf(body?.source),
          updatedBy: actorId,
        },
      });
    } catch (e) {
      // Two adds of one code at once: the second meets the primary key.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw badRequest(
          'CURRENCY_EXISTS',
          `${code} is already on the exchange-rate page; change its rate there.`,
          { currency: code },
        );
      }
      throw e;
    }
    await this.logChange('CREATE', code, null, saved, actorId);
    return { data: saved };
  }

  async findOne(code: string) {
    const rate = await this.prisma.currencyRate.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!rate)
      throw badRequest(
        'NO_RATE_RECORDED',
        `No rate recorded for ${code.toUpperCase()}`,
        { currency: code.toUpperCase() },
      );
    return { data: rate };
  }

  private async logChange(
    action: 'CREATE' | 'UPDATE',
    code: string,
    before: Prisma.Decimal | null,
    after: { rateToEgp: Prisma.Decimal | null; source: string },
    actorId?: string,
  ) {
    await this.audit.log({
      actorUserId: actorId,
      action,
      entityType: 'CurrencyRate',
      entityId: auditIdFor(code),
      beforeJson:
        action === 'UPDATE'
          ? { code, rateToEgp: before?.toString() ?? null }
          : undefined,
      afterJson: {
        code,
        rateToEgp: after.rateToEgp?.toString() ?? null,
        source: after.source,
      },
    });
  }
}
