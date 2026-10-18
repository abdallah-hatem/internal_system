'use client';

import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/lib/numbers';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel, type CodeKind } from '@/lib/labels';
import { LatinText } from '@/components/ui/latin-text';

/**
 * What an audit entry changed, one line per field: `Field: old → new`.
 *
 * The detail dialog used to print `beforeJson` and `afterJson` as raw JSON —
 * database ids, `"1500.00"`, `"2026-10-18T00:00:00.000Z"` — which the owner
 * could not read (2026-10-18). Here a field that did not change is left out,
 * names are translated, money and dates are formatted the way the rest of the
 * app formats them, and ids are never shown.
 */

export type ChangeMode = 'changed' | 'set' | 'removed';

export interface Change {
  key: string;
  mode: ChangeMode;
  from?: unknown;
  to?: unknown;
}

type Json = Record<string, unknown>;

/** Bookkeeping columns that say nothing about what happened. */
const NOISE = new Set([
  'id',
  'version',
  'createdAt',
  'updatedAt',
  'createdBy',
  'passwordHash',
  'nameArSearch',
  'idempotencyKey',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// A figure as Prisma's Decimal sends it: no leading zero ("0100" is a phone
// number or a code, not one hundred).
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Fields made of digits that are not quantities: never grouped, never summed. */
const TEXT = /(phone|barcode|sku|reference|ref|code|orderNo|number)$/i;

/** A quantity or sum, to be compared as a number and shown formatted. */
function isFigure(key: string, value: unknown): value is number | string {
  if (TEXT.test(key)) return false;
  return typeof value === 'number' || (typeof value === 'string' && NUMERIC.test(value));
}

/** A database id: the key says so, or the value is one. */
export function isIdField(key: string, value: unknown): boolean {
  if (typeof value === 'string' && UUID.test(value)) return true;
  return (key === 'id' || /Id$/.test(key)) && (value == null || typeof value === 'string');
}

function asObject(json: unknown): Json | null {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Json) : null;
}

/** "10.00" and 10 are the same figure; Decimal comes back as a string. */
function same(key: string, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (isFigure(key, a) && isFigure(key, b)) return Number(a) === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The lines to show. Both sides present: the fields that differ. Only the
 * after: what was set (a CREATE). Only the before: what was removed (a DELETE).
 */
export function auditChanges(before: unknown, after: unknown): Change[] {
  const b = asObject(before);
  const a = asObject(after);
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].filter(
    (k) => !NOISE.has(k),
  );

  if (b && a) {
    return keys
      .filter((k) => !same(k, b[k], a[k]))
      .map((k) => ({ key: k, mode: 'changed' as const, from: b[k], to: a[k] }));
  }
  const only = a ?? b;
  if (!only) return [];
  const mode: ChangeMode = a ? 'set' : 'removed';
  return keys
    .filter((k) => only[k] != null && only[k] !== '' && !isIdField(k, only[k]))
    .map((k) => (a ? { key: k, mode, to: only[k] } : { key: k, mode, from: only[k] }));
}

/** `unitWeightKg` → "Unit weight kg", for a field nobody has named yet. */
export function humaniseKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Fields that hold money. Ones ending in `Egp` are in pounds whatever the record's currency. */
const MONEY = new Set([
  'amount', 'total', 'subtotal', 'discount', 'outstanding', 'unitPrice', 'lineTotal', 'price',
  'cogs', 'totalCogs', 'revenue', 'expenses', 'grossProfit', 'contributionAmount', 'cleared',
  'originalAmount', 'sellPrice', 'unitCost',
]);
const RATE = new Set(['fxRateToEgp', 'rateToEgp', 'ratePerUnit']);

/** The family of codes a field's value belongs to, by record type where it matters. */
function codeKindFor(entityType: string, key: string): CodeKind | null {
  if (key === 'status') {
    const byType: Record<string, CodeKind> = {
      SaleOrder: 'orderStatus',
      Payment: 'paymentStatus',
      ImportCycle: 'cycleStatus',
      Cycle: 'cycleStatus',
      ShippingLeg: 'legStatus',
      PurchaseOrder: 'poStatus',
      Settlement: 'settlementStatus',
    };
    return byType[entityType] ?? null;
  }
  const byKey: Record<string, CodeKind> = {
    method: 'paymentMethod',
    channel: 'channel',
    role: 'role',
    costBasis: 'costBasis',
    verificationStatus: 'verificationStatus',
    originType: 'originType',
    direction: 'ledgerDirection',
  };
  if (byKey[key]) return byKey[key];
  if (entityType === 'Customer' && key === 'type') return 'customerType';
  if (entityType === 'FinancialTransaction' && key === 'category') return 'ledgerCategory';
  if (entityType === 'FinancialTransaction' && key === 'kind') return 'ledgerKind';
  return null;
}

/** A name a nested record goes by, when it has one. */
function nameOf(o: Json): string | null {
  for (const k of ['displayName', 'name', 'orderNo', 'code', 'reference', 'email', 'sku']) {
    if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  }
  return null;
}

export function AuditChanges({
  entityType,
  before,
  after,
}: {
  entityType: string;
  before?: unknown;
  after?: unknown;
}) {
  const t = useTranslations('auditLogs');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const { formatNumber, formatAmount, formatMoney } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const changes = auditChanges(before, after);
  if (changes.length === 0) return null;

  const record = { ...asObject(before), ...asObject(after) };
  const currency = typeof record.currency === 'string' ? record.currency : null;

  const fieldName = (key: string) =>
    t.has(`fields.${key}`) ? t(`fields.${key}`) : humaniseKey(key);

  const show = (key: string, value: unknown, depth = 0): string => {
    if (value == null || value === '') return '—';
    if (typeof value === 'boolean') return value ? tc('yes') : tc('no');
    if (Array.isArray(value)) return t('itemCount', { count: value.length });
    if (typeof value === 'object') {
      const o = value as Json;
      const name = nameOf(o);
      if (name) return name;
      if (depth > 0) return '…';
      const parts = Object.entries(o)
        .filter(([k, v]) => !NOISE.has(k) && v != null && !isIdField(k, v))
        .map(([k, v]) => `${fieldName(k)}: ${show(k, v, depth + 1)}`);
      return parts.length ? parts.join(' · ') : '—';
    }
    if (typeof value === 'string' && UUID.test(value)) return t('aRecord');
    const kind = codeKindFor(entityType, key);
    if (kind && typeof value === 'string') return codeLabel(kind, value);

    if (isFigure(key, value)) {
      if (/Egp$/.test(key)) return formatMoney(value, 'EGP');
      if (MONEY.has(key)) return currency ? formatMoney(value, currency) : formatAmount(value);
      if (RATE.has(key)) return formatNumber(value, { maximumFractionDigits: 4 });
      if (/Pct$/.test(key)) return `${formatNumber(value, { maximumFractionDigits: 2 })}%`;
      return formatNumber(value, { maximumFractionDigits: 3 });
    }
    if (typeof value === 'string' && ISO_DATE.test(value)) {
      // A calendar day is stored at midnight UTC; only a moment carries a time.
      const moment = /T/.test(value) && !/T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(value);
      return formatDate(value, { includeTime: moment });
    }
    return String(value);
  };

  return (
    <dl data-testid="audit-changes" className="divide-y divide-border rounded-lg border border-border">
      {changes.map((c) => (
        <div key={c.key} data-testid="audit-change" data-field={c.key} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3">
          <dt className="text-muted-foreground">{fieldName(c.key)}</dt>
          <dd className="min-w-0 break-words text-foreground">
            {c.mode === 'changed' ? (
              isIdField(c.key, c.from) && isIdField(c.key, c.to) ? (
                // Which record it now points at is the record's own business;
                // the id is not something a reader can use.
                <span>{t('changedRecord')}</span>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <LatinText className="text-muted-foreground line-through decoration-muted-foreground/50">
                    {show(c.key, c.from)}
                  </LatinText>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-label={t('changedTo')} />
                  <LatinText className="font-medium">{show(c.key, c.to)}</LatinText>
                </span>
              )
            ) : (
              <LatinText className={c.mode === 'removed' ? 'text-muted-foreground line-through' : 'font-medium'}>
                {show(c.key, c.mode === 'set' ? c.to : c.from)}
              </LatinText>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
