const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat('es-MX');

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
