import { HttpException } from '@nestjs/common';
import { LedgerService } from '../modules/ledger/ledger.service';
import { assertNotFuture, DATE_FIELDS } from './dates';

/**
 * R1b, rule 9 — a refusal's params carry codes, never English words. The web
 * pastes params into a translated sentence, so an English noun in a param
 * reached the Arabic reader as "هذا القيد تابع لـ sale return". Each param that
 * names a kind of thing sends the code, and the web says it from
 * `codes.<kind>` in the reader's language.
 */

const bodyOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpException).getResponse() as {
      code: string;
      message: string;
      params?: Record<string, string | number>;
    };
  }
  throw new Error('expected a refusal');
};
const bodyOfAsync = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as HttpException).getResponse() as {
      code: string;
      message: string;
      params?: Record<string, string | number>;
    };
  }
  throw new Error('expected a refusal');
};

/** Lower-case words with spaces: English prose, not a code. */
const ENGLISH = /[a-z]+ [a-z]+/;

describe('ENTRY_OWNED_ELSEWHERE (ledger reverse)', () => {
  const ledgerOver = (relatedType: string) => {
    const prisma = {
      financialTransaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: '33333333-3333-4333-8333-333333333333',
          reversalOfId: null,
          relatedType,
          relatedId: 'r-1',
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    return { ledger: new LedgerService(prisma as never, {} as never), prisma };
  };

  it.each([
    'SALE_RETURN',
    'SUPPLIER_REFUND',
    'SETTLEMENT',
    'CYCLE_PARTICIPANT',
  ])(
    'an entry owned by a %s names its owner by code, not in English',
    async (relatedType) => {
      const { ledger, prisma } = ledgerOver(relatedType);
      const body = await bodyOfAsync(
        ledger.reverse(
          '33333333-3333-4333-8333-333333333333',
          'a reason',
          'u-1',
        ),
      );
      expect(body.code).toBe('ENTRY_OWNED_ELSEWHERE');
      expect(body.params).toEqual({ owner: relatedType });
      expect(String(body.params?.owner)).not.toMatch(ENGLISH);
      // The English message still reads as English, for logs and fallbacks.
      expect(body.message).toContain(
        relatedType.toLowerCase().replace(/_/g, ' '),
      );
      expect(prisma.financialTransaction.create).not.toHaveBeenCalled();
    },
  );
});

describe('DATE_IN_FUTURE', () => {
  afterEach(() => jest.useRealTimers());

  it.each(Object.keys(DATE_FIELDS) as (keyof typeof DATE_FIELDS)[])(
    'a future %s is named by its code; the English phrase stays in the message',
    (field) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-22T10:00:00Z'));
      const body = bodyOf(() => assertNotFuture('2026-08-30', field));
      expect(body.code).toBe('DATE_IN_FUTURE');
      expect(body.params).toEqual({ label: field, day: '2026-08-30' });
      expect(String(body.params?.label)).not.toMatch(ENGLISH);
      expect(body.message).toContain(DATE_FIELDS[field]);
    },
  );
});
