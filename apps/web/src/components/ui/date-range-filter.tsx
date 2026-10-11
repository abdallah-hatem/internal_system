'use client';

import { useTranslations } from 'next-intl';
import { DatePicker } from '@/components/ui/date-picker';

export interface DayRange {
  /** YYYY-MM-DD, or '' for open-ended. */
  from: string;
  to: string;
}

/**
 * A From / To pair of the shared date pickers, for filtering a list by day
 * (Sales, Payments — I1, 2026-10-11). Both ends are included, as the API reads
 * them (`common/dates.ts`, `instantRange` / `calendarRange`).
 *
 * Each picker keeps the other's end out of reach — From cannot go past To,
 * To cannot go before From — so a reversed range is not something a person can
 * pick. The server still refuses one (DATE_RANGE_REVERSED), because the form is
 * only one caller (CLAUDE.md rule 3).
 *
 * The placeholder is the field's name ("From", "To"): it is what the empty
 * field shows and what the trigger is called to a screen reader.
 */
export function DateRangeFilter({
  value,
  onChange,
  idPrefix,
}: {
  value: DayRange;
  onChange: (next: DayRange) => void;
  /** Names the two pickers (`<prefix>From`, `<prefix>To`) for tests. */
  idPrefix: string;
}) {
  const t = useTranslations('common');

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`${idPrefix}-date-range`}>
      <DatePicker
        className="w-full min-w-0 sm:w-44"
        name={`${idPrefix}From`}
        value={value.from}
        max={value.to || undefined}
        placeholder={t('dateFrom')}
        onChange={(from) => onChange({ ...value, from })}
      />
      <DatePicker
        className="w-full min-w-0 sm:w-44"
        name={`${idPrefix}To`}
        value={value.to}
        min={value.from || undefined}
        placeholder={t('dateTo')}
        onChange={(to) => onChange({ ...value, to })}
      />
      {(value.from || value.to) && (
        <button
          type="button"
          data-testid={`${idPrefix}-dates-clear`}
          onClick={() => onChange({ from: '', to: '' })}
          className="min-h-11 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted sm:min-h-0"
        >
          {t('clearDates')}
        </button>
      )}
    </div>
  );
}
