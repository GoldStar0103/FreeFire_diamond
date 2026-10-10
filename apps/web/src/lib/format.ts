const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('es-MX');

/**
 * A real-world date, formatted the way a customer in Mexico would read a
 * calendar — "19 sep 2026", not a UTC day that disagrees with their own clock.
 *
 * Production runs with no `TZ` pin (confirmed: the container's own `date`
 * reads UTC), so `Intl.DateTimeFormat` with no explicit `timeZone` formats in
 * UTC there. Mexico City is UTC-6 with no DST, so anything that happened
 * between midnight and 6am UTC is still the PREVIOUS evening on a Mexico City
 * calendar — a badge earned or a season closed at, say, 2am UTC on the 30th
 * actually happened on the 29th locally, and would otherwise render the wrong
 * day. Same risk this codebase already guards against in
 * `mexico-city-time.ts`'s day-range helpers; this is that same guard for a
 * human-readable label instead of a query boundary.
 */
const DATE_LABEL = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'America/Mexico_City' });
export const dateLabel = (d: Date): string => DATE_LABEL.format(d);

/**
 * Storefront prices are whole pesos — no combo has centavos.
 *
 * `Intl`'s `es-MX` currency format renders MXN as a bare "$", indistinguishable
 * from USD to a buyer who has never seen the peso sign written any other way.
 * The client asked for it explicit, so it goes on by hand rather than reaching
 * for `currencyDisplay: 'code'`, which reorders to "MXN 185" instead of the
 * "$185 MXN" shape everyone actually expects here.
 */
export const mxn = (centavos: number): string => `${MXN.format(centavos / 100)} MXN`;
export const diamonds = (value: number): string => NUM.format(value);

/**
 * "Carlos M." -> "CM", for a testimonial avatar.
 *
 * Real customers do not hand over a photo, and inventing one would be a false
 * claim about a specific real person — the same reason a testimonial without
 * a real quote does not render at all (see packages/db's testimonials.ts).
 * Initials on a colored circle is the honest version of the same idea: a
 * face-shaped anchor for the eye that claims nothing about what anyone
 * actually looks like.
 */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return letters.slice(0, 2) || '?';
}

/**
 * Rounds a real count down to its leading significant digit — 5,312 -> 5,000,
 * 320 -> 300, 42 -> 40 — for a "+ de 5,000 clientes" marketing figure. Rounds
 * DOWN specifically so the claim is always true, never a precise headcount
 * that would go stale the next time someone checks the real page.
 */
export function roundDownSignificant(n: number): number {
  if (n < 10) return n;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  return Math.floor(n / magnitude) * magnitude;
}
