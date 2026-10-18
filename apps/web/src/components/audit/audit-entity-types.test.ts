import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { AUDIT_ENTITY_TYPES } from './audit-entity-types';

/**
 * The audit log's record-type filter offered Cycle, Shipment, User and LedgerEntry,
 * which no service writes, so choosing one always showed an empty log. The
 * filter must offer what the API writes — every one of them, and nothing else.
 */

/** Every `entityType: '…'` a service in apps/api/src writes (specs excluded). */
function writtenTypes(): Set<string> {
  const root = join(process.cwd(), '..', 'api', 'src');
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        for (const m of readFileSync(path, 'utf8').matchAll(/entityType:\s*'([A-Za-z]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk(root);
  return found;
}

describe('audit log record-type filter', () => {
  const written = writtenTypes();

  it('reads the types the API writes', () => {
    // A sanity floor: if the pattern stops matching, the checks below pass on nothing.
    expect(written.size).toBeGreaterThanOrEqual(20);
    expect(written.has('SaleOrder')).toBe(true);
  });

  it('offers no type the API never writes', () => {
    const never = AUDIT_ENTITY_TYPES.filter((type) => !written.has(type));
    expect(never).toEqual([]);
  });

  it('offers every type the API writes', () => {
    const offered = new Set<string>(AUDIT_ENTITY_TYPES);
    const missing = [...written].filter((type) => !offered.has(type)).sort();
    expect(missing).toEqual([]);
  });

  it('offers each type once', () => {
    expect(new Set(AUDIT_ENTITY_TYPES).size).toBe(AUDIT_ENTITY_TYPES.length);
  });

  it('names every offered type in both languages', () => {
    const enTypes = en.codes.entityType as Record<string, string>;
    const arTypes = ar.codes.entityType as Record<string, string>;
    expect(AUDIT_ENTITY_TYPES.filter((type) => !enTypes[type])).toEqual([]);
    expect(AUDIT_ENTITY_TYPES.filter((type) => !arTypes[type])).toEqual([]);
  });
});
