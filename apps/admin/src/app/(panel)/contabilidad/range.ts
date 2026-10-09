import {
  mexicoCityCustomRange,
  mexicoCityDayRange,
  mexicoCityMonthRange,
  mexicoCityTodayYmd,
  mexicoCityWeekRange,
  mexicoCityYesterdayRange,
  type DateRange,
  type SeasonDateRange,
} from '@levelup/db';

/**
 * Shared by the on-screen report and its CSV export so a downloaded report
 * always matches exactly what was on screen when it was requested.
 */
export type RangeKey =
  | 'hoy'
  | 'ayer'
  | 'semana'
  | 'mes'
  | 'temporada'
  | 'temporada-anterior'
  | 'personalizado';

export const RANGES: { value: RangeKey; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'ayer', label: 'Ayer' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes', label: 'Mes' },
  { value: 'temporada', label: 'Temporada actual' },
  { value: 'temporada-anterior', label: 'Temporada anterior' },
  { value: 'personalizado', label: 'Personalizado' },
];

export function parseRangeKey(value: string | undefined): RangeKey {
  return (RANGES.find((r) => r.value === value)?.value ?? 'hoy') as RangeKey;
}

/** The two season filters need a DB lookup; every other key is pure clock math. */
export interface SeasonRanges {
  current: SeasonDateRange | null;
  previous: SeasonDateRange | null;
}

export function isSeasonRange(rango: RangeKey): boolean {
  return rango === 'temporada' || rango === 'temporada-anterior';
}

/**
 * A season filter whose season does not exist yet (no season started, or no
 * previous one) falls back to the month, so the page always renders real
 * numbers rather than an empty range. The caller is expected to say so on
 * screen — see `seasonFallbackNotice`.
 */
export function resolveRange(
  rango: RangeKey,
  desde: string | undefined,
  hasta: string | undefined,
  seasons?: SeasonRanges,
): DateRange {
  const now = new Date();
  switch (rango) {
    case 'ayer':
      return mexicoCityYesterdayRange(now);
    case 'semana':
      return mexicoCityWeekRange(now);
    case 'mes':
      return mexicoCityMonthRange(now);
    case 'temporada':
    case 'temporada-anterior': {
      const season = rango === 'temporada' ? seasons?.current : seasons?.previous;
      if (!season) return mexicoCityMonthRange(now);
      return { start: season.start, end: season.end };
    }
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

/** Null when the chosen range is showing exactly what was asked for. */
export function seasonFallbackNotice(rango: RangeKey, seasons: SeasonRanges): string | null {
  if (rango === 'temporada' && !seasons.current) {
    return 'Todavía no hay ninguna temporada — mostrando el mes en curso.';
  }
  if (rango === 'temporada-anterior' && !seasons.previous) {
    return 'Todavía no hay una temporada anterior — mostrando el mes en curso.';
  }
  return null;
}

// methodLabel moved to lib/format.ts — shared with the order-detail page,
// which needed the exact same gateway-aware OXXO/SPEI labeling.
export { methodLabel } from '../../../lib/format';
