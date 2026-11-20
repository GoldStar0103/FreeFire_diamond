/**
 * Mexico City calendar-day/week/month boundaries, expressed as UTC instants.
 *
 * The server (and Postgres) run in UTC — deliberately, see
 * scripts/server-setup.sh. But "today" for a Mexican business owner means the
 * Mexico City calendar day, not the UTC one: an order completed at 7pm Mexico
 * City (1am UTC the next day) must count for the day it actually happened on.
 * `getDashboardStats` used to derive "today" from `new Date().setHours(0,0,0,0)`
 * — the *host's* local midnight, which only ever coincidentally matched Mexico
 * City because the container happens to run UTC and nobody was checking.
 *
 * Mexico City has run a fixed UTC-6 offset with no DST since the 2022 reform,
 * so a single named constant is enough — no timezone library needed. What
 * matters is discipline: read the *civil date* via `Intl.DateTimeFormat`
 * pinned to the zone (never `Date`'s own local-clock methods), and do the
 * offset arithmetic in exactly one place.
 */

const TZ = 'America/Mexico_City';
const OFFSET_HOURS = 6;

export interface DateRange {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

function civilDate(instant: Date): { y: number; m: number; d: number } {
  // en-CA formats as YYYY-MM-DD directly — no locale string parsing needed.
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
    .format(instant)
    .split('-')
    .map(Number) as [number, number, number];
  return { y, m, d };
}

// Mexico City 00:00 on (y, m, d) is UTC (y, m, d) + OFFSET_HOURS. Date.UTC
// normalises an out-of-range day/month (e.g. d=32, or d=0), so callers below
// can add/subtract days freely and let month/year rollovers happen for free.
const utcMidnight = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d, OFFSET_HOURS, 0, 0, 0));

export function mexicoCityDayRange(instant: Date = new Date()): DateRange {
  const { y, m, d } = civilDate(instant);
  return { start: utcMidnight(y, m, d), end: utcMidnight(y, m, d + 1) };
}

/**
 * Yesterday's Mexico City civil day. `d - 1` is safe across month and year
 * boundaries for the same reason `d + 1` is in `mexicoCityDayRange`:
 * `utcMidnight` goes through `Date.UTC`, which normalises out-of-range days.
 */
export function mexicoCityYesterdayRange(instant: Date = new Date()): DateRange {
  const { y, m, d } = civilDate(instant);
  return { start: utcMidnight(y, m, d - 1), end: utcMidnight(y, m, d) };
}

/**
 * "YYYY-MM-DD" for the Mexico City civil date — for feeding `<input
 * type="date">` defaults. `new Date().toISOString()` is the UTC date, which
 * is already one day ahead of Mexico City for roughly a third of the day.
 */
export function mexicoCityTodayYmd(instant: Date = new Date()): string {
  const { y, m, d } = civilDate(instant);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Monday-start, hardcoded. This is an accounting report, not a consumer
 * calendar — a Mexican business's "semana" runs Monday–Sunday, matching
 * ISO-8601 week semantics. Not configurable in v1; nobody has asked for that.
 */
export function mexicoCityWeekRange(instant: Date = new Date()): DateRange {
  const { y, m, d } = civilDate(instant);
  // getUTCDay() here is pure calendar math on a Y-M-D triple (0 = Sunday), not
  // a clock-boundary read — a date's weekday doesn't depend on timezone, so
  // this is not the same class of bug as reading host-local Date methods.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const sinceMonday = (dow + 6) % 7;
  return {
    start: utcMidnight(y, m, d - sinceMonday),
    end: utcMidnight(y, m, d - sinceMonday + 7),
  };
}

export function mexicoCityMonthRange(instant: Date = new Date()): DateRange {
  const { y, m } = civilDate(instant);
  return { start: utcMidnight(y, m, 1), end: utcMidnight(y, m + 1, 1) };
}

/**
 * `startYmd`/`endYmdInclusive`: "YYYY-MM-DD" Mexico City calendar dates, e.g.
 * straight from an admin's `<input type="date">` — already the right civil
 * date, no `Intl` conversion needed on the way in.
 */
export function mexicoCityCustomRange(startYmd: string, endYmdInclusive: string): DateRange {
  const [sy, sm, sd] = startYmd.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = endYmdInclusive.split('-').map(Number) as [number, number, number];
  return { start: utcMidnight(sy, sm, sd), end: utcMidnight(ey, em, ed + 1) };
}

/**
 * An `<input type="datetime-local">` value ("YYYY-MM-DDTHH:mm"), read as the
 * admin's own Mexico City wall-clock time, converted to the UTC instant the
 * database actually stores. Parsing it with plain `new Date(value)` would
 * instead read it as the *server's* local time — UTC in this deployment, see
 * this file's own doc comment — silently shifting every giveaway's open/close
 * time by the 6-hour offset.
 */
export function mexicoCityDateTimeToUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min] = match.map(Number) as unknown as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, m - 1, d, h + OFFSET_HOURS, min, 0, 0));
}
