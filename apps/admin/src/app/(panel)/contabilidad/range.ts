import { mexicoCityCustomRange, mexicoCityDayRange, mexicoCityMonthRange, mexicoCityTodayYmd, mexicoCityWeekRange, type DateRange } from '@levelup/db';

/**
 * Shared by the on-screen report and its CSV export so a downloaded report
 * always matches exactly what was on screen when it was requested.
 */
export type RangeKey = 'hoy' | 'semana' | 'mes' | 'personalizado';

export const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes', label: 'Mes' },
  { value: 'personalizado', label: 'Personalizado' },
];

export function parseRangeKey(value: string | undefined): RangeKey {
  return (RANGES.find((r) => r.value === value)?.value ?? 'hoy') as RangeKey;
}

export function resolveRange(
  rango: RangeKey,
  desde: string | undefined,
  hasta: string | undefined,
): DateRange {
  const now = new Date();
  switch (rango) {
    case 'semana':
      return mexicoCityWeekRange(now);
    case 'mes':
      return mexicoCityMonthRange(now);
    case 'personalizado': {
      const start = desde || mexicoCityTodayYmd(now);
      const end = hasta || start;
      return mexicoCityCustomRange(start, end);
    }
    case 'hoy':
    default:
      return mexicoCityDayRange(now);
  }
}

// methodLabel moved to lib/format.ts — shared with the order-detail page,
// which needed the exact same gateway-aware OXXO/SPEI labeling.
export { methodLabel } from '../../../lib/format';
