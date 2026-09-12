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
